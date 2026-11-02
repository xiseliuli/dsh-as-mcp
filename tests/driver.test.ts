import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative as relativeTo } from 'node:path'
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
    cancel: async (request: { sessionId: string }) => {
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
function driverWith(
  sessions: ReturnType<typeof fakeSessions>,
  config: Partial<Parameters<typeof testConfig>[0]> = {},
): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('sessionController', sessions.controller)
  ctx.provide('sessionQuery', sessions.query)
  return { driver: new DshDriver(ctx, () => testConfig(config)), ctx }
}

/** Scratch directories removed after each test. */
const scratch: string[] = []

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
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

describe('DshDriver.updateQueue', () => {
  function withQueue(
    updateQueue?: (request: unknown) => Promise<{ accepted: true }>,
  ): DshDriver {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionController', {
      create: async () => ({ sessionId: 's' }),
      list: async () => ({ items: [] }),
      prompt: async () => ({ accepted: true }),
      cancel: async () => ({ accepted: true }),
      inspect: async () => ({ events: [] }),
      ...(updateQueue === undefined ? {} : { updateQueue }),
    } as never)
    return new DshDriver(ctx, () => testConfig())
  }

  it('forwards remove with the message id and reports what it did', async () => {
    const seen: unknown[] = []
    const driver = withQueue(async (request) => {
      seen.push(request)
      return { accepted: true }
    })
    await expect(driver.updateQueue({ sessionId: 's1', messageId: 'm1', action: 'remove' }))
      .resolves.toEqual({ accepted: true, action: 'remove' })
    expect(seen).toEqual([{ sessionId: 's1', itemId: 'm1', action: { kind: 'remove' } }])
  })

  it('wraps edit text as a text block and refuses an empty replacement', async () => {
    const seen: unknown[] = []
    const driver = withQueue(async (request) => {
      seen.push(request)
      return { accepted: true }
    })
    await expect(driver.updateQueue({ sessionId: 's1', messageId: 'm1', action: 'edit', content: 'new text' }))
      .resolves.toEqual({ accepted: true, action: 'edit' })
    expect(seen).toEqual([{
      sessionId: 's1',
      itemId: 'm1',
      action: { kind: 'edit', content: [{ type: 'text', text: 'new text' }] },
    }])
    await expect(driver.updateQueue({ sessionId: 's1', messageId: 'm1', action: 'edit', content: '  ' }))
      .rejects.toThrow(/non-empty content/)
  })

  it('names the missing capability when the controller cannot mutate a queue', async () => {
    await expect(withQueue().updateQueue({ sessionId: 's', messageId: 'm', action: 'steer' }))
      .rejects.toThrow(/no sessionController.updateQueue/)
  })
})

