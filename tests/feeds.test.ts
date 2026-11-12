/**
 * The server-push feed collector.
 *
 * These tests drive the collector directly with a fake event bus, a fake driver
 * and a recording push surface: what matters here is the mapping from harness
 * events to resource notifications, the bounded per-session buffers, and the
 * resource reads a client gets after a notification. The wire-level
 * `subscriptions/listen` plumbing is pinned separately in
 * `push-notifications.test.ts`, and the 2025 GET stream in `legacy-http.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Config } from '../src/config.js'
import type {
  FeedDriver,
  FeedPushes,
  FeedResource,
} from '../src/mcp/feeds.js'
import {
  EventFeeds,
  JOBS_URI,
  SESSIONS_URI,
  jobUri,
  sessionAssistantUri,
  sessionEventsUri,
  sessionProjectionsUri,
  sessionStatusUri,
} from '../src/mcp/feeds.js'
import type { DshLogger } from '../src/dsh/types.js'
import type { SessionStatus, ShellJobPeek } from '../src/dsh/driver.js'
import { testConfig } from './harness.js'

const silentLog: DshLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** An event bus whose listeners a test can fire by name. */
function fakeBus(): {
  on: (name: string, listener: (...args: unknown[]) => void) => () => boolean
  emit: (name: string, ...args: unknown[]) => void
  listenerCount: (name: string) => number
  offAll: () => void
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => {
        set.delete(listener)
        return true
      }
    },
    emit: (name, ...args) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
    listenerCount: (name) => listeners.get(name)?.size ?? 0,
    offAll: () => listeners.clear(),
  }
}

/** A push surface that records published URIs. */
function fakePushes(subscribed = true): FeedPushes & { updates: string[] } {
  const updates: string[] = []
  return {
    updates,
    hasSubscribers: () => subscribed,
    resourceUpdated: (uri: string) => updates.push(uri),
    resourceUpdatedNow: (uri: string) => updates.push(uri),
  }
}

/** The driver slice the feeds read, with overridable values. */
function fakeDriver(overrides: Partial<FeedDriver> = {}): FeedDriver & {
  jobs: ShellJobPeek[]
  owned: Set<string>
} {
  const jobs: ShellJobPeek[] = []
  const owned = new Set<string>(['session-1'])
  const status: SessionStatus = {
    sessionId: 'session-1',
    running: false,
    openTurn: null,
    openStep: null,
    lastEventSeq: 3,
    lastEventAt: '2026-01-01T00:00:03.000Z',
    idleMs: 1_000,
    lastTurn: null,
    failure: null,
    stalled: false,
    logReadable: true,
    waitedMs: 0,
  }
  const driver: FeedDriver & { jobs: ShellJobPeek[]; owned: Set<string> } = {
    jobs,
    owned,
    ownsSession: (sessionId) => owned.has(sessionId),
    sessionStatus: async ({ sessionId }) => ({ ...status, sessionId }),
    listSessions: async () => ({
      sessions: [{ sessionId: 'session-1', updatedAt: 1, running: false, blank: false, cwd: '/tmp/repo' }],
      total: 1,
    }),
    sessionEventTail: async ({ sessionId }) => ({
      sessionId,
      asOfSeq: 7,
      events: [
        { seq: 5, type: 'tool/call', at: '2026-01-01T00:00:05.000Z', summary: 'called read' },
        { seq: 7, type: 'turn/end', at: '2026-01-01T00:00:07.000Z', summary: 'turn ended: completed' },
      ],
    }),
    sessionProjectionValues: async () => ({
      workingDirectory: '/tmp/repo/.agents/worktrees/wt',
      goal: { text: 'finish the feature' },
    }),
    listShellJobs: () => jobs,
    peekShellJob: (jobId) => jobs.find((job) => job.jobId === jobId),
    ...overrides,
  }
  return driver
}

