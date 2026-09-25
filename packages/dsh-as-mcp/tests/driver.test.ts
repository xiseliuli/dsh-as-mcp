import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
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
  creates: Record<string, unknown>[]
  /** `provider/model` pairs the double's `selectModel` refuses. */
  unroutable: Set<string>
  controller: Record<string, unknown>
  query: Record<string, unknown>
} {
  const log = [...initial]
  const prompts: string[] = []
  const creates: Record<string, unknown>[] = []
  const unroutable = new Set<string>()
  let seq = log.length

  const controller = {
    // Faithful to `session.create`, which REJECTS both arguments together and
    // resolves the directory from the workspace itself. Accepting both here is
    // what let a driver that passed both fail only in production.
    create: async (request: { workspaceId?: string; cwd?: string }) => {
      if (request.workspaceId !== undefined && request.cwd !== undefined) {
        throw new Error('session.create accepts workspaceId or cwd, not both')
      }
      creates.push(request)
      return { sessionId: 'session-1' }
    },
    list: async () => ({ items: [] }),
    // These three model the real command preconditions rather than accepting
    // anything: a double that never rejects cannot show that the driver copes.
    selectModel: async (request: { provider: string; model: string }) => {
      if (unroutable.has(`${request.provider}/${request.model}`)) {
        throw new Error(`model "${request.provider}/${request.model}" is unavailable`)
      }
      return { selected: { provider: request.provider, model: request.model } }
    },
    prompt: async (request: { requestId: string; sessionId: string; content: { text?: string }[] }) => {
      const text = request.content[0]?.text ?? ''
      if (text.trim() === '') throw new Error('prompt content must not be blank')
      if (request.sessionId !== 'session-1') throw new Error(`session "${request.sessionId}" not found`)
      prompts.push(request.requestId)
      log.push(userMessage(request.requestId, text, seq))
      seq += 1
      return { accepted: true }
    },
    cancel: (request: { sessionId: string }) => {
      if (request.sessionId !== 'session-1') throw new Error(`session "${request.sessionId}" not found`)
      return { accepted: true }
    },
    inspect: async () => ({ events: log }),
  }

  return {
    log,
    prompts,
    creates,
    unroutable,
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

  it('treats the open turn as ours when our message started it', () => {
    // The shape a real session actually has. DSH opens the turn BEFORE it
    // persists the `user/message`, so `turn/start` precedes our message and there
    // is no later `turn/start` at all. An earlier version required that later
    // `turn/start`, which left `owningTurn` null, `settled` permanently false,
    // and every waiting `session_prompt` reporting `timedOut` on a turn that had
    // completed. Verified against a live session log: this is the idle-session
    // order, not an edge case.
    const events = [
      ...turn(0, 7, 'ours', 'req-1'),
    ]
    // Reorder to the real sequence: turn/start, then the committed message.
    const real = [
      event('turn/start', { turn: 7 }, 0),
      userMessage('req-1', 'go', 1),
      event('assistant/message', { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'ours' }] } }, 2),
      event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 3),
    ]
    expect(events).toHaveLength(4)
    const location = locateTurn(real, 'req-1')
    expect(location.promptIndex).toBe(1)
    expect(location.owningTurn).toBe(7)
    expect(location.settled).toBe(true)
    expect(location.from).toBe(1)

    const slice = real.slice(location.from, location.to)
    expect(slice.map((entry) => entry.type)).toEqual(['user/message', 'assistant/message', 'turn/end'])
  })

  it('stays open when our message lands mid-answer in someone else\'s turn', () => {
    // The case the previous rule was reaching for, told apart by the signal that
    // actually distinguishes it: the open turn had already produced output before
    // our message, so it is answering something else and a later turn must come.
    const events = [
      event('turn/start', { turn: 7 }, 0),
      event('assistant/message', { turn: 7, step: 0, message: { content: [{ type: 'text', text: 'foreign' }] } }, 1),
      userMessage('req-1', 'go', 2),
      event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 3),
    ]
    const location = locateTurn(events, 'req-1')
    expect(location.promptIndex).toBe(2)
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
    // A genuinely busy session: turn 7 was already mid-answer when we prompted,
    // which is what makes it foreign. That it had produced output *before* our
    // message is the signal that tells this apart from the ordinary idle shape,
    // where the open turn is the one our own message just started.
    const sessions = fakeSessions([
      event('turn/start', { turn: 7 }, 0),
      event('assistant/message', { turn: 7, step: 0, message: { content: [{ type: 'text', text: 'not ours' }] } }, 1),
    ])
    const { driver } = driverWith(sessions)

    const pending = driver.promptSession({ sessionId: 'session-1', prompt: 'ours', mode: 'queue', wait: true, timeoutMs: 3_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // The in-flight turn finishes; our queued prompt is still waiting.
    sessions.log.push(event('assistant/message', { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'still not ours' }] } }, 10))
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

describe('DshDriver.createSession', () => {
  /** A registry that knows exactly one workspace. */
  function registryWith(): Record<string, unknown> {
    return {
      get: (id: string) => (id === 'ws-1' ? { id: 'ws-1', path: '/tmp/ws-1' } : undefined),
    }
  }

  it('names the workspace without also passing its directory', async () => {
    // The harness rejects `workspaceId` and `cwd` together and resolves the
    // directory from the workspace itself, so a driver that derives `cwd` from
    // the workspace and forwards both fails every workspace-scoped call.
    const sessions = fakeSessions()
    const { driver, ctx } = driverWith(sessions)
    ctx.provide('workspaceRegistry', registryWith())

    const created = await driver.createSession({ workspaceId: 'ws-1' })

    expect(sessions.creates).toHaveLength(1)
    expect(sessions.creates[0]).toEqual({ workspaceId: 'ws-1' })
    expect(sessions.creates[0]).not.toHaveProperty('cwd')
    // The resolved directory is still useful to the caller, so it is reported.
    expect(created.cwd).toBe('/tmp/ws-1')
  })

  it('resolves a relative cwd to an absolute one', async () => {
    // The session header requires an absolute path; forwarding a relative one
    // would be accepted here and rejected by the harness later.
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)

    const created = await driver.createSession({ cwd: 'relative/dir' })

    expect(sessions.creates[0]?.cwd).toBe(resolve('relative/dir'))
    expect(created.cwd).toBe(resolve('relative/dir'))
  })

  it('reports an unusable model without losing the session it created', async () => {
    // Selection happens after creation, so throwing here would tell the caller
    // that nothing happened while a live session sat in the DSH UI. The session
    // is real and usable on its default route; the model problem is reported.
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    sessions.unroutable.add('no-such/model')

    const created = await driver.createSession({
      cwd: '/tmp',
      provider: 'no-such',
      model: 'model',
    })

    expect(created.sessionId).toBe('session-1')
    expect(created.modelSelectionError).toMatch(/unavailable/)
    expect(created.model).toBeUndefined()
  })

  it('passes a bare directory through as cwd', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)

    await driver.createSession({ cwd: '/tmp/elsewhere' })

    expect(sessions.creates[0]).toEqual({ cwd: '/tmp/elsewhere' })
    expect(sessions.creates[0]).not.toHaveProperty('workspaceId')
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
