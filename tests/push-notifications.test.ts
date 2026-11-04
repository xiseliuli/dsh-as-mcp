import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DshDriver } from '../src/dsh/driver.js'
import type { DshSessionEvent } from '../src/dsh/types.js'
import { EndpointPushes, turnResourceUri } from '../src/mcp/push.js'
import { boot, readJsonRpc, rpc, stubDriver, testConfig } from './harness.js'

/**
 * The server-push surface.
 *
 * `session_prompt { wait: false }` leaves a caller nothing to observe; the modern
 * protocol's `subscriptions/listen` stream is how it hears about the settlement
 * instead of polling. These tests pin the two halves that can be checked without
 * a live turn: the bus/publish plumbing, and what a client is told and can read
 * on the wire.
 */
describe('the turn-settlement resource', () => {
  it('names the session, escaping characters that would change the URI', () => {
    expect(turnResourceUri('session-1')).toBe('dsh://session/session-1/turn')
    // The template decodes one segment; an id carrying `/` or a space must not
    // turn into a different resource.
    expect(turnResourceUri('a/b c')).toBe('dsh://session/a%2Fb%20c/turn')
  })
})

describe('EndpointPushes', () => {
  function recorder(): {
    published: string[]
    notifier: {
      toolsChanged(): void
      promptsChanged(): void
      resourcesChanged(): void
      resourceUpdated(uri: string): void
    }
  } {
    const published: string[] = []
    return {
      published,
      notifier: {
        toolsChanged: () => {},
        promptsChanged: () => {},
        resourcesChanged: () => {},
        resourceUpdated: (uri: string) => {
          published.push(uri)
        },
      },
    }
  }

  it('reports a subscriber only while a listen stream is registered on the bus', () => {
    const pushes = new EndpointPushes()
    const { published, notifier } = recorder()
    pushes.attach(notifier)
    // Nothing is listening: a settlement watcher must not be armed.
    expect(pushes.hasSubscribers()).toBe(false)
    const off = pushes.eventBus.subscribe(() => {})
    expect(pushes.hasSubscribers()).toBe(true)
    pushes.turnSettled('session-1')
    expect(published).toEqual(['dsh://session/session-1/turn'])
    off()
    expect(pushes.hasSubscribers()).toBe(false)
  })

  it('is inert before the HTTP handler attaches', () => {
    // The driver is constructed before the handler exists; a prompt that settles
    // in that window must not throw.
    const pushes = new EndpointPushes()
    expect(pushes.hasSubscribers()).toBe(false)
    expect(() => {
      pushes.turnSettled('session-1')
    }).not.toThrow()
  })
})

describe('the push surface a client sees', () => {
  let url = ''
  let stop: () => Promise<void> = async () => {}

  beforeAll(async () => {
    const booted = await boot(stubDriver())
    url = booted.url
    stop = booted.stop
  })

  afterAll(async () => {
    await stop()
  })

  it('advertises resources.subscribe, which is what honors a listen filter', async () => {
    // The SDK drops `resourceSubscriptions` from the listen acknowledgement unless
    // the server advertises the capability, so a missing line here would make the
    // client subscribe to a feed that can never deliver.
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } },
    })
    const body = (await readJsonRpc(response, 1)) as {
      result?: { capabilities?: { resources?: { subscribe?: boolean } } }
    }
    expect(body.result?.capabilities?.resources?.subscribe).toBe(true)
  })

  it('registers the turn resource as a template a client can name', async () => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'resources/templates/list', params: {} })
    const body = (await readJsonRpc(response, 2)) as {
      result?: { resourceTemplates?: { uriTemplate?: string; name?: string }[] }
    }
    const templates = body.result?.resourceTemplates ?? []
    expect(templates.map((template) => template.uriTemplate)).toContain('dsh://session/{sessionId}/turn')
  })

  it('reads one session turn as the same payload session_status returns', async () => {
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: 'dsh://session/session-1/turn' },
    })
    const body = (await readJsonRpc(response, 3)) as {
      result?: { contents?: { uri?: string; mimeType?: string; text?: string }[] }
    }
    const content = body.result?.contents?.[0]
    expect(content?.mimeType).toBe('application/json')
    expect(JSON.parse(content?.text ?? '{}')).toMatchObject({
      sessionId: 'session-1',
      running: false,
      failure: null,
    })
  })

  it('tells a first-time client to subscribe before prompting', async () => {
    // The one thing a client cannot discover from tool schemas is the ordering:
    // a stream opened after the prompt may miss the event. Pin it where clients
    // actually read it.
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } },
    })
    const body = (await readJsonRpc(response, 4)) as { result?: { instructions?: string } }
    const instructions = body.result?.instructions ?? ''
    expect(instructions).toContain('subscriptions/listen')
    expect(instructions).toContain('dsh://session/<sessionId>/turn')
    expect(instructions).toContain('BEFORE')
    expect(instructions).toContain('2025-era client')
  })
})