function feedsWith(options: {
  pushes?: ReturnType<typeof fakePushes>
  driver?: ReturnType<typeof fakeDriver>
  bus?: ReturnType<typeof fakeBus>
  config?: Config
  intervalMs?: number
} = {}): {
  feeds: EventFeeds
  bus: ReturnType<typeof fakeBus>
  pushes: ReturnType<typeof fakePushes>
  driver: ReturnType<typeof fakeDriver>
} {
  const bus = options.bus ?? fakeBus()
  const pushes = options.pushes ?? fakePushes()
  const driver = options.driver ?? fakeDriver()
  const config = options.config ?? testConfig()
  const feeds = new EventFeeds({
    ctx: { on: bus.on },
    driver,
    pushes,
    log: silentLog,
    getConfig: () => config,
    ...(options.intervalMs === undefined ? {} : { jobPollIntervalMs: options.intervalMs }),
  })
  return { feeds, bus, pushes, driver }
}

function resource(feeds: EventFeeds, name: string): FeedResource {
  const found = feeds.resources.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`no feed resource ${name}`)
  return found
}

/** A shell job peek row for the job feed. */
function jobPeek(overrides: Partial<ShellJobPeek> = {}): ShellJobPeek {
  return {
    jobId: 'shell-1',
    command: 'npm test',
    status: 'running',
    startedAt: 1,
    exitCode: null,
    signal: null,
    pendingBytes: 0,
    tail: '',
    tailTruncated: false,
    ...overrides,
  }
}

describe('EventFeeds event mapping', () => {
  it('publishes the event, status and projection feeds for one visible session event', () => {
    const { feeds, bus, pushes } = feedsWith()
    const stop = feeds.start()
    bus.emit('session/event', { id: 'session-1' }, { type: 'turn/start', seq: 1, time: 1, data: {} })
    expect(pushes.updates).toContain(sessionEventsUri('session-1'))
    expect(pushes.updates).toContain(sessionStatusUri('session-1'))
    // turn/start is not one of the projection-moving event types.
    expect(pushes.updates).not.toContain(sessionProjectionsUri('session-1'))
    bus.emit('session/event', { id: 'session-1' }, { type: 'turn/end', seq: 2, time: 2, data: {} })
    expect(pushes.updates).toContain(sessionProjectionsUri('session-1'))
    stop()
  })

  it('ignores events when nobody is subscribed', () => {
    const { feeds, bus, pushes } = feedsWith({ pushes: fakePushes(false) })
    const stop = feeds.start()
    bus.emit('session/event', { id: 'session-1' }, { type: 'turn/start', seq: 1, time: 1, data: {} })
    expect(pushes.updates).toEqual([])
    stop()
  })

  it('drops notifications for a session outside an owned scope', () => {
    const driver = fakeDriver()
    const config: Config = { ...testConfig(), session: { ...testConfig().session, scope: 'owned' } }
    const { feeds, bus, pushes } = feedsWith({ driver, config })
    const stop = feeds.start()
    bus.emit('session/event', { id: 'not-owned' }, { type: 'turn/start', seq: 1, time: 1, data: {} })
    expect(pushes.updates).toEqual([])
    bus.emit('session/event', { id: 'session-1' }, { type: 'turn/start', seq: 1, time: 1, data: {} })
    expect(pushes.updates).toContain(sessionEventsUri('session-1'))
    stop()
  })

  it('publishes the session list for added/removed/activity/status events', () => {
    const { feeds, bus, pushes } = feedsWith()
    const stop = feeds.start()
    for (const name of ['api-session/added', 'api-session/removed', 'api-session/activity']) {
      pushes.updates.length = 0
      bus.emit(name, 'session-9')
      expect(pushes.updates, name).toContain(SESSIONS_URI)
    }
    pushes.updates.length = 0
    bus.emit('api-session/status', 'session-1', true)
    expect(pushes.updates).toContain(SESSIONS_URI)
    expect(pushes.updates).toContain(sessionStatusUri('session-1'))
    stop()
  })

  it('publishes the projection feed when the goal changes', () => {
    const { feeds, bus, pushes } = feedsWith()
    const stop = feeds.start()
    bus.emit('goal/changed', { agent: { id: 'session-1' }, change: {} })
    expect(pushes.updates).toContain(sessionProjectionsUri('session-1'))
    stop()
  })
})

