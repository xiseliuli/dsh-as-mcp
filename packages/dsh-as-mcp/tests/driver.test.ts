import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { DshDriver, locateTurn, type TurnResult } from '../src/dsh/driver.js'
import type { DshSessionEvent } from '../src/dsh/types.js'
import { testConfig } from './harness.js'

/** A minimal durable-log entry. */
function event(type: string, data: unknown, seq: number): DshSessionEvent {
  return { type, data, seq, time: 1_700_000_000_000 + seq }
}

/** Append our prompt the way `sessionController` commits it: `source.rpcId` = requestId. */
function userMessage(requestId: string, text: string, seq: number): DshSessionEvent {
  return event(
    'user/message',
    { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: requestId } },
    seq,
  )
}

/** A complete turn in the log. */
function turn(seq: number, number_: number, reply: string, rpcId?: string): DshSessionEvent[] {
  return [
    ...(rpcId === undefined ? [] : [userMessage(rpcId, 'go', seq)]),
    event('turn/start', { turn: number_ }, seq + 1),
    event(
      'assistant/message',
      { turn: number_, step: 0, message: { content: [{ type: 'text', text: reply }] } },
      seq + 2,
    ),
    event('turn/end', { turn: number_, reason: { kind: 'completed' } }, seq + 3),
  ]
}

/** A fake harness exposing only the session services the driver reaches for. */
function fakeSessions(initial: DshSessionEvent[] = []): {
  log: DshSessionEvent[]
  prompts: string[]
  controller: Record<string, unknown>
  query: Record<string, unknown>
} {
  const log = [...initial]
  const prompts: string[] = []
  let seq = log.length

  const controller = {
    create: async () => ({ sessionId: 'session-1' }),
    list: async () => ({ items: [] }),
    selectModel: async () => ({ selected: { provider: 'p', model: 'm' } }),
    prompt: async (request: { requestId: string; content: { text?: string }[] }) => {
      prompts.push(request.requestId)
      log.push(userMessage(request.requestId, request.content[0]?.text ?? '', seq))
      seq += 1
      return { accepted: true }
    },
    cancel: () => ({ accepted: true }),
    inspect: async () => ({ events: log }),
  }

  return {
    log,
    prompts,
    controller,
    query: { readSession: async () => ({ session: {}, inheritedEventCount: 0, events: log }) },
  }
}

/** Build a driver over a fake harness. */
function driverWith(sessions: ReturnType<typeof fakeSessions>): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('sessionController', sessions.controller)
  ctx.provide('sessionQuery', sessions.query)
  return { driver: new DshDriver(ctx, () => testConfig()), ctx }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('locateTurn', () => {
  it('reports nothing when the prompt has not been committed yet', () => {
    const events = turn(0, 1, 'foreign')
    expect(locateTurn(events, 'ours')).toEqual({
      promptIndex: -1,
      from: 0,
      to: 0,
      owningTurn: null,
      settled: false,
    })
  })

  it('scopes the slice to our turn, excluding the turn before it', () => {
    const events = [...turn(0, 1, 'foreign'), ...turn(3, 2, 'ours', 'req-1')]
    const location = locateTurn(events, 'req-1')
    expect(location.promptIndex).toBe(events.findIndex((entry) => entry.type === 'user/message'))
    expect(location.owningTurn).toBe(2)
    expect(location.settled).toBe(true)

    // The invariant that matters: our slice carries our turn and nothing of the
    // unrelated turn that preceded it.
    const slice = events.slice(location.from, location.to)
    expect(slice.map((entry) => entry.type)).toEqual(['turn/start', 'assistant/message', 'turn/end'])
    expect(JSON.stringify(slice)).toContain('ours')
    expect(JSON.stringify(slice)).not.toContain('foreign')
  })

  it('stays open while our turn is still running', () => {
    const events = [userMessage('req-1', 'go', 0), event('turn/start', { turn: 1 }, 1)]
    const location = locateTurn(events, 'req-1')
    expect(location.promptIndex).toBe(0)
    expect(location.owningTurn).toBe(1)
    expect(location.settled).toBe(false)
    expect(location.to).toBe(events.length)
  })

  it('stays open when no turn has begun for our queued message', () => {
    // Exactly the queued-behind-a-running-turn shape: our message is committed,
    // an unrelated turn ends after it, and our own turn has not started.
    const events = [
      event('turn/start', { turn: 7 }, 0),
      userMessage('req-1', 'go', 1),
      event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 2),
    ]
    const location = locateTurn(events, 'req-1')
    expect(location.promptIndex).toBe(1)
    expect(location.owningTurn).toBeNull()
    expect(location.settled).toBe(false)
  })

  it('attributes a steered message to the turn that was already open', () => {
    const events = [
      event('turn/start', { turn: 7 }, 0),
      userMessage('req-1', 'also do this', 1),
      event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 2),
    ]
    const location = locateTurn(events, 'req-1', 'steer')
    expect(location.owningTurn).toBe(7)
    expect(location.settled).toBe(true)
  })

  it('picks our own prompt, not a later one from another caller', () => {
    const events = [userMessage('req-1', 'ours', 0), event('turn/start', { turn: 1 }, 1), userMessage('req-2', 'theirs', 2)]
    expect(locateTurn(events, 'req-1').promptIndex).toBe(0)
    expect(locateTurn(events, 'req-2').promptIndex).toBe(2)
  })
})