describe('settlement pushes for a fire-and-forget prompt', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  })

  function event(type: string, data: unknown, seq: number): DshSessionEvent {
    return { type, data, seq, time: 1_700_000_000_000 + seq }
  }

  /** A session log the driver can read, plus the request ids it admitted. */
  function fakeSessions(): {
    ctx: Context
    log: DshSessionEvent[]
    requestIds: string[]
  } {
    const log: DshSessionEvent[] = []
    const requestIds: string[] = []
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionController', {
      prompt: async (request: { requestId: string; sessionId: string; content: { text?: string }[] }) => {
        requestIds.push(request.requestId)
        log.push(event('user/message', {
          id: 'm-0',
          role: 'user',
          content: [{ type: 'text', text: request.content[0]?.text ?? '' }],
          source: { kind: 'user', rpcId: request.requestId },
        }, log.length))
        return { accepted: true }
      },
      cancel: async () => ({ accepted: true }),
      inspect: async () => ({ events: log }),
    })
    ctx.provide('sessionQuery', {
      readSession: async () => ({ session: {}, inheritedEventCount: 0, events: log }),
    })
    return { ctx, log, requestIds }
  }

  function driverFor(ctx: Context, pushes: { hasSubscribers(): boolean; turnSettled(id: string): void }): DshDriver {
    const base = testConfig()
    // A wait that would otherwise poll for a second must outlast the test's own
    // turn append; `promptTimeoutMs` is the watcher's only bound.
    const config = { ...base, session: { ...base.session, promptTimeoutMs: 5_000 } }
    return new DshDriver(ctx, () => config, pushes)
  }

  async function until(ready: () => boolean, timeoutMs: number): Promise<void> {
    const started = Date.now()
    while (!ready()) {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the settlement push')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it('publishes the session turn resource once the watched turn settles', async () => {
    const { ctx, log } = fakeSessions()
    const settled: string[] = []
    const gate = vi.fn(() => true)
    const driver = driverFor(ctx, {
      hasSubscribers: gate,
      turnSettled: (sessionId: string) => {
        settled.push(sessionId)
      },
    })

    const reply = await driver.promptSession({ sessionId: 'session-1', prompt: 'go', mode: 'queue', wait: false })
    expect(reply.accepted).toBe(true)
    // A fire-and-forget call returns before the turn exists; the watch is what
    // notices it settle.
    const base = log.length
    log.push(event('turn/start', { turn: 1 }, base))
    log.push(event('assistant/message', {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'text', text: 'done' }] },
    }, base + 1))
    log.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, base + 2))

    await until(() => settled.length === 1, 6_000)
    expect(settled).toEqual(['session-1'])
    expect(gate).toHaveBeenCalled()
  })

  it('arms no watch when no subscription stream is open', async () => {
    const { ctx, log } = fakeSessions()
    const settled: string[] = []
    const gate = vi.fn(() => false)
    const driver = driverFor(ctx, {
      hasSubscribers: gate,
      turnSettled: (sessionId: string) => {
        settled.push(sessionId)
      },
    })

    await driver.promptSession({ sessionId: 'session-1', prompt: 'go', mode: 'queue', wait: false })
    const base = log.length
    log.push(event('turn/start', { turn: 1 }, base))
    log.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, base + 1))

    // A fire-and-forget caller with no listener must not cost a log read per
    // second: the gate was consulted and nothing was armed.
    expect(gate).toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(settled).toEqual([])
  })
})