describe('session.scope: owned', () => {
  function scoped(sessions: ReturnType<typeof fakeSessions>, scope: 'all' | 'owned'): DshDriver {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionController', sessions.controller)
    ctx.provide('sessionQuery', sessions.query)
    return new DshDriver(ctx, () => ({
      ...testConfig(),
      session: { ...testConfig().session, scope },
    }))
  }

  it('refuses a session it did not create, naming the setting', async () => {
    const sessions = fakeSessions([userMessage('req-1', 'hi', 0)])
    const driver = scoped(sessions, 'owned')
    await expect(driver.readTranscript('session-1', 10))
      .rejects.toThrow(/session\.scope is "owned"/)
    await expect(driver.promptSession({
      sessionId: 'session-1', prompt: 'x', mode: 'queue', wait: false,
    })).rejects.toThrow(/session\.scope is "owned"/)
    await expect(driver.sessionUsage({ sessionId: 'session-1', limit: 10 }))
      .rejects.toThrow(/session\.scope is "owned"/)
  })

  it('allows a session it created and forked', async () => {
    const sessions = fakeSessions([userMessage('req-1', 'hi', 0)])
    const driver = scoped(sessions, 'owned')
    const created = await driver.createSession({ cwd: '/tmp' })
    expect(created.sessionId).toBe('session-1')
    await expect(driver.readTranscript('session-1', 10)).resolves.toBeDefined()
    expect(driver.ownsSession('session-1')).toBe(true)
  })

  it('lists only owned sessions', async () => {
    const sessions = fakeSessions()
    sessions.controller.list = async () => ({
      items: [
        { sessionId: 'session-1', cwd: '/tmp', running: false, blank: false, updatedAt: 2 },
        { sessionId: 'session-user', cwd: '/tmp', running: false, blank: false, updatedAt: 1 },
      ],
    })
    const driver = scoped(sessions, 'owned')
    await driver.createSession({ cwd: '/tmp' })
    const listed = await driver.listSessions(10)
    expect(listed.sessions.map((entry) => entry.sessionId)).toEqual(['session-1'])
    expect(listed.total).toBe(1)
  })

  it('filters search matches and reports how many it hid', async () => {
    const sessions = fakeSessions()
    ;(sessions.controller as Record<string, unknown>).search = async () => ({
      items: [
        { sessionId: 'session-1', snippet: 'mine' },
        { sessionId: 'session-user', snippet: 'theirs' },
      ],
      hasMore: false,
    })
    const driver = scoped(sessions, 'owned')
    await driver.createSession({ cwd: '/tmp' })
    const result = await driver.searchSessions({ query: 'x' })
    expect(result.items.map((item) => item.sessionId)).toEqual(['session-1'])
    expect(result.hidden).toBe(1)
  })

  it('remembers owned sessions across driver instances through DSH_HOME', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-driver-home-'))
    scratch.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const sessions = fakeSessions([userMessage('req-1', 'hi', 0)])
      const first = scoped(sessions, 'owned')
      const created = await first.createSession({ cwd: '/tmp' })
      expect(created.sessionId).toBe('session-1')

      // A fresh driver is what a plugin reload looks like: nothing in memory.
      const second = scoped(sessions, 'owned')
      await expect(second.readTranscript('session-1', 10)).resolves.toBeDefined()
      expect(second.ownsSession('session-1')).toBe(true)

      // A session nobody created is still refused.
      await expect(second.readTranscript('session-not-ours', 10))
        .rejects.toThrow(/session\.scope is "owned"/)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('lets a subagent session below an owned session be read, and refuses the rest', async () => {
    const sessions = fakeSessions([
      userMessage('req-1', 'parent said hi', 0),
      userMessage('req-2', 'child said hi', 1),
      userMessage('req-3', 'stranger said hi', 2),
    ])
    sessions.controller.list = async () => ({
      items: [
        { sessionId: 'session-1', cwd: '/tmp', running: false, blank: false, updatedAt: 3 },
        { sessionId: 'session-child', cwd: '/tmp', running: false, blank: false, updatedAt: 2, parentSessionId: 'session-1', origin: 'subagent' },
        { sessionId: 'session-stranger', cwd: '/tmp', running: false, blank: false, updatedAt: 1 },
      ],
    })
    const driver = scoped(sessions, 'owned')
    await driver.createSession({ cwd: '/tmp' })
    // The subagent session is part of the owned tree: its transcript is the cost
    // of the owned session, so reading it is allowed.
    await expect(driver.readTranscript('session-child', 10)).resolves.toBeDefined()
    await expect(driver.sessionUsage({ sessionId: 'session-child', limit: 5 }))
      .resolves.toMatchObject({ scope: 'session' })
    // A session outside the tree is still refused by every by-id entry point.
    await expect(driver.readTranscript('session-stranger', 10))
      .rejects.toThrow(/session\.scope is "owned"/)
    await expect(driver.promptSession({
      sessionId: 'session-stranger', prompt: 'x', mode: 'queue', wait: false,
    })).rejects.toThrow(/session\.scope is "owned"/)
    // Listing shows the whole tree, not just the directly-created session.
    const listed = await driver.listSessions(10)
    expect(listed.sessions.map((entry) => entry.sessionId).sort()).toEqual(['session-1', 'session-child'])
    expect(listed.total).toBe(2)
  })

  it('keeps the historical reach under scope all', async () => {
    const sessions = fakeSessions([userMessage('req-1', 'hi', 0)])
    const driver = scoped(sessions, 'all')
    await expect(driver.readTranscript('session-1', 10)).resolves.toBeDefined()
  })
})

describe('DshDriver.readQueue', () => {
  it('lists pending inbox rows with the ids queue mutations address', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionQuery', {
      observeSession: async () => ({
        header: { id: 's1', cwd: '/tmp' },
        inheritedEventCount: 0,
        events: [],
        projections: {
          asOfSeq: 3,
          values: {
            inbox: {
              'next-turn': [
                {
                  id: 'm-1',
                  content: [
                    { type: 'text', text: 'second task' },
                    { type: 'image', mediaType: 'image/png', data: 'AAA' },
                  ],
                  source: { kind: 'user', rpcId: 'r1' },
                },
              ],
            },
          },
        },
        [Symbol.dispose]: () => undefined,
      }),
    } as never)
    const driver = new DshDriver(ctx, () => testConfig())
    await expect(driver.readQueue('s1')).resolves.toEqual({
      queued: [{ id: 'm-1', text: 'second task', images: 1, source: 'user' }],
    })
  })

  it('explains that the queue is unreadable rather than reporting it empty', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionQuery', { readSession: async () => ({ session: { id: 's' }, inheritedEventCount: 0, events: [] }) } as never)
    const driver = new DshDriver(ctx, () => testConfig())
    const queue = await driver.readQueue('s')
    expect(queue.queued).toEqual([])
    expect(queue.note).toMatch(/observeSession/)
  })
})