describe('EventFeeds assistant buffer', () => {
  it('buffers live text, reasoning and tool deltas with monotonic seqs', async () => {
    const { feeds, bus, pushes } = feedsWith()
    const stop = feeds.start()
    const agent = { id: 'session-1' }
    bus.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', turn: 1, step: 0 },
    })
    bus.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', turn: 1, step: 0, chunk: { chunk: { type: 'text-delta', text: 'Hel' } } },
    })
    bus.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', turn: 1, step: 0, chunk: { chunk: { type: 'text-delta', text: 'lo' } } },
    })
    bus.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', turn: 1, step: 0, chunk: { chunk: { type: 'reasoning-delta', text: 'thinking' } } },
    })
    bus.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', turn: 1, step: 0, chunk: { chunk: { type: 'tool-call-delta', name: 'read' } } },
    })
    bus.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'end', turn: 1, step: 0, outcome: { kind: 'committed' } },
    })
    const payload = await resource(feeds, 'session-assistant').read(
      new URL(sessionAssistantUri('session-1')),
      { sessionId: 'session-1' },
    ) as { frames: { seq: number; kind: string; text?: string; done?: boolean }[] }
    expect(payload.frames.map((frame) => frame.kind)).toEqual([
      'start', 'text', 'text', 'reasoning', 'tool', 'end',
    ])
    expect(payload.frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(payload.frames.filter((frame) => frame.kind === 'text').map((frame) => frame.text)).toEqual(['Hel', 'lo'])
    expect(payload.frames.at(-1)?.done).toBe(true)
    expect(pushes.updates).toContain(sessionAssistantUri('session-1'))
    stop()
  })

  it('bounds a long stream and says so', async () => {
    const { feeds, bus } = feedsWith()
    const stop = feeds.start()
    const agent = { id: 'session-1' }
    for (let index = 0; index < 2_500; index += 1) {
      bus.emit('agent/assistant-stream', {
        agent,
        frame: { type: 'chunk', chunk: { chunk: { type: 'text-delta', text: `${index},` } } },
      })
    }
    const payload = await resource(feeds, 'session-assistant').read(
      new URL(sessionAssistantUri('session-1')),
      { sessionId: 'session-1' },
    ) as { asOfSeq: number; frames: unknown[]; truncated: boolean }
    expect(payload.asOfSeq).toBe(2_500)
    expect(payload.frames.length).toBeLessThanOrEqual(200)
    expect(payload.truncated).toBe(true)
    stop()
  })

  it('drops the buffer when the session is disposed', async () => {
    const { feeds, bus } = feedsWith()
    const stop = feeds.start()
    bus.emit('agent/assistant-stream', {
      agent: { id: 'session-1' },
      frame: { type: 'chunk', chunk: { chunk: { type: 'text-delta', text: 'x' } } },
    })
    bus.emit('session/disposed', { id: 'session-1' })
    const payload = await resource(feeds, 'session-assistant').read(
      new URL(sessionAssistantUri('session-1')),
      { sessionId: 'session-1' },
    ) as { frames: unknown[]; asOfSeq: number }
    expect(payload.frames).toEqual([])
    expect(payload.asOfSeq).toBe(0)
    stop()
  })
})

