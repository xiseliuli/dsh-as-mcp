/**
 * Driver-level integration tests for the usage-reporting feature.
 *
 * The arithmetic (`usage.ts`) and the payload assembly (`report.ts`) have their
 * own unit tests; what is pinned here is the seam the MCP caller actually talks
 * to: `DshDriver.promptSession()` receipts and `DshDriver.sessionUsage()`
 * reports, driven against a fake Cordis context and a fake harness.
 *
 * The fake harness owns the things the driver decides about but does not
 * control: the durable log (one mutable array per session id), which read the
 * driver is offered (`observeSession` vs `readSession` vs the controller's
 * `inspect`), what the harness's own `tokenUsage` projection says, and whether a
 * session can still be read at all.
 */

import { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { DshCapabilityError, DshDriver } from '../src/dsh/driver.js'
import type {
  DshSessionController,
  DshSessionEvent,
  DshSessionQuery,
  DshSessionSummary,
  DshTokenUsage,
  DshTokenUsageProjection,
} from '../src/dsh/types.js'
import { testConfig } from './harness.js'

// ---------------------------------------------------------------------------
// Durable-log fixtures
// ---------------------------------------------------------------------------

/** One durable-log entry. */
function event(type: string, data: unknown, seq: number): DshSessionEvent {
  return { type, data, seq, time: 1_700_000_000_000 + seq }
}

/** A provider usage record with the four disjoint buckets the harness reports. */
function tokenUsage(
  uncachedInputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): DshTokenUsage {
  return { inputTokens: uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/** The route every fake settlement is billed under. */
const ROUTE = { provider: 'deepseek', model: 'deepseek-v4.1-flash' } as const

/** `assistant/message` data: the reply the caller sees plus what it billed. */
function assistantData(
  turn: number,
  step: number,
  text: string,
  usage: DshTokenUsage,
): Record<string, unknown> {
  return {
    turn,
    step,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', ...ROUTE },
    },
    usage,
  }
}

/** One assistant settlement carrying its own usage sample. */
function assistant(seq: number, turn: number, step: number, text: string, usage: DshTokenUsage): DshSessionEvent {
  return event('assistant/message', assistantData(turn, step, text, usage), seq)
}

/** One settled turn in a log, with the given usage samples and nothing else. */
function completedTurn(
  startSeq: number,
  turn: number,
  samples: readonly { readonly step: number; readonly text: string; readonly usage: DshTokenUsage }[],
): DshSessionEvent[] {
  const events: DshSessionEvent[] = [event('turn/start', { turn }, startSeq)]
  let seq = startSeq + 1
  for (const sample of samples) {
    events.push(assistant(seq, turn, sample.step, sample.text, sample.usage))
    seq += 1
  }
  events.push(event('turn/end', { turn, reason: { kind: 'completed' } }, seq))
  return events
}

/**
 * What a fake `settle` prompt appends to the log: two settlements of one turn,
 * with a tool round trip between them. The receipt's per-turn total therefore
 * has to cover both steps, not just the last model call.
 */
const PROMPT_TURN_SAMPLES = [
  { step: 0, text: 'Working on it.', usage: tokenUsage(100, 20, 1000, 0) },
  { step: 1, text: 'Done.', usage: tokenUsage(50, 10, 500, 2) },
]

/** The sum of {@link PROMPT_TURN_SAMPLES}: the prompt turn's receipt. */
const PROMPT_TURN_TOTALS = {
  uncachedInputTokens: 150,
  cacheReadTokens: 1500,
  cacheWriteTokens: 2,
  outputTokens: 30,
  totalTokens: 1682,
}

/** What a fake `open` prompt appends: one settlement of a turn that never ends. */
const OPEN_TURN_SAMPLE = { step: 0, text: 'Still working.', usage: tokenUsage(7, 3) }

/** The open turn's receipt, folded in even though the turn has not closed. */
const OPEN_TURN_TOTALS = {
  uncachedInputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 3,
  totalTokens: 10,
}

/** A first turn in the log, so cumulative totals have a history to add to. */
const FIRST_TURN = completedTurn(0, 1, [{ step: 0, text: 'earlier', usage: tokenUsage(10, 4, 0, 1) }])

/** Its totals, which are also what a projection has to report to verify. */
const FIRST_TURN_TOTALS = {
  uncachedInputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 1,
  outputTokens: 4,
  totalTokens: 15,
}

/** The harness's own figure for a log holding only {@link FIRST_TURN}. */
const FIRST_TURN_PROJECTION: DshTokenUsageProjection = {
  uncachedInputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 1,
  outputTokens: 4,
}

/** {@link FIRST_TURN} plus a settled prompt turn, which is what test one folds. */
const CUMULATIVE_TOTALS = {
  uncachedInputTokens: 160,
  cacheReadTokens: 1500,
  cacheWriteTokens: 3,
  outputTokens: 34,
  totalTokens: 1697,
}

/** The projection that agrees with {@link CUMULATIVE_TOTALS}. */
const CUMULATIVE_PROJECTION: DshTokenUsageProjection = {
  uncachedInputTokens: 160,
  cacheReadTokens: 1500,
  cacheWriteTokens: 3,
  outputTokens: 34,
}

// ---------------------------------------------------------------------------
// Fake harness
// ---------------------------------------------------------------------------

/** One session as `sessionController.list()` reports it. */
function summary(
  sessionId: string,
  overrides: Partial<DshSessionSummary> = {},
): DshSessionSummary {
  return { sessionId, updatedAt: 1, running: false, blank: false, ...overrides }
}

interface FakeHarnessOptions {
  /** Initial logs, keyed by session id; the fake keeps them mutable. */
  readonly logs?: Record<string, DshSessionEvent[]>
  /** What `sessionController.list()` reports, most recently updated first. */
  readonly summaries?: DshSessionSummary[]
  /** Mount `observeSession`. Absent means the driver must fall back to `readSession`. */
  readonly observe?: boolean
  /** The `tokenUsage` projection each observation reports, keyed by session id. */
  readonly projections?: Record<string, DshTokenUsageProjection>
  /** The `cwd` each read reports, keyed by session id. */
  readonly cwds?: Record<string, string>
  /** Session ids whose read rejects, modelling a pruned or corrupt session. */
  readonly unreadable?: readonly string[]
  /** What `controller.prompt` appends after committing the user message. */
  readonly prompt?: 'settle' | 'open' | 'commit'
}

interface FakeHarness {
  readonly logs: Record<string, DshSessionEvent[]>
  readonly prompts: string[]
  readonly creates: Record<string, unknown>[]
  /** Session ids passed to `sessionQuery.readSession`, in call order. */
  readonly readCalls: string[]
  /** Observations taken, including the projection mode asked for. */
  readonly observeCalls: { readonly sessionId: string; readonly projectionMode?: string }[]
  /** How many times an observation lease's `[Symbol.dispose]()` ran. */
  readonly disposeCalls: number
  readonly controller: DshSessionController
  readonly query: DshSessionQuery
  /** Append an entry, continuing the session's seq numbering. */
  append(sessionId: string, type: string, data: unknown): void
}

/**
 * One fake harness: a durable log per session id, plus the three services the
 * driver reads it through. Behaves like the real one where the driver depends on
 * it — `prompt` commits the user message with `source.rpcId` set to the request
 * id, and a `settle` prompt writes a complete turn synchronously, so a waiting
 * `promptSession()` sees a settled log on its first poll.
 */
function fakeHarness(options: FakeHarnessOptions = {}): FakeHarness {
  const logs: Record<string, DshSessionEvent[]> = {}
  for (const [sessionId, entries] of Object.entries(options.logs ?? {})) logs[sessionId] = [...entries]
  const summaries = [...(options.summaries ?? [])]
  const projections = options.projections ?? {}
  const cwds = options.cwds ?? {}
  const unreadable = new Set(options.unreadable ?? [])
  const behaviour = options.prompt ?? 'settle'
  const prompts: string[] = []
  const creates: Record<string, unknown>[] = []
  const readCalls: string[] = []
  const observeCalls: { sessionId: string; projectionMode?: string }[] = []
  let disposeCalls = 0

  const ensure = (sessionId: string): DshSessionEvent[] => {
    const existing = logs[sessionId]
    if (existing !== undefined) return existing
    const created: DshSessionEvent[] = []
    logs[sessionId] = created
    return created
  }

  const append = (sessionId: string, type: string, data: unknown): void => {
    const events = ensure(sessionId)
    const last = events[events.length - 1]
    events.push(event(type, data, last === undefined ? 0 : last.seq + 1))
  }

  /** The next turn number on a session, from the `turn/start` events it holds. */
  const nextTurn = (sessionId: string): number => {
    let highest = 0
    for (const entry of ensure(sessionId)) {
      if (entry.type !== 'turn/start') continue
      const turn = (entry.data as { turn?: unknown } | undefined)?.turn
      if (typeof turn === 'number' && turn > highest) highest = turn
    }
    return highest + 1
  }

  const gone = (sessionId: string): never => {
    throw new Error(`session "${sessionId}" is gone`)
  }

  const controller: DshSessionController = {
    create: async (request) => {
      creates.push({ ...request })
      const sessionId = `session-${creates.length}`
      ensure(sessionId)
      return { sessionId }
    },
    list: async () => ({ items: summaries }),
    selectModel: async (request) => ({ selected: { provider: request.provider, model: request.model } }),
    prompt: async (request) => {
      const text = request.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      if (text.trim() === '') throw new Error('prompt content must not be blank')
      prompts.push(request.requestId)
      append(request.sessionId, 'user/message', {
        id: `m-${request.requestId}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: request.requestId },
      })
      if (behaviour === 'commit') return { accepted: true }
      const turn = nextTurn(request.sessionId)
      append(request.sessionId, 'turn/start', { turn })
      if (behaviour === 'open') {
        append(
          request.sessionId,
          'assistant/message',
          assistantData(turn, OPEN_TURN_SAMPLE.step, OPEN_TURN_SAMPLE.text, OPEN_TURN_SAMPLE.usage),
        )
        return { accepted: true }
      }
      for (const sample of PROMPT_TURN_SAMPLES) {
        append(request.sessionId, 'assistant/message', assistantData(turn, sample.step, sample.text, sample.usage))
        // A tool round trip between the two model calls: it carries no usage of
        // its own, but the turn total has to include the step that follows it.
        if (sample.step === 0) {
          append(request.sessionId, 'tool/call', { turn, step: sample.step, callId: 'call-1', name: 'read', arguments: '{"path":"a"}' })
        }
      }
      append(request.sessionId, 'turn/end', { turn, reason: { kind: 'completed' } })
      return { accepted: true }
    },
    cancel: () => ({ accepted: true }),
    inspect: async (sessionId) => {
      // Every reader refuses a session that is gone, which is what the real
      // harness does: `inspect` resolving with an empty log would make a pruned
      // session look like a brand-new one.
      if (unreadable.has(sessionId)) gone(sessionId)
      const cwd = cwds[sessionId]
      return {
        meta: { id: sessionId, ...(cwd === undefined ? {} : { cwd }) },
        inheritedEventCount: 0,
        events: ensure(sessionId),
      }
    },
  }

  const query: DshSessionQuery = {
    readSession: async (sessionId) => {
      readCalls.push(sessionId)
      if (unreadable.has(sessionId)) gone(sessionId)
      const cwd = cwds[sessionId]
      return {
        session: { id: sessionId, ...(cwd === undefined ? {} : { cwd }) },
        inheritedEventCount: 0,
        events: ensure(sessionId),
      }
    },
  }

  // The preferred read. Its lease must be disposed or it pins the prepared
  // observation cache, so the fake records every disposal for the driver's
  // `finally` block to be asserted against.
  if (options.observe === true) {
    query.observeSession = async (sessionId, observeOptions) => {
      const projectionMode = observeOptions?.projectionMode
      observeCalls.push({ sessionId, ...(projectionMode === undefined ? {} : { projectionMode }) })
      if (unreadable.has(sessionId)) gone(sessionId)
      const events = ensure(sessionId)
      const cursor = events.length === 0 ? -1 : (events[events.length - 1] as DshSessionEvent).seq
      const projection = projections[sessionId]
      const cwd = cwds[sessionId]
      return {
        source: 'prepared',
        header: { id: sessionId, ...(cwd === undefined ? {} : { cwd }) },
        inheritedEventCount: 0,
        events,
        cursor,
        projections: {
          asOfSeq: cursor,
          values: projection === undefined ? {} : { tokenUsage: projection },
        },
        [Symbol.dispose]: () => {
          disposeCalls += 1
        },
      }
    }
  }

  return {
    logs,
    prompts,
    creates,
    readCalls,
    observeCalls,
    get disposeCalls() {
      return disposeCalls
    },
    controller,
    query,
    append,
  }
}

// ---------------------------------------------------------------------------
// Driver fixtures
// ---------------------------------------------------------------------------

/** Cordis contexts disposed after each test. */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/**
 * A driver over one fake harness.
 *
 * Usage is on unless a test turns it off, because the default config has it off
 * (it is a tool gate) and every test that does not say otherwise is about usage.
 */
function makeDriver(
  harness: FakeHarness,
  options: {
    readonly tools?: Partial<Config['tools']>
    readonly sessionQuery?: boolean
    readonly session?: Partial<Config['session']>
  } = {},
): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('sessionController', harness.controller)
  if (options.sessionQuery !== false) ctx.provide('sessionQuery', harness.query)
  return {
    driver: new DshDriver(ctx, () => ({
      ...testConfig({ usage: true, ...options.tools }),
      ...(options.session === undefined ? {} : { session: { ...testConfig().session, ...options.session } }),
    })),
    ctx,
  }
}

// ---------------------------------------------------------------------------
// Prompt receipts
// ---------------------------------------------------------------------------

describe('DshDriver.promptSession usage receipts', () => {
  it('returns the turn receipt and the settled session total, verified against the projection', async () => {
    const harness = fakeHarness({
      logs: { 'session-1': FIRST_TURN },
      observe: true,
      projections: { 'session-1': CUMULATIVE_PROJECTION },
    })
    const { driver } = makeDriver(harness)

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })

    expect(reply.accepted).toBe(true)
    expect(reply.turn?.turn).toBe(2)
    expect(reply.turn?.timedOut).toBe(false)
    expect(reply.turn?.aborted).toBe(false)
    expect(reply.turn?.reply).toContain('Done.')
    // The turn total covers both steps, including the one after a tool round trip.
    expect(reply.turn?.usage).toEqual({ turn: 2, steps: 2, ...PROMPT_TURN_TOTALS })

    expect(reply.session?.sessionId).toBe('session-1')
    // Cumulative over the whole log, not just the turn this prompt ran.
    expect(reply.session?.usage.totals).toEqual(CUMULATIVE_TOTALS)
    expect(reply.session?.usage.turns).toBe(2)
    expect(reply.session?.usage.steps).toBe(3)
    expect(reply.session?.usage.samples).toBe(3)
    expect(reply.session?.usage.verifiedAgainstProjection).toBe(true)
    expect(reply.session?.usage).not.toHaveProperty('projectionTotals')
    expect(reply.session?.usage.partial).toBeUndefined()
    // Every settlement used one route, so there is exactly one attributed row.
    expect(reply.session?.usage.byModel).toEqual([{ ...ROUTE, samples: 3, ...CUMULATIVE_TOTALS }])
  })

  it('omits every usage block when tools.usage is disabled', async () => {
    const harness = fakeHarness({
      logs: { 'session-1': FIRST_TURN },
      observe: true,
      projections: { 'session-1': CUMULATIVE_PROJECTION },
    })
    const { driver } = makeDriver(harness, { tools: { usage: false } })

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })

    expect(reply.turn?.reply).toContain('Done.')
    expect(reply.turn).not.toHaveProperty('usage')
    expect(reply).not.toHaveProperty('session')
    // Gating is not presentation only: the usage read must not happen at all.
    expect(harness.observeCalls).toHaveLength(0)
  })

  it('marks the receipt partial when the wait times out before the turn settles', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, prompt: 'open' })
    const { driver } = makeDriver(harness)

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'slow',
      mode: 'queue',
      wait: true,
      timeoutMs: 1,
    })

    expect(reply.turn?.timedOut).toBe(true)
    expect(reply.turn?.turn).toBe(2)
    expect(reply.turn?.turnEndReason).toBeNull()
    // The open turn has already billed one settlement, and it is folded in.
    expect(reply.turn?.usage).toEqual({ turn: 2, steps: 1, ...OPEN_TURN_TOTALS })
    expect(reply.session?.usage.partial).toBe(true)
    expect(reply.session?.usage.totals).toEqual({
      uncachedInputTokens: 17,
      cacheReadTokens: 0,
      cacheWriteTokens: 1,
      outputTokens: 7,
      totalTokens: 25,
    })
  })

  it('reports a projection that disagrees with the log fold instead of hiding it', async () => {
    const disagreeing: DshTokenUsageProjection = { ...CUMULATIVE_PROJECTION, outputTokens: 35 }
    const harness = fakeHarness({
      logs: { 'session-1': FIRST_TURN },
      observe: true,
      projections: { 'session-1': disagreeing },
    })
    const { driver } = makeDriver(harness)

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do it',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })

    // The log fold is what the caller bills against; the projection is a
    // cross-check, so a disagreement is surfaced rather than resolved.
    expect(reply.session?.usage.totals).toEqual(CUMULATIVE_TOTALS)
    expect(reply.session?.usage.verifiedAgainstProjection).toBe(false)
    expect(reply.session?.usage.projectionTotals).toEqual({ ...disagreeing, totalTokens: 1698 })
    expect(reply.turn?.usage).toEqual({ turn: 2, steps: 2, ...PROMPT_TURN_TOTALS })
  })

  it('says why a reply carries no usage instead of looking like a zero-token turn', async () => {
    // A caller bills against these numbers, so "the read failed" must not be
    // indistinguishable from "this turn billed nothing".
    const harness = fakeHarness({ observe: true, prompt: 'settle' })
    const { driver } = makeDriver(harness)
    harness.query.observeSession = async () => {
      throw new Error('observation reader is down')
    }
    const realRead = harness.query.readSession
    let reads = 0
    // The wait loop needs one working read to see the settled turn; the usage
    // cut afterwards must fail, as it would if the log reader went away.
    harness.query.readSession = async (sessionId) => {
      reads += 1
      if (reads > 1) throw new Error('log reader is down')
      return await realRead(sessionId)
    }
    harness.controller.inspect = async () => {
      throw new Error('inspect is down')
    }

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'do the work',
      mode: 'queue',
      wait: true,
      timeoutMs: 5_000,
    })

    expect(reply.turn?.timedOut).toBe(false)
    expect(reply.turn?.usage).toBeUndefined()
    expect(reply.session).toBeUndefined()
    expect(reply.usageUnavailable).toBe(true)
    expect(reply.reason).toMatch(/is down/)
  })

  it('marks a queued reply whose usage read failed the same way', async () => {
    const harness = fakeHarness({ observe: false, prompt: 'commit' })
    const { driver } = makeDriver(harness)
    harness.query.readSession = async () => {
      throw new Error('log reader is down')
    }
    harness.controller.inspect = async () => {
      throw new Error('inspect is down')
    }

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'queue it',
      mode: 'queue',
      wait: false,
    })

    expect(reply.turn).toBeUndefined()
    expect(reply.session).toBeUndefined()
    expect(reply.usageUnavailable).toBe(true)
  })

  it('prefers observeSession for the usage cut and disposes the lease exactly once', async () => {
    const harness = fakeHarness({
      logs: { 'session-1': FIRST_TURN },
      observe: true,
      projections: { 'session-1': FIRST_TURN_PROJECTION },
      prompt: 'commit',
    })
    const { driver } = makeDriver(harness)

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'just queue it',
      mode: 'queue',
      wait: false,
    })

    expect(reply.turn).toBeUndefined()
    expect(reply.session?.usage.totals).toEqual(FIRST_TURN_TOTALS)
    // An observation is the only read that also carries the projection.
    expect(reply.session?.usage.verifiedAgainstProjection).toBe(true)
    // A queued message has no turn yet, so the session total can still grow.
    expect(reply.session?.usage.partial).toBe(true)
    expect(harness.observeCalls).toEqual([{ sessionId: 'session-1', projectionMode: 'all' }])
    // Preferred means readSession is not consulted for the cut at all.
    expect(harness.readCalls).toHaveLength(0)
    expect(harness.disposeCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Read sources
// ---------------------------------------------------------------------------

describe('DshDriver usage read sources', () => {
  it('falls through to the log when the observation reader throws', async () => {
    // The preferred reader is not the only one: a session the observation
    // reader refuses (pruned, partially restored, a stricter reader on a newer
    // harness) must still report its usage from the plain log read.
    const harness = fakeHarness({
      logs: { 'session-1': FIRST_TURN },
      observe: true,
      projections: { 'session-1': FIRST_TURN_PROJECTION },
      prompt: 'commit',
    })
    harness.query.observeSession = async () => {
      throw new Error('observation reader refuses this session')
    }
    const { driver } = makeDriver(harness)

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'queue it',
      mode: 'queue',
      wait: false,
    })

    expect(reply.session?.usage.totals).toEqual(FIRST_TURN_TOTALS)
    // The projection rode the failed observation, so there is nothing to verify
    // against — and the report says so rather than claiming agreement.
    expect(reply.session?.usage.verifiedAgainstProjection).toBe(false)
    expect(harness.readCalls).toEqual(['session-1'])
  })

  it('separates a fork-inherited prefix read through observeSession', async () => {
    // A seeded session replays its parent's events; that spend belongs to the
    // parent, so it is reported as `inherited` and kept out of `totals`.
    const harness = fakeHarness({ observe: true, prompt: 'commit' })
    // Event 0 is inherited; event 1 is this session's own turn.
    harness.append('session-1', 'assistant/message', assistantData(1, 1, 'inherited', tokenUsage(1000, 100)))
    harness.append('session-1', 'assistant/message', assistantData(2, 1, 'own', tokenUsage(7, 3)))
    const { driver } = makeDriver(harness)
    const realObserve = harness.query.observeSession
    harness.query.observeSession = async (sessionId, options) => {
      const observation = await realObserve!(sessionId, options)
      return { ...observation, inheritedEventCount: 1 }
    }

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'queue it',
      mode: 'queue',
      wait: false,
    })

    expect(reply.session?.usage.totals).toEqual({
      uncachedInputTokens: 7,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 3,
      totalTokens: 10,
    })
    expect(reply.session?.usage.inherited?.totalTokens).toBe(1100)
  })

  it('falls back to readSession when observeSession is not mounted', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, observe: false, prompt: 'commit' })
    const { driver } = makeDriver(harness)

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'queue it',
      mode: 'queue',
      wait: false,
    })

    expect(reply.session?.usage.totals).toEqual(FIRST_TURN_TOTALS)
    // The fallback read carries no projection, so there is nothing to verify
    // against — and that is stated, not invented as agreement.
    expect(reply.session?.usage.verifiedAgainstProjection).toBe(false)
    expect(reply.session?.usage).not.toHaveProperty('projectionTotals')
    expect(harness.readCalls.length).toBeGreaterThanOrEqual(1)
    expect(typeof harness.query.observeSession).toBe('undefined')
    expect(driver.describeCapabilities()).toMatchObject({ tokenUsage: true, costMeter: false })
  })

  it('reads usage from sessionController.inspect when no sessionQuery is mounted', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, prompt: 'commit' })
    const { driver } = makeDriver(harness, { sessionQuery: false })

    // A composition with the controller but no query still reports tokens; it
    // simply cannot verify them against a projection.
    expect(driver.describeCapabilities()).toMatchObject({ tokenUsage: true })

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'queue it',
      mode: 'queue',
      wait: false,
    })

    expect(reply.session?.usage.totals).toEqual(FIRST_TURN_TOTALS)
    expect(reply.session?.usage.verifiedAgainstProjection).toBe(false)

    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 20 })
    expect(report.scope).toBe('session')
    expect(report.sessions).toHaveLength(1)
    expect(report.sessions[0]?.usage?.totals).toEqual(FIRST_TURN_TOTALS)
  })
})

// ---------------------------------------------------------------------------
// session_usage reports
// ---------------------------------------------------------------------------

/** The session and its subagent child, used by the multi-session reports below. */
const SELF_USAGE = completedTurn(0, 1, [{ step: 0, text: 'self', usage: tokenUsage(100, 10) }])
const CHILD_USAGE = completedTurn(0, 1, [
  { step: 0, text: 'child one', usage: tokenUsage(20, 5) },
  { step: 1, text: 'child two', usage: tokenUsage(30, 8) },
])
const SELF_TOTALS = {
  uncachedInputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 10,
  totalTokens: 110,
}

interface TreeOptions {
  readonly summaries?: DshSessionSummary[]
  readonly unreadable?: readonly string[]
}

/** A session with one subagent child, each with its own log. */
function treeHarness(options: TreeOptions = {}): FakeHarness {
  return fakeHarness({
    logs: { 'session-1': SELF_USAGE, 'session-child': CHILD_USAGE },
    summaries: options.summaries ?? [
      summary('session-1', { updatedAt: 2, cwd: '/tmp/project' }),
      summary('session-child', { updatedAt: 1, cwd: '/tmp/project', parentSessionId: 'session-1', origin: 'subagent' }),
    ],
    cwds: { 'session-1': '/tmp/project', 'session-child': '/tmp/project' },
    ...(options.unreadable === undefined ? {} : { unreadable: options.unreadable }),
    prompt: 'commit',
  })
}

describe('DshDriver.sessionUsage', () => {
  it('reports several known ids in one receipt and collapses duplicates', async () => {
    const harness = treeHarness()
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({
      sessionIds: ['session-1', 'session-1', 'session-child'],
      limit: 20,
    })

    expect(report.scope).toBe('sessionIds')
    // Two rows: the parent once, and the child once as its subagent.
    expect(report.sessions.map((row) => [row.sessionId, row.origin])).toEqual([
      ['session-1', 'self'],
      ['session-child', 'subagent'],
    ])
    const expected = report.sessions.reduce((sum, row) => sum + (row.usage?.totals.totalTokens ?? 0), 0)
    expect(report.totals.totalTokens).toBe(expected)
  })

  it('totals every session that ran in one workspace directory', async () => {
    const harness = fakeHarness({
      logs: { 'session-1': FIRST_TURN, 'session-2': FIRST_TURN, 'session-3': FIRST_TURN },
      summaries: [
        summary('session-1', { cwd: '/tmp/project', updatedAt: 3 }),
        summary('session-2', { cwd: '/tmp/project', updatedAt: 2 }),
        summary('session-3', { cwd: '/tmp/elsewhere', updatedAt: 1 }),
      ],
    })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ cwd: '/tmp/project', limit: 10 })
    expect(report.scope).toBe('workspace')
    expect(report.sessions.map((row) => row.sessionId)).toEqual(['session-1', 'session-2'])
    const expected = report.sessions.reduce((sum, row) => sum + (row.usage?.totals.totalTokens ?? 0), 0)
    expect(report.totals.totalTokens).toBe(expected)
    // The limit applies to the matching set, and says when it cut.
    const capped = await driver.sessionUsage({ cwd: '/tmp/project', limit: 1 })
    expect(capped.sessions).toHaveLength(1)
    expect((capped.notes ?? []).some((note) => /raise limit/.test(note))).toBe(true)
    // An empty workspace is explained, not silently zero.
    const none = await driver.sessionUsage({ cwd: '/tmp/nowhere', limit: 5 })
    expect(none.sessions).toHaveLength(0)
    expect((none.notes ?? []).some((note) => /No session this DSH knows ran in/.test(note))).toBe(true)
  })

  it('keeps the owned tree — created sessions and their subagents — and excludes the rest', async () => {
    const harness = fakeHarness({
      logs: { 'session-1': FIRST_TURN, 'session-child': CHILD_USAGE, 'session-user': FIRST_TURN },
      summaries: [
        summary('session-1', { updatedAt: 3, cwd: '/tmp/project' }),
        summary('session-child', { updatedAt: 2, cwd: '/tmp/project', parentSessionId: 'session-1', origin: 'subagent' }),
        summary('session-user', { updatedAt: 1, cwd: '/tmp/project' }),
      ],
    })
    const { driver } = makeDriver(harness, { session: { scope: 'owned' } })
    // Only a session this endpoint creates is visible under `owned`; the subagent
    // session below it is part of the tree.
    await driver.createSession({ cwd: '/tmp' })
    const report = await driver.sessionUsage({ all: true, limit: 10 })
    expect(report.sessions.map((row) => row.sessionId)).toEqual(['session-1', 'session-child'])
    expect((report.notes ?? []).some((note) => /session\.scope is "owned"/.test(note))).toBe(true)
    // A subagent of an owned session may be read by id: it is that session's cost.
    await expect(driver.sessionUsage({ sessionId: 'session-child', limit: 5 }))
      .resolves.toMatchObject({ scope: 'session' })
    // A session outside the tree is refused rather than silently omitted.
    await expect(driver.sessionUsage({ sessionId: 'session-user', limit: 5 }))
      .rejects.toThrow(/session\.scope is "owned"/)
  })

  it('refuses mixing cwd with the id selectors', async () => {
    const harness = treeHarness()
    const { driver } = makeDriver(harness)
    await expect(driver.sessionUsage({ cwd: '/tmp', sessionId: 'session-1', limit: 5 }))
      .rejects.toThrow(/not more than one of them/)
  })

  it('refuses mixing sessionIds with sessionId or all', async () => {
    const harness = treeHarness()
    const { driver } = makeDriver(harness)
    await expect(driver.sessionUsage({ sessionIds: ['session-1'], sessionId: 'session-1', limit: 5 }))
      .rejects.toThrow(/not more than one of them/)
    await expect(driver.sessionUsage({ sessionIds: ['session-1'], all: true, limit: 5 }))
      .rejects.toThrow(/not more than one of them/)
  })

  it('marks a report partial when the newest turn is still running', async () => {
    // A mid-flight read is a snapshot: the totals will grow when the turn ends, and
    // a caller billing on them must know that.
    const openTurn: DshSessionEvent[] = [
      event('user/message', { role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user', rpcId: 'r-1' } }, 0),
      event('turn/start', { turn: 1 }, 1),
      assistant(2, 1, 1, 'working on it', tokenUsage(100, 10)),
      event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, 3),
    ]
    const harness = fakeHarness({ logs: { 'session-1': openTurn }, summaries: [summary('session-1')] })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 5 })

    expect(report.sessions[0]?.usage?.partial).toBe(true)
    expect(report.sessions[0]?.usage?.totals.totalTokens).toBe(110)
    // The same fact must be visible at the level a caller bills from, and said in
    // words: reading only `totals` must not look like a final receipt.
    expect(report.partial).toBe(true)
    expect((report.notes ?? []).some((note) => /unfinished turn/.test(note))).toBe(true)
  })

  it('does not mark a settled session partial', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, summaries: [summary('session-1')] })
    const { driver } = makeDriver(harness)
    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 5 })
    expect(report.sessions[0]?.usage?.partial).toBeUndefined()
    expect(report.partial).toBeUndefined()
  })

  it('folds subagent children into their own rows and adds their tokens to the totals', async () => {
    const harness = treeHarness()
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ sessionId: 'session-1', includeTurns: true, limit: 20 })

    expect(report.scope).toBe('session')
    expect(report.subagentsIncluded).toBe(true)
    expect(report.sessions.map((row) => [row.sessionId, row.origin, row.parentSessionId])).toEqual([
      ['session-1', 'self', undefined],
      ['session-child', 'subagent', 'session-1'],
    ])
    expect(report.sessions[0]?.cwd).toBe('/tmp/project')

    // includeTurns: true is what carries the per-turn breakdown.
    expect(report.sessions[0]?.usage?.byTurn).toEqual([
      { turn: 1, steps: 1, ...SELF_TOTALS },
    ])
    expect(report.sessions[1]?.usage?.byTurn).toHaveLength(1)
    expect(report.sessions[1]?.usage?.steps).toBe(2)
    expect(report.sessions[1]?.usage?.byTurn[0]?.totalTokens).toBe(63)

    // Child tokens were billed too, so the report's totals include them.
    expect(report.totals).toEqual({
      uncachedInputTokens: 150,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 23,
      totalTokens: 173,
      turns: 2,
      steps: 3,
      samples: 3,
    })
    expect(report.byModel).toEqual([{
      ...ROUTE,
      samples: 3,
      uncachedInputTokens: 150,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 23,
      totalTokens: 173,
    }])

    const totalsOnly = await driver.sessionUsage({ sessionId: 'session-1', limit: 20 })
    expect(totalsOnly.sessions.every((row) => row.usage?.byTurn.length === 0)).toBe(true)
    // Detail is optional; the numbers a caller bills against are not.
    expect(totalsOnly.totals).toEqual(report.totals)
  })

  it('degrades an unreadable session to an error row and leaves it out of the totals', async () => {
    const harness = treeHarness({ unreadable: ['session-child'] })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 20 })

    const broken = report.sessions.find((row) => row.sessionId === 'session-child')
    expect(broken?.error).toMatch(/is gone/)
    expect(broken?.usage).toBeUndefined()
    // The single readable row is still reported in full.
    expect(report.totals).toEqual({ ...SELF_TOTALS, turns: 1, steps: 1, samples: 1 })
    expect(report.notes.some((note) => note.includes('1 of 2 session(s) could not be read'))).toBe(true)
    // Money is unknown for a session that could not be read, never silently zero.
    expect(broken?.cost).toBeUndefined()
    expect(report.cost.available).toBe(false)
  })

  it('scans only the requested number of sessions and notes the truncation', async () => {
    // `sessionController.list()` reports most recently updated first; this
    // fixture is ordered the same, and the driver must not depend on it.
    const harness = fakeHarness({
      logs: {
        'session-new': completedTurn(0, 1, [{ step: 0, text: 'new', usage: tokenUsage(1, 1) }]),
        'session-old': completedTurn(0, 1, [{ step: 0, text: 'old', usage: tokenUsage(2, 2) }]),
      },
      summaries: [
        summary('session-new', { updatedAt: 2 }),
        summary('session-old', { updatedAt: 1 }),
      ],
      prompt: 'commit',
    })
    const { driver } = makeDriver(harness)

    const limited = await driver.sessionUsage({ all: true, limit: 1 })

    expect(limited.scope).toBe('allSessions')
    expect(limited.sessions.map((row) => row.sessionId)).toEqual(['session-new'])
    expect(limited.totals.totalTokens).toBe(2)
    expect(limited.notes.some((note) => note.includes('Only the 1 most recently updated session(s) were scanned'))).toBe(true)
    expect(limited.notes.some((note) => note.includes('raise limit to cover more'))).toBe(true)
  })

  it('does not fold an ordinary fork in as a subagent', async () => {
    // `parentSessionId` is fork lineage as well as subagent parentage. A fork is
    // a full session of its own: folding it in would report a sibling as part of
    // this session, and excluding it under includeSubagents:false would drop its
    // spend from the totals.
    const harness = fakeHarness({
      logs: { 'session-1': SELF_USAGE, 'session-fork': FIRST_TURN },
      summaries: [
        summary('session-1', { updatedAt: 3, cwd: '/tmp/project' }),
        // A fork: parentSessionId without origin.
        summary('session-fork', { updatedAt: 2, cwd: '/tmp/project', parentSessionId: 'session-1' }),
      ],
      cwds: { 'session-1': '/tmp/project', 'session-fork': '/tmp/project' },
      prompt: 'commit',
    })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 20 })

    expect(report.sessions.map((row) => row.sessionId)).toEqual(['session-1'])
    expect(report.subagentsIncluded).toBe(false)
    expect(report.notes.some((note) => note.includes('No subagent session was found'))).toBe(true)
  })

  it('still includes a fork in an all-sessions scan, where it is a session of its own', async () => {
    const harness = fakeHarness({
      logs: { 'session-1': SELF_USAGE, 'session-fork': FIRST_TURN },
      summaries: [
        summary('session-1', { updatedAt: 3, cwd: '/tmp/project' }),
        summary('session-fork', { updatedAt: 2, cwd: '/tmp/project', parentSessionId: 'session-1' }),
      ],
      prompt: 'commit',
    })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ all: true, limit: 20 })

    expect(report.sessions.map((row) => row.sessionId).sort()).toEqual(['session-1', 'session-fork'])
    // A fork is not a subagent, so `subagentsIncluded` stays false.
    expect(report.subagentsIncluded).toBe(false)
  })

  it('sorts an all-sessions scan itself instead of trusting the host order', async () => {
    const harness = fakeHarness({
      logs: { 'session-a': FIRST_TURN, 'session-b': FIRST_TURN },
      // Deliberately oldest first: the truncation note claims "most recent", so
      // the report must not inherit a host's list order.
      summaries: [
        summary('session-a', { updatedAt: 1 }),
        summary('session-b', { updatedAt: 9 }),
      ],
      prompt: 'commit',
    })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ all: true, limit: 1 })

    expect(report.sessions.map((row) => row.sessionId)).toEqual(['session-b'])
  })

  it('honours includeSubagents: false for an all-sessions scan and says what it left out', async () => {
    const harness = treeHarness()
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ all: true, includeSubagents: false, limit: 20 })

    expect(report.scope).toBe('allSessions')
    expect(report.sessions.map((row) => row.sessionId)).toEqual(['session-1'])
    expect(report.subagentsIncluded).toBe(false)
    expect(report.notes.some((note) => note.includes('includeSubagents is false'))).toBe(true)
  })

  it('says subagents were excluded for a session-scoped receipt too', async () => {
    const harness = treeHarness()
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ sessionId: 'session-1', includeSubagents: false, limit: 20 })

    expect(report.sessions.map((row) => row.sessionId)).toEqual(['session-1'])
    expect(report.subagentsIncluded).toBe(false)
    // A caller that turned subagents off still has to know the task's cost is not
    // this number: the child's tokens were billed to the same account.
    expect(report.notes.some((note) => note.includes('subagent session(s) were excluded'))).toBe(true)
  })

  it('degrades a failing session listing to a note for a session-scoped receipt', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, prompt: 'commit' })
    harness.controller.list = async () => {
      throw new Error('session corpus is unavailable')
    }
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 20 })

    // The session's own usage is readable by id, so it is still reported.
    expect(report.sessions.map((row) => row.sessionId)).toEqual(['session-1'])
    expect(report.totals).toEqual({ ...FIRST_TURN_TOTALS, turns: 1, steps: 1, samples: 1 })
    expect(
      report.notes.some((note) => note.includes('could not list sessions') && note.includes('session corpus is unavailable')),
    ).toBe(true)
    // And it must not claim to have looked for children and found none.
    expect(report.notes.some((note) => note.includes('No subagent session was found'))).toBe(false)
  })

  it('explains an unscoped scan it cannot serve instead of blaming a missing service', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, prompt: 'commit' })
    harness.controller.list = async () => {
      throw new Error('session corpus is unavailable')
    }
    const { driver } = makeDriver(harness)

    await expect(driver.sessionUsage({ all: true, limit: 20 })).rejects.toThrow(
      /could not list sessions.*session corpus is unavailable/s,
    )
  })

  it('still serves plugin-scoped usage from its own ids when the listing fails', async () => {
    const harness = fakeHarness({ logs: {}, prompt: 'commit' })
    const { driver } = makeDriver(harness)
    // One session this endpoint created, then the corpus becomes unreadable.
    const created = await driver.createSession({ cwd: tmpdir() })
    harness.controller.list = async () => {
      throw new Error('session corpus is unavailable')
    }

    const report = await driver.sessionUsage({ limit: 20 })

    expect(report.scope).toBe('pluginSessions')
    expect(report.sessions.map((row) => row.sessionId)).toEqual([created.sessionId])
    expect(
      report.notes.some((note) => note.includes('could not list sessions') && note.includes('session corpus is unavailable')),
    ).toBe(true)
  })

  it('caps the rows it reads and says the report is incomplete', async () => {
    // 105 sessions with empty logs: every row is readable, but the report must
    // stop at the cap instead of reading an unbounded corpus.
    const summaries = Array.from({ length: 105 }, (_, index) =>
      summary(`session-${index}`, { updatedAt: index }))
    const harness = fakeHarness({ summaries, prompt: 'commit' })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ all: true, limit: 200 })

    expect(report.sessions).toHaveLength(100)
    expect(report.truncatedRows).toBe(true)
    expect(report.notes.some((note) => note.includes('Only the first 100 session row(s)'))).toBe(true)
  })

  it('aggregates unreadable usage records into a top-level count and note', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, prompt: 'commit' })
    // A malformed usage record: the fold can see it, but cannot trust the counts.
    harness.append('session-1', 'assistant/message', {
      turn: 2,
      step: 1,
      message: { content: [], source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
      usage: { inputTokens: 'lots', outputTokens: 3 },
    })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 20 })

    expect(report.ignoredSamples).toBe(1)
    expect(report.notes.some((note) => note.includes('could not be read'))).toBe(true)
  })

  it('reports no subagents when a session has none', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, prompt: 'commit' })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 20 })

    expect(report.subagentsIncluded).toBe(false)
    expect(report.notes.some((note) => note.includes('No subagent session was found'))).toBe(true)
  })

  it('reports an empty plugin-session scope with an explanation when nothing was created here', async () => {
    const harness = fakeHarness({
      logs: { 'session-1': FIRST_TURN },
      summaries: [summary('session-1', { updatedAt: 1 })],
      prompt: 'commit',
    })
    const { driver } = makeDriver(harness)

    const report = await driver.sessionUsage({ limit: 20 })

    expect(report.scope).toBe('pluginSessions')
    expect(report.sessions).toEqual([])
    expect(report.totals.totalTokens).toBe(0)
    expect(
      report.notes.some((note) => note.includes('No session was created through this endpoint')),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe('usage money reporting', () => {
  it('still reports tokens, and explains why money is unavailable, with no price service', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, prompt: 'commit' })
    const { driver } = makeDriver(harness)

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'queue it',
      mode: 'queue',
      wait: false,
    })

    expect(reply.session?.usage.totals).toEqual(FIRST_TURN_TOTALS)
    expect(reply.session?.cost).toMatchObject({ available: false })
    expect(reply.session?.cost.reason).toMatch(/no price source/)
    expect(driver.describeCapabilities()).toMatchObject({ tokenUsage: true, costMeter: false })
  })

  it('skips the price ledger entirely when includeCost is false', async () => {
    const harness = treeHarness()
    const { driver, ctx } = makeDriver(harness)
    let ledgerReads = 0
    ctx.provide('costMeter', {
      getSessionCost: async () => {
        ledgerReads += 1
        return { found: true, own: { id: 'session-1', calls: 1, cost: 0.1, apiCost: 0.1 } }
      },
    })

    const report = await driver.sessionUsage({ sessionId: 'session-1', includeCost: false, limit: 20 })

    // The tokens are still the answer; only the money ask is skipped.
    expect(report.sessions.every((row) => row.usage !== undefined)).toBe(true)
    expect(ledgerReads).toBe(0)
    expect(report.cost.available).toBe(false)
    expect(report.cost.reason).toContain('includeCost: false')
    expect(report.sessions[0]?.cost?.reason).toContain('includeCost: false')
  })

  it('passes cost-meter money through as an estimate, with apiCost as the USD charge', async () => {
    const harness = fakeHarness({ logs: { 'session-1': FIRST_TURN }, prompt: 'commit' })
    const { driver, ctx } = makeDriver(harness)
    ctx.provide('costMeter', {
      getSessionCost: async (sessionId: string) => ({
        found: true,
        own: { id: sessionId, calls: 157, cost: 0.5342, apiCost: 0.5384, costCny: 3.5818 },
      }),
    })

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'queue it',
      mode: 'queue',
      wait: false,
    })

    expect(reply.session?.cost).toEqual({
      available: true,
      source: 'dsh-cost-meter',
      estimate: true,
      // `apiCost` is real money; `cost` is the list-price estimate, also USD.
      costUsd: 0.5384,
      costEstimateUsd: 0.5342,
      costCny: 3.5818,
      calls: 157,
    })
    expect(driver.describeCapabilities()).toMatchObject({ costMeter: true })

    const report = await driver.sessionUsage({ sessionId: 'session-1', limit: 20 })
    expect(report.sessions[0]?.cost?.costUsd).toBe(0.5384)
    expect(report.cost.costUsd).toBe(0.5384)
    expect(report.cost.estimate).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('usage capabilities', () => {
  it('reports no token source and no manageable sessions with no session service at all', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const driver = new DshDriver(ctx, () => testConfig({ usage: true }))

    expect(driver.describeCapabilities()).toMatchObject({ tokenUsage: false, costMeter: false })

    // A plugin-scoped receipt needs no listing — it knows the ids it created —
    // so the honest answer is an empty report that says why, not a refusal.
    const report = await driver.sessionUsage({ limit: 20 })
    expect(report.scope).toBe('pluginSessions')
    expect(report.sessions).toEqual([])
    expect(report.notes.some((note) => note.includes('could not list sessions'))).toBe(true)

    // The unscoped scan, which does need the listing, still refuses.
    const failure = await driver.sessionUsage({ all: true, limit: 20 }).catch((thrown: unknown) => thrown)
    expect(failure).toBeInstanceOf(DshCapabilityError)
    expect((failure as Error).message).toMatch(/no sessionController service/)
  })
})