describe('DshDriver.searchSessions', () => {
  function searchable(
    result: { items: { sessionId: string; snippet: string }[]; hasMore: boolean },
    summaries: { sessionId: string; cwd?: string; updatedAt?: number; running?: boolean }[] = [],
    listFails = false,
  ): DshDriver {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionController', {
      create: async () => ({ sessionId: 's' }),
      list: async () => {
        if (listFails) throw new Error('session listing unavailable')
        return { items: summaries }
      },
      prompt: async () => ({ accepted: true }),
      cancel: async () => ({ accepted: true }),
      inspect: async () => ({ events: [] }),
      search: async (request: { query: string }) => {
        if (request.query.trim() === '') throw new Error('empty query reached the harness')
        return result
      },
    } as never)
    return new DshDriver(ctx, () => testConfig())
  }

  it('passes the harness matches and hasMore through, enriched from the listing', async () => {
    const driver = searchable(
      { items: [{ sessionId: 'a', snippet: '…needle…' }], hasMore: true },
      [{ sessionId: 'a', cwd: '/tmp/project', updatedAt: 42, running: true }],
    )
    await expect(driver.searchSessions({ query: 'needle' })).resolves.toEqual({
      items: [{ sessionId: 'a', snippet: '…needle…', cwd: '/tmp/project', updatedAt: 42, running: true }],
      hasMore: true,
    })
  })

  it('still returns the matches when the listing for context fails', async () => {
    const driver = searchable(
      { items: [{ sessionId: 'a', snippet: 'hit' }], hasMore: false },
      [],
      true,
    )
    await expect(driver.searchSessions({ query: 'hit' }))
      .resolves.toEqual({ items: [{ sessionId: 'a', snippet: 'hit' }], hasMore: false })
  })

  it('applies a caller limit and reports that it cut', async () => {
    const driver = searchable({
      items: [
        { sessionId: 'a', snippet: 'one' },
        { sessionId: 'b', snippet: 'two' },
      ],
      hasMore: false,
    })
    await expect(driver.searchSessions({ query: 'x', limit: 1 }))
      .resolves.toEqual({ items: [{ sessionId: 'a', snippet: 'one' }], hasMore: true })
  })

  it('refuses an empty query instead of sending it to the harness', async () => {
    await expect(searchable({ items: [], hasMore: false }).searchSessions({ query: '   ' }))
      .rejects.toThrow(/must not be empty/)
  })

  it('probes whether search really works instead of trusting the method', async () => {
    const available = searchable({ items: [], hasMore: false })
    await expect(available.probeSessionSearch()).resolves.toEqual({ available: true, matches: 0 })

    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionController', {
      create: async () => ({ sessionId: 's' }),
      list: async () => ({ items: [] }),
      prompt: async () => ({ accepted: true }),
      cancel: async () => ({ accepted: true }),
      inspect: async () => ({ events: [] }),
      search: async () => {
        throw new Error('session search is disabled: openAt "never"')
      },
    } as never)
    const disabled = new DshDriver(ctx, () => testConfig())
    const probe = await disabled.probeSessionSearch()
    expect(probe.available).toBe(false)
    expect(probe.reason).toMatch(/openAt "never"/)
  })

  it('turns the disabled-index failure into operator guidance', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionController', {
      create: async () => ({ sessionId: 's' }),
      list: async () => ({ items: [] }),
      prompt: async () => ({ accepted: true }),
      cancel: async () => ({ accepted: true }),
      inspect: async () => ({ events: [] }),
      search: async () => {
        throw new Error('SessionQueryError: session search is disabled: this deployment configures the session-query index with openAt "never"')
      },
    } as never)
    const driver = new DshDriver(ctx, () => testConfig())
    await expect(driver.searchSessions({ query: 'x' }))
      .rejects.toThrow(/openAt "never"/)
    await expect(driver.searchSessions({ query: 'x' }))
      .rejects.toThrow(/first-search/)
  })

  it('names the missing capability when the controller cannot search', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionController', {
      create: async () => ({ sessionId: 's' }),
      list: async () => ({ items: [] }),
      prompt: async () => ({ accepted: true }),
      cancel: async () => ({ accepted: true }),
      inspect: async () => ({ events: [] }),
    } as never)
    const driver = new DshDriver(ctx, () => testConfig())
    await expect(driver.searchSessions({ query: 'x' }))
      .rejects.toThrow(/no sessionController.search/)
  })
})