describe('EventFeeds resources', () => {
  it('reads the session list', async () => {
    const { feeds } = feedsWith()
    const payload = await resource(feeds, 'sessions').read(new URL(SESSIONS_URI), {}) as {
      sessions: { sessionId: string }[]
      total: number
    }
    expect(payload.total).toBe(1)
    expect(payload.sessions[0]?.sessionId).toBe('session-1')
  })

  it('reads the projected event tail', async () => {
    const { feeds } = feedsWith()
    const payload = await resource(feeds, 'session-events').read(
      new URL(sessionEventsUri('session-1')),
      { sessionId: 'session-1' },
    ) as { asOfSeq: number; events: { seq: number }[] }
    expect(payload.asOfSeq).toBe(7)
    expect(payload.events.at(-1)?.seq).toBe(7)
  })

  it('reads status and projections through the driver', async () => {
    const { feeds } = feedsWith()
    const status = await resource(feeds, 'session-status').read(
      new URL(sessionStatusUri('session-1')),
      { sessionId: 'session-1' },
    ) as { sessionId: string }
    expect(status.sessionId).toBe('session-1')
    const projections = await resource(feeds, 'session-projections').read(
      new URL(sessionProjectionsUri('session-1')),
      { sessionId: 'session-1' },
    ) as { workingDirectory: string; goal: unknown }
    expect(projections.workingDirectory).toBe('/tmp/repo/.agents/worktrees/wt')
    expect(projections.goal).toEqual({ text: 'finish the feature' })
  })

  it('reads jobs and one job tail, and refuses an unknown job', async () => {
    const driver = fakeDriver()
    driver.jobs.push(jobPeek({ tail: 'partial output' }))
    const { feeds } = feedsWith({ driver })
    const jobs = await resource(feeds, 'jobs').read(new URL(JOBS_URI), {}) as { jobs: { jobId: string }[] }
    expect(jobs.jobs.map((job) => job.jobId)).toEqual(['shell-1'])
    const job = await resource(feeds, 'job').read(new URL(jobUri('shell-1')), { jobId: 'shell-1' }) as {
      tail: string
      status: string
    }
    expect(job.tail).toBe('partial output')
    expect(job.status).toBe('running')
    await expect(resource(feeds, 'job').read(new URL(jobUri('missing')), { jobId: 'missing' }))
      .rejects.toThrow(/unknown background job/)
  })

  it('decodes an escaped session id from a template variable', async () => {
    const { feeds } = feedsWith()
    const payload = await resource(feeds, 'session-events').read(
      new URL(sessionEventsUri('a/b c')),
      { sessionId: 'a%2Fb%20c' },
    ) as { sessionId: string }
    expect(payload.sessionId).toBe('a/b c')
  })
})

describe('EventFeeds shell-job polling', () => {
  it('publishes the jobs feed and a changed job tail while subscribed', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver()
      driver.jobs.push(jobPeek({ tail: 'one' }))
      const { feeds, pushes } = feedsWith({ driver, intervalMs: 100 })
      const stop = feeds.start()
      await vi.advanceTimersByTimeAsync(120)
      expect(pushes.updates).toContain(JOBS_URI)
      expect(pushes.updates).toContain(jobUri('shell-1'))
      pushes.updates.length = 0
      driver.jobs[0] = jobPeek({ tail: 'one two', status: 'completed', finishedAt: 5 })
      await vi.advanceTimersByTimeAsync(120)
      expect(pushes.updates).toContain(jobUri('shell-1'))
      pushes.updates.length = 0
      await vi.advanceTimersByTimeAsync(120)
      expect(pushes.updates).toEqual([])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not poll when nobody is subscribed', async () => {
    vi.useFakeTimers()
    try {
      const driver = fakeDriver()
      driver.jobs.push(jobPeek({ tail: 'one' }))
      const { feeds, pushes } = feedsWith({ driver, pushes: fakePushes(false), intervalMs: 100 })
      const stop = feeds.start()
      await vi.advanceTimersByTimeAsync(500)
      expect(pushes.updates).toEqual([])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('EventFeeds lifecycle', () => {
  it('unsubscribes and stops polling on dispose', async () => {
    const bus = fakeBus()
    const { feeds, pushes } = feedsWith({ bus })
    const stop = feeds.start()
    bus.emit('api-session/added', 'session-1')
    expect(pushes.updates.length).toBeGreaterThan(0)
    stop()
    expect(feeds.active).toBe(false)
    expect(bus.listenerCount('session/event')).toBe(0)
    pushes.updates.length = 0
    bus.emit('api-session/added', 'session-1')
    expect(pushes.updates).toEqual([])
  })
})
