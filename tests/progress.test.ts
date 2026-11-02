import { afterEach, describe, expect, it } from 'vitest'

import { boot, stubDriver, testConfig } from './harness.js'
import { DshDriver, type TurnProgress } from '../src/dsh/driver.js'
import type { DshSessionController, DshSessionEvent, DshSessionQuery } from '../src/dsh/types.js'

/** One durable event. */
function event(type: string, data: unknown, seq: number): DshSessionEvent {
  return { type, data, seq, time: 1_700_000_000_000 + seq }
}

/**
 * A harness whose prompt call commits a settled turn immediately.
 *
 * The turn has one tool call, so progress has something to count, and the wait
 * settles on its first log read — which is exactly the case where a progress
 * report should also fire.
 */
function fakeHarness(): { ctx: unknown; log: DshSessionEvent[] } {
  const log: DshSessionEvent[] = []
  let seq = 0
  const append = (entry: DshSessionEvent): void => {
    log.push({ ...entry, seq })
    seq += 1
  }

  const controller = {
    create: async () => ({ sessionId: 'session-1' }),
    list: async () => ({ items: [] }),
    selectModel: async (request: { provider: string; model: string }) => ({
      selected: { provider: request.provider, model: request.model },
    }),
    prompt: async (request: { requestId: string; sessionId: string }) => {
      append(event('user/message', {
        role: 'user',
        content: [{ type: 'text', text: 'go' }],
        source: { kind: 'user', rpcId: request.requestId },
      }, seq))
      append(event('turn/start', { turn: 1 }, seq))
      append(event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, seq))
      append(event('assistant/message', {
        turn: 1,
        step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      }, seq))
      append(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, seq))
    },
    cancel: () => ({ accepted: true }),
    inspect: async () => ({ meta: { id: 'session-1' }, inheritedEventCount: 0, events: log }),
    resolveAgent: async () => ({ error: new Error('not needed') }),
  } as unknown as DshSessionController

  const query: DshSessionQuery = {
    readSession: async () => ({ session: { id: 'session-1' }, inheritedEventCount: 0, events: [...log] }),
  }

  return {
    log,
    ctx: {
      get: (name: string) => (name === 'sessionController' ? controller : name === 'sessionQuery' ? query : undefined),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    },
  }
}

describe('promptSession progress', () => {
  it('reports the settled turn with its tool-call count', async () => {
    const harness = fakeHarness()
    const driver = new DshDriver(harness.ctx, () => testConfig())
    const updates: TurnProgress[] = []

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'go',
      mode: 'queue',
      wait: true,
      onProgress: (progress) => updates.push(progress),
    })

    expect(reply.turn?.timedOut).toBe(false)
    expect(updates.length).toBeGreaterThanOrEqual(1)
    const last = updates.at(-1) as TurnProgress
    expect(last.settled).toBe(true)
    expect(last.turn).toBe(1)
    expect(last.toolCalls).toBe(1)
    expect(last.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('never fails the prompt when the progress callback throws', async () => {
    const harness = fakeHarness()
    const driver = new DshDriver(harness.ctx, () => testConfig())

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'go',
      mode: 'queue',
      wait: true,
      onProgress: () => {
        throw new Error('progress transport exploded')
      },
    })

    // A liveness ping is advisory: its failure must not lose the answer.
    expect(reply.turn?.timedOut).toBe(false)
    expect(reply.turn?.reply).toBe('done')
  })
})

describe('session_prompt progress notifications', () => {
  const stops: (() => Promise<void>)[] = []
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()))
  })

  /** POST one tools/call with an optional progress token and return the raw body. */
  async function callWithMeta(
    url: string,
    args: unknown,
    meta: Record<string, unknown> | undefined,
  ): Promise<string> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${testConfig().auth.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'session_prompt', arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
      }),
    })
    return await response.text()
  }

  it('emits notifications/progress when the client sent a progress token', async () => {
    const endpoint = await boot(stubDriver({
      promptSession: async (request) => {
        request.onProgress?.({ turn: 1, toolCalls: 2, elapsedMs: 1_500, settled: false })
        return {
          accepted: true,
          turn: {
            reply: 'ok',
            replyChars: 2,
            models: [],
            toolCalls: [],
            turn: 1,
            turnEndReason: { kind: 'completed' },
            timedOut: false,
            aborted: false,
          },
        }
      },
    }))
    stops.push(endpoint.stop)

    const body = await callWithMeta(endpoint.url, { sessionId: 'session-1', prompt: 'go' }, { progressToken: 'p-1' })

    expect(body).toContain('notifications/progress')
    expect(body).toContain('p-1')
    // The message carries the human state; `progress` is the monotonic number.
    expect(body).toContain('"progress":1.5')
    // The reply itself still arrives (its JSON is pretty-printed inside the text
    // block, so assert on content rather than exact framing).
    expect(body).toContain('reply')
    expect(body).toContain('ok')
  })

  it('sends nothing when the client asked for no progress', async () => {
    const endpoint = await boot(stubDriver({
      promptSession: async (request) => {
        request.onProgress?.({ turn: 1, toolCalls: 0, elapsedMs: 10, settled: true })
        return { accepted: true }
      },
    }))
    stops.push(endpoint.stop)

    const body = await callWithMeta(endpoint.url, { sessionId: 'session-1', prompt: 'go' }, undefined)

    expect(body).not.toContain('notifications/progress')
    expect(body).toContain('accepted')
  })
})