describe('per-session serialization', () => {
  it('does not submit a second prompt on one session until the first wait settles', async () => {
    // Two callers on one session must not interleave: the second prompt waits for
    // the first wait to finish before it is even submitted, so nobody can disagree
    // about which reply belongs to which message.
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)

    const first = driver.promptSession({
      sessionId: 'session-1',
      prompt: 'first',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const second = driver.promptSession({
      sessionId: 'session-1',
      prompt: 'second',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(sessions.prompts).toHaveLength(1)

    sessions.log.push(event('turn/start', { turn: 1 }, 2))
    sessions.log.push(event('assistant/message', {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'text', text: 'first reply' }] },
    }, 3))
    sessions.log.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4))

    const firstResult = await first
    expect(firstResult.turn?.reply).toBe('first reply')

    // The second prompt is submitted only now.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(sessions.prompts).toHaveLength(2)

    sessions.log.push(event('turn/start', { turn: 2 }, 5))
    sessions.log.push(event('assistant/message', {
      turn: 2,
      step: 0,
      message: { content: [{ type: 'text', text: 'second reply' }] },
    }, 6))
    sessions.log.push(event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 7))

    const secondResult = await second
    expect(secondResult.turn?.reply).toBe('second reply')
    expect(secondResult.turn?.turn).toBe(2)
  })
})