describe('DshDriver.promptSession', () => {
  it('returns the reply and tool calls of its own turn', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)

    const pending = driver.promptSession({ sessionId: 'session-1', prompt: 'do it', mode: 'queue', wait: true, timeoutMs: 5_000 })
    // Settle the turn the way the agent loop would, after the prompt lands.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const requestId = sessions.prompts[0] ?? ''
    sessions.log.push(event('turn/start', { turn: 1 }, 100))
    sessions.log.push(event('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{"path":"a"}' }, 101))
    sessions.log.push(event('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'All done.' }] } }, 102))
    sessions.log.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 103))

    const result = await pending
    expect(result.accepted).toBe(true)
    const outcome = result.turn as TurnResult
    expect(outcome.reply).toBe('All done.')
    expect(outcome.turn).toBe(1)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.aborted).toBe(false)
    expect(outcome.toolCalls).toEqual([{ name: 'read', arguments: '{"path":"a"}', callId: 'c1' }])
    expect(locateTurn(sessions.log, requestId).promptIndex).toBe(0)
  })

  it('does not mistake a turn that was already in flight for its own', async () => {
    // The regression this guards: with no per-message "await this turn" API, a
    // naive wait sees the session go idle and returns someone else's reply.
    const sessions = fakeSessions([...turn(0, 1, 'A reply from the DSH UI')])
    const { driver } = driverWith(sessions)

    const result = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'ours',
      mode: 'queue',
      wait: true,
      timeoutMs: 400,
    })

    const outcome = result.turn as TurnResult
    expect(outcome.timedOut).toBe(true)
    // Our turn never closed, so there is nothing of ours to report.
    expect(outcome.reply).toBe('')
    expect(outcome.reply).not.toContain('DSH UI')
  })

  it('ignores a foreign turn that settles while ours is queued', async () => {
    // The realistic queue shape: a turn is already running when we prompt, so
    // `turn/start 7` precedes our message and `turn/end 7` follows it. Turn 7 is
    // not ours; ours is whichever turn begins after it.
    const sessions = fakeSessions([event('turn/start', { turn: 7 }, 0)])
    const { driver } = driverWith(sessions)

    const pending = driver.promptSession({ sessionId: 'session-1', prompt: 'ours', mode: 'queue', wait: true, timeoutMs: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // The in-flight turn finishes; our queued prompt is still waiting.
    sessions.log.push(event('assistant/message', { turn: 7, step: 0, message: { content: [{ type: 'text', text: 'not ours' }] } }, 10))
    sessions.log.push(event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 11))

    let settled = false
    void pending.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(settled).toBe(false)

    sessions.log.push(event('turn/start', { turn: 8 }, 20))
    sessions.log.push(event('assistant/message', { turn: 8, step: 0, message: { content: [{ type: 'text', text: 'ours' }] } }, 21))
    sessions.log.push(event('turn/end', { turn: 8, reason: { kind: 'completed' } }, 22))

    const outcome = (await pending).turn as TurnResult
    expect(outcome.reply).toBe('ours')
    expect(outcome.turn).toBe(8)
  })

  it('marks a cancelled turn as aborted', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)

    const pending = driver.promptSession({ sessionId: 'session-1', prompt: 'ours', mode: 'queue', wait: true, timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    sessions.log.push(event('turn/start', { turn: 1 }, 100))
    sessions.log.push(event('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 101))

    const outcome = (await pending).turn as TurnResult
    expect(outcome.aborted).toBe(true)
    expect(outcome.timedOut).toBe(false)
  })

  it('runs one turn at a time per session', async () => {
    let active = 0
    let peak = 0
    const sessions = fakeSessions()
    sessions.controller.prompt = async (request: { requestId: string; content: { text?: string }[] }) => {
      active += 1
      peak = Math.max(peak, active)
      sessions.prompts.push(request.requestId)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
      return { accepted: true }
    }
    const { driver } = driverWith(sessions)

    await Promise.all([
      driver.promptSession({ sessionId: 'session-1', prompt: 'a', mode: 'queue', wait: false }),
      driver.promptSession({ sessionId: 'session-1', prompt: 'b', mode: 'queue', wait: false }),
      driver.promptSession({ sessionId: 'session-1', prompt: 'c', mode: 'queue', wait: false }),
    ])

    expect(peak).toBe(1)
    expect(sessions.prompts).toHaveLength(3)
  })

  it('returns as soon as the message is accepted when wait is false', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const result = await driver.promptSession({ sessionId: 'session-1', prompt: 'fire and forget', mode: 'queue', wait: false })
    expect(result).toEqual({ accepted: true })
    expect(sessions.prompts).toHaveLength(1)
  })
})

describe('DshDriver capability gating', () => {
  it('names the missing service instead of failing obscurely', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const driver = new DshDriver(ctx, () => testConfig())

    await expect(driver.listWorkspaces()).rejects.toThrow(/workspaceRegistry/)
    await expect(driver.createSession({ cwd: '/tmp' })).rejects.toThrow(/sessionController/)
    expect(driver.describeCapabilities()).toMatchObject({
      workspaceRegistry: false,
      sessionController: false,
      fs: false,
      shell: false,
    })
  })
})