describe('bounded replies', () => {
  it('cuts each transcript message to the requested cap and reports the original size', async () => {
    const sessions = fakeSessions()
    sessions.log.push(userMessage('req-1', 'x'.repeat(500), 0))
    sessions.log.push(event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'short' }] } }, 1))
    const { driver } = driverWith(sessions)

    const read = await driver.readTranscript('session-1', 10, { maxCharsPerMessage: 100 })
    const long = read.messages[0] as { text: string; chars: number; truncated?: boolean }
    expect(long.text).toHaveLength(100)
    expect(long.chars).toBe(500)
    expect(long.truncated).toBe(true)
    // An uncapped read keeps the historical full-fidelity shape.
    const full = await driver.readTranscript('session-1', 10)
    expect(full.messages[0]?.text).toHaveLength(500)
    expect(full.messages[0]?.truncated).toBeUndefined()
    expect(full.messages[0]?.chars).toBe(500)
  })

  it('reports how many messages the tail window left out', async () => {
    const sessions = fakeSessions()
    for (let index = 0; index < 5; index += 1) {
      sessions.log.push(userMessage(`req-${index}`, `message ${index}`, index))
    }
    const { driver } = driverWith(sessions)

    // The window keeps the newest two; `total` must still count all five.
    const window = await driver.readTranscript('session-1', 2)
    expect(window.messages.map((message) => message.text)).toEqual(['message 3', 'message 4'])
    expect(window.total).toBe(5)

    // Filters count too: only user messages exist here, so role=assistant is 0.
    const none = await driver.readTranscript('session-1', 10, { role: 'assistant' })
    expect(none.total).toBe(0)
  })

  it('reports the tool calls a model requested only when asked', async () => {
    const sessions = fakeSessions()
    sessions.log.push(userMessage('req-1', 'run it', 0))
    sessions.log.push(event('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        content: [
          { type: 'text', text: 'running' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"echo hi"}' },
          { type: 'tool-call', id: 'call-2', name: 'read', arguments: '{}' },
        ],
      },
    }, 1))
    const { driver } = driverWith(sessions)

    const plain = await driver.readTranscript('session-1', 10)
    expect(plain.messages.find((message) => message.role === 'assistant')?.toolCalls).toBeUndefined()

    const withCalls = await driver.readTranscript('session-1', 10, { includeToolCalls: true })
    const assistant = withCalls.messages.find((message) => message.role === 'assistant')
    expect(assistant?.toolCalls).toEqual([
      { id: 'call-1', name: 'bash', argumentsChars: 21 },
      { id: 'call-2', name: 'read', argumentsChars: 2 },
    ])
    // A user message never carries model tool calls.
    expect(withCalls.messages.find((message) => message.role === 'user')?.toolCalls).toBeUndefined()
  })

  it('attaches the recorded result size and error flag to each tool call', async () => {
    const sessions = fakeSessions()
    sessions.log.push(userMessage('req-1', 'run it', 0))
    sessions.log.push(event('assistant/message', {
      turn: 1,
      step: 0,
      message: {
        content: [
          { type: 'tool-call', id: 'call-ok', name: 'bash', arguments: '{}' },
          { type: 'tool-call', id: 'call-err', name: 'read', arguments: '{}' },
          { type: 'tool-call', id: 'call-pending', name: 'grep', arguments: '{}' },
        ],
      },
    }, 1))
    sessions.log.push(event('tool/result', {
      turn: 1,
      step: 0,
      message: { role: 'tool', toolCallId: 'call-ok', content: [{ type: 'text', text: 'hello' }] },
    }, 2))
    sessions.log.push(event('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'call-err', content: [{ type: 'text', text: 'nope' }], isError: true },
    }, 3))
    const { driver } = driverWith(sessions)

    const read = await driver.readTranscript('session-1', 10, { includeToolCalls: true })
    const calls = read.messages.find((message) => message.role === 'assistant')?.toolCalls ?? []
    expect(calls).toEqual([
      { id: 'call-ok', name: 'bash', argumentsChars: 2, resultChars: 5 },
      { id: 'call-err', name: 'read', argumentsChars: 2, resultChars: 4, error: true },
      // Still running when read: no result fields at all.
      { id: 'call-pending', name: 'grep', argumentsChars: 2 },
    ])
  })

  it('keeps a tool-call-only assistant message when calls were asked for', async () => {
    const sessions = fakeSessions()
    sessions.log.push(userMessage('req-1', 'run it', 0))
    sessions.log.push(event('assistant/message', {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }] },
    }, 1))
    const { driver } = driverWith(sessions)

    // Without the option this message has no text, so the historical transcript
    // omits it entirely.
    const plain = await driver.readTranscript('session-1', 10)
    expect(plain.messages.map((message) => message.role)).toEqual(['user'])

    const withCalls = await driver.readTranscript('session-1', 10, { includeToolCalls: true })
    const assistant = withCalls.messages.find((message) => message.role === 'assistant')
    expect(assistant?.text).toBe('')
    expect(assistant?.toolCalls).toEqual([{ id: 'call-1', name: 'bash', argumentsChars: 16 }])
  })

  it('pages backwards with beforeSeq so a long transcript is reachable', async () => {
    const sessions = fakeSessions()
    for (let index = 0; index < 5; index += 1) {
      sessions.log.push(userMessage(`req-${index}`, `message ${index}`, index))
    }
    const { driver } = driverWith(sessions)

    const newest = await driver.readTranscript('session-1', 2)
    expect(newest.messages.map((message) => message.text)).toEqual(['message 3', 'message 4'])
    // The id that queue mutations address travels with each message.
    expect(newest.messages[0]?.id).toMatch(/^m-/)
    expect(newest.messages[0]?.id).not.toBe(newest.messages[1]?.id)

    // Page from the oldest seq already held; the tail of that window comes back.
    const older = await driver.readTranscript('session-1', 2, { beforeSeq: newest.messages[0]?.seq })
    expect(older.messages.map((message) => message.text)).toEqual(['message 1', 'message 2'])
    expect(older.total).toBe(3)
    const oldest = await driver.readTranscript('session-1', 2, { beforeSeq: older.messages[0]?.seq })
    expect(oldest.messages.map((message) => message.text)).toEqual(['message 0'])
    // A beforeSeq at or below the first event pages past the start.
    const past = await driver.readTranscript('session-1', 2, { beforeSeq: 0 })
    expect(past.messages).toEqual([])
    expect(past.total).toBe(0)
  })

  it('cuts the agent reply to maxReplyChars and says it did', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const pending = driver.promptSession({
      sessionId: 'session-1',
      prompt: 'go',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
      maxReplyChars: 100,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    sessions.log.push(event('turn/start', { turn: 1 }, 100))
    sessions.log.push(event('assistant/message', {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'text', text: 'y'.repeat(500) }] },
    }, 101))
    sessions.log.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102))

    const result = await pending
    expect(result.turn?.reply).toHaveLength(100)
    expect(result.turn?.replyChars).toBe(500)
    expect(result.turn?.replyTruncated).toBe(true)
    // A capped reply is still a settled turn: its usage is not partial.
    expect(result.session?.usage?.partial).toBeUndefined()
  })

  it('marks the session usage partial when the wait is aborted', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions, { usage: true })
    const controller = new AbortController()
    const pending = driver.promptSession({
      sessionId: 'session-1',
      prompt: 'go',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    const result = await pending
    expect(result.turn?.aborted).toBe(true)
    // The snapshot was taken while the turn was still open, so its totals will
    // grow; that fact must be visible on the reply's own usage block.
    expect(result.session?.usage?.partial).toBe(true)
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
    // Arguments are omitted by default: the size is the useful fact, and an agent's
    // file_write arguments are the whole file.
    expect(outcome.toolCalls).toEqual([{ name: 'read', callId: 'c1', argumentsBytes: 12 }])
    expect(locateTurn(sessions.log, requestId).promptIndex).toBe(0)
  })

  /** Start a prompt and settle its turn with one tool call whose arguments are given. */
  async function promptWithToolCall(
    driver: DshDriver,
    sessions: ReturnType<typeof fakeSessions>,
    args: string,
    options: { toolCalls?: 'summary' | 'full' | 'none'; maxArgumentChars?: number } = {},
  ): Promise<TurnResult> {
    const pending = driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
      ...options,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    sessions.log.push(event('turn/start', { turn: 1 }, 100))
    sessions.log.push(event('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'write', arguments: args }, 101))
    sessions.log.push(event('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'ok' }] } }, 102))
    sessions.log.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 103))
    const result = await pending
    return result.turn as TurnResult
  }

  it('returns arguments when asked, and truncates them at the requested length', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const seen = await promptWithToolCall(driver, sessions, 'x'.repeat(500), {
      toolCalls: 'full',
      maxArgumentChars: 120,
    })
    expect(seen.toolCalls[0]).toMatchObject({
      name: 'write',
      callId: 'c1',
      argumentsBytes: 500,
      truncated: true,
    })
    expect(seen.toolCalls[0]?.arguments).toHaveLength(120)
  })

  it('reports the whole argument string when it fits', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const seen = await promptWithToolCall(driver, sessions, '{"path":"a"}', { toolCalls: 'full' })
    expect(seen.toolCalls[0]).toEqual({
      name: 'write',
      callId: 'c1',
      argumentsBytes: 12,
      arguments: '{"path":"a"}',
    })
    expect(seen.toolCalls[0]?.truncated).toBeUndefined()
  })

  it('drops the tool call list entirely when told to', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const seen = await promptWithToolCall(driver, sessions, '{"path":"a"}', { toolCalls: 'none' })
    expect(seen.toolCalls).toEqual([])
    // The reply itself is unaffected.
    expect(seen.reply).toBe('ok')
  })

  it('does not gate prompting or scoped usage on this process having created the session', async () => {
    // A caller that knows an id must be able to continue the work and read its
    // bill under session.scope "all"; ownership only decides the unscoped default.
    // A fresh DSH_HOME models a process that has never created this session: the
    // durable ownership record is read from there, so an empty one proves the
    // point without depending on test order.
    const home = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-restart-'))
    scratch.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const sessions = fakeSessions()
      const { driver } = driverWith(sessions)
      expect(driver.ownsSession('session-1')).toBe(false)

      const pending = driver.promptSession({
        sessionId: 'session-1',
        prompt: 'go',
        mode: 'queue',
        wait: false,
        timeoutMs: 1_000,
      })
      await expect(pending).resolves.toMatchObject({ accepted: true })
      await expect(driver.sessionUsage({ sessionId: 'session-1', limit: 5 }))
        .resolves.toMatchObject({ scope: 'session' })
      expect(sessions.prompts.length).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('reports which model routes answered the turn', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const pending = driver.promptSession({
      sessionId: 'session-1',
      prompt: 'go',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    sessions.log.push(event('turn/start', { turn: 1 }, 100))
    sessions.log.push(event('assistant/message', {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'text', text: 'first' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } },
    }, 101))
    sessions.log.push(event('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'second' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } },
    }, 102))
    sessions.log.push(event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, 103))
    sessions.log.push(event('assistant/message', {
      turn: 1,
      step: 2,
      message: { content: [{ type: 'text', text: 'third' }], source: { kind: 'model', provider: 'other', model: 'pro' } },
    }, 104))
    sessions.log.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 105))

    const result = await pending
    // Unique routes in first-seen order: the same route twice is one entry.
    expect(result.turn?.models).toEqual(['deepseek/deepseek-flash', 'other/pro'])
  })

  it('returns the admitted turn for a retried idempotency key instead of sending twice', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)

    const first = driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it',
      idempotencyKey: 'retry-1',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    sessions.log.push(event('turn/start', { turn: 1 }, 100))
    sessions.log.push(event('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'done once' }] } }, 101))
    sessions.log.push(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102))
    const original = await first
    expect(original.turn?.reply).toBe('done once')
    expect(original.replayed).toBeUndefined()

    // The caller retries after its own timeout: no second admission, same answer.
    const retry = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it',
      idempotencyKey: 'retry-1',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })
    expect(sessions.prompts).toHaveLength(1)
    expect(retry.replayed).toBe(true)
    expect(retry.turn?.reply).toBe('done once')
  })

  it('replays a queued message without waiting when wait is false', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const first = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it later',
      idempotencyKey: 'queued-1',
      mode: 'queue',
      wait: false,
    })
    expect(first.replayed).toBeUndefined()
    expect(sessions.prompts).toHaveLength(1)

    const retry = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it later',
      idempotencyKey: 'queued-1',
      mode: 'queue',
      wait: false,
    })
    expect(sessions.prompts).toHaveLength(1)
    expect(retry.replayed).toBe(true)
  })

  it('refuses a key reused for different content', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'the original task',
      idempotencyKey: 'reused',
      mode: 'queue',
      wait: false,
    })
    await expect(driver.promptSession({
      sessionId: 'session-1',
      prompt: 'a different task',
      idempotencyKey: 'reused',
      mode: 'queue',
      wait: false,
    })).rejects.toThrow(/idempotencyKey was reused for different content/)
    expect(sessions.prompts).toHaveLength(1)
  })

  it('refuses a key the session log cannot carry', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    await expect(driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it',
      idempotencyKey: 'has spaces and / slashes',
      mode: 'queue',
      wait: false,
    })).rejects.toThrow(/idempotencyKey may contain only letters, digits/)
    expect(sessions.prompts).toHaveLength(0)
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
    // would be accepted here and rejected by the harness later. The directory is
    // also canonicalised, so the sandbox root is the directory that exists rather
    // than the name it was reached by.
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-cwd-'))
    scratch.push(directory)
    const relative = relativeTo(process.cwd(), directory)

    const created = await driver.createSession({ cwd: relative })

    expect(sessions.creates[0]?.cwd).toBe(realpathSync(directory))
    expect(created.cwd).toBe(realpathSync(directory))
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
    // The message must say what was asked for and how to find a valid value,
    // rather than forwarding only the harness's context-free sentence.
    expect(created.modelSelectionError).toMatch(/requested provider "no-such" model "model"/)
    expect(created.modelSelectionError).toMatch(/this profile lists no provider routes/)
    expect(created.modelSelectionError).toMatch(/includeModels: true/)
    expect(created.model).toBeUndefined()
  })

  it('passes a bare directory through as cwd', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-cwd-'))
    scratch.push(directory)

    await driver.createSession({ cwd: directory })

    expect(sessions.creates[0]).toEqual({ cwd: realpathSync(directory) })
    expect(sessions.creates[0]).not.toHaveProperty('workspaceId')
  })

  it('refuses a session directory that does not exist', async () => {
    // A `cwd` becomes the session's `workspaceRoot` — the sandbox's containment
    // boundary for everything the agent then does. Accepting a path that is not
    // there would defer the failure to the middle of a turn, where it reads as an
    // agent problem rather than a bad argument.
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const absent = join(tmpdir(), `dsh-as-mcp-absent-${Date.now()}`)

    await expect(driver.createSession({ cwd: absent })).rejects.toThrow(/does not exist/)
    expect(sessions.creates).toHaveLength(0)
  })

  it('refuses a session directory that is a file', async () => {
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const file = join(mkdtempSync(join(tmpdir(), 'dsh-as-mcp-cwd-')), 'a-file')
    scratch.push(dirname(file))
    writeFileSync(file, 'x')

    await expect(driver.createSession({ cwd: file })).rejects.toThrow(/not a directory/)
  })

  it('canonicalises a symlinked session directory to its real location', async () => {
    // The boundary must be the directory that exists, not the name it was reached
    // by, or a symlink would place the real containment root somewhere the policy
    // never agreed to.
    const sessions = fakeSessions()
    const { driver } = driverWith(sessions)
    const real = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-cwd-real-'))
    const link = join(mkdtempSync(join(tmpdir(), 'dsh-as-mcp-cwd-link-')), 'link')
    scratch.push(real, dirname(link))
    symlinkSync(real, link)

    await driver.createSession({ cwd: link })

    expect(sessions.creates[0]?.cwd).toBe(realpathSync(real))
  })
})

describe('DshDriver.createWorkspace error messages', () => {
  /** A driver over a registry that models realpath/ENOENT like the harness does. */
  function withRegistry(): DshDriver {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('workspaceRegistry', {
      create: async (path: string, title?: string) => ({
        id: 'ws-1',
        path,
        title: title ?? path,
        createdAt: 0,
        updatedAt: 0,
        sessionIds: [],
        status: async () => 'ok',
      }),
      get: () => undefined,
      list: () => [],
      delete: async () => true,
      resolveByPath: async (path: string) => {
        const entry = await stat(path).catch(() => undefined)
        if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (!entry.isDirectory()) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
        return { id: 'ws-1', path, title: path, createdAt: 0, updatedAt: 0, sessionIds: [], status: async () => 'ok' }
      },
    } as never)
    return new DshDriver(ctx, () => testConfig())
  }

  it('names a file path as "not a directory" instead of echoing mkdir EEXIST', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-ws-file-'))
    scratch.push(dir)
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')

    await expect(withRegistry().createWorkspace({ path: file }))
      .rejects.toThrow(/exists but is not a directory/)
  })

  it('tells the caller how to create a missing directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-ws-missing-'))
    scratch.push(dir)
    await expect(withRegistry().createWorkspace({ path: join(dir, 'not-yet'), createDirectory: false }))
      .rejects.toThrow(/Pass createDirectory: true/)
  })
})

describe('DshDriver.deleteWorkspace', () => {
  /** A driver over a registry whose delete reports `found`. */
  function withRegistry(options: { found: boolean; hasDelete?: boolean }): DshDriver {
    const ctx = new Context()
    contexts.push(ctx)
    const registry: Record<string, unknown> = {
      create: async () => ({}),
      get: () => undefined,
      list: () => [],
      resolveByPath: async () => undefined,
    }
    if (options.hasDelete !== false) registry.delete = async () => options.found
    ctx.provide('workspaceRegistry', registry)
    return new DshDriver(ctx, () => testConfig())
  }

  it('unregisters a known workspace', async () => {
    await expect(withRegistry({ found: true }).deleteWorkspace({ workspaceId: 'ws-1' }))
      .resolves.toEqual({ workspaceId: 'ws-1', deleted: true })
  })

  it('is idempotent: an unknown id answers deleted: false', async () => {
    await expect(withRegistry({ found: false }).deleteWorkspace({ workspaceId: 'gone' }))
      .resolves.toEqual({ workspaceId: 'gone', deleted: false })
  })

  it('names the missing capability when the harness has no delete', async () => {
    await expect(withRegistry({ found: true, hasDelete: false }).deleteWorkspace({ workspaceId: 'ws-1' }))
      .rejects.toThrow(/no workspace delete/)
  })
})

describe('DshDriver capability gating', () => {
  it('does not recommend all: true when no profile listing exists', async () => {
    // A bare context has no sessionController, so `all: true` cannot work. The
    // empty default report must not send the caller down that path.
    const ctx = new Context()
    contexts.push(ctx)
    const driver = new DshDriver(ctx, () => testConfig())

    const report = await driver.sessionUsage({ limit: 5 })
    const notes = report.notes.join('\n')
    expect(notes).toMatch(/pass a known sessionId/i)
    expect(notes).not.toMatch(/all: true to scan every session/)
  })

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
