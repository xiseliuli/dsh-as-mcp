/**
 * Worktree-per-session, archive/pin, and the session views folded from projections.
 *
 * These tests pin the driver's observable contract against the services it
 * composes: which service sees which call, in which order, and what reaches the
 * caller. The fakes model the preconditions that made the implementation what it
 * is:
 *
 * - A worktree operation is scoped by a live agent. An already-live agent is
 *   preferred (resolving one is not a read), and a `resolveAgent` error is a
 *   reportable failure, not something to paper over by calling the service
 *   without a scope.
 * - `session_create { worktree }` commits the session first, then creates and
 *   enters the checkout; a failing checkout leaves the session usable and is
 *   reported as `worktreeError`. A profile with no worktree service is refused
 *   before a session exists, so a doomed request cannot leave an orphan row.
 * - The harness's worktree service has no lock of its own, so one session must
 *   never have two worktree operations in flight; different sessions may.
 * - `session_status`/`session_list` fold projections only where the profile can
 *   report them, and `session_list { includeWorktree }` must prefer the listing's
 *   own hints over one read per row.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { DshDriver } from '../src/dsh/driver.js'
import { testConfig } from './harness.js'

type AnyRecord = Record<string, unknown>

const SESSION = 'session-1'
/** The agent a cold session resolves to through `sessionController.resolveAgent`. */
const COLD_AGENT = { id: 'agent-cold' }
/** The agent `ctx.agents.get()` reports for a live session. */
const LIVE_AGENT = { id: 'agent-live' }

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A complete config, section by section overridable. */
function configWith(overrides: Partial<Config> = {}): Config {
  const base = testConfig()
  return {
    ...base,
    ...overrides,
    http: { ...base.http, ...overrides.http },
    auth: { ...base.auth, ...overrides.auth },
    tools: { ...base.tools, ...overrides.tools },
    agentTools: { ...base.agentTools, ...overrides.agentTools },
    session: { ...base.session, ...overrides.session },
    limits: { ...base.limits, ...overrides.limits },
    approval: { ...base.approval, ...overrides.approval },
  }
}

/** Build a driver over the services a test supplies; absent ones stay unmounted. */
function makeDriver(options: {
  controller?: AnyRecord
  registry?: AnyRecord | null
  worktrees?: AnyRecord | null
  agents?: AnyRecord
  query?: AnyRecord
  config?: Partial<Config>
} = {}): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  if (options.controller !== undefined) ctx.provide('sessionController', options.controller)
  if (options.registry !== undefined && options.registry !== null) ctx.provide('workspaceRegistry', options.registry)
  if (options.worktrees !== undefined && options.worktrees !== null) ctx.provide('worktrees', options.worktrees)
  if (options.agents !== undefined) ctx.provide('agents', options.agents)
  if (options.query !== undefined) ctx.provide('sessionQuery', options.query)
  return { driver: new DshDriver(ctx, () => configWith(options.config)), ctx }
}

/**
 * A `sessionController` double.
 *
 * `resolveAgent` is present by default because a worktree operation needs the
 * bridge; a test about the missing method passes `resolveAgent: undefined`.
 */
function fakeController(overrides: AnyRecord = {}): AnyRecord & {
  creates: AnyRecord[]
  resolved: string[]
} {
  const creates: AnyRecord[] = []
  const resolved: string[] = []
  const controller: AnyRecord & { creates: AnyRecord[]; resolved: string[] } = {
    creates,
    resolved,
    create: async (request: AnyRecord) => {
      creates.push(request)
      return { sessionId: SESSION }
    },
    list: async () => ({ items: [] }),
    selectModel: async (request: AnyRecord) => ({
      selected: { provider: request.provider, model: request.model },
    }),
    resolveAgent: async (sessionId: string) => {
      resolved.push(sessionId)
      return { agent: COLD_AGENT }
    },
  }
  return Object.assign(controller, overrides)
}

/** The four fields the harness's own service reports for a created worktree. */
function worktreeRecord(name: string): {
  path: string
  branch: string
  baseCommit: string
  repositoryRoot: string
} {
  return {
    path: `/repo/.agents/worktrees/${name}`,
    branch: name,
    baseCommit: 'a'.repeat(40),
    repositoryRoot: '/repo',
  }
}

interface WorktreeCall {
  readonly agent: unknown
  readonly request: AnyRecord
  readonly signal?: AbortSignal
}

/**
 * A `ctx.worktrees` double recording the calls it receives.
 *
 * The overrides model the real service's failure modes (existing branch, removed
 * checkout) instead of accepting anything.
 */
function worktreeDouble(handler: {
  create?: (agent: unknown, request: AnyRecord, signal?: AbortSignal) => Promise<unknown> | unknown
  restore?: (agent: unknown, request: AnyRecord, signal?: AbortSignal) => Promise<unknown> | unknown
} = {}): { service: AnyRecord; creates: WorktreeCall[]; restores: WorktreeCall[] } {
  const creates: WorktreeCall[] = []
  const restores: WorktreeCall[] = []
  const service = {
    create: async (agent: unknown, request: AnyRecord, signal?: AbortSignal) => {
      creates.push({ agent, request, signal })
      return await (handler.create?.(agent, request, signal) ?? worktreeRecord('wt-1'))
    },
    restore: async (agent: unknown, request: AnyRecord, signal?: AbortSignal) => {
      restores.push({ agent, request, signal })
      return await (handler.restore?.(agent, request, signal)
        ?? { path: request.path, branchRecreated: false })
    },
  }
  return { service, creates, restores }
}

/** A `workspaceRegistry` double knowing one workspace (`ws-1` → `/repo`). */
function fakeRegistry(overrides: AnyRecord = {}): AnyRecord {
  return {
    get: (id: string) => (id === 'ws-1' ? { id: 'ws-1', path: '/repo' } : undefined),
    list: () => [],
    resolveByPath: async () => undefined,
    ...overrides,
  }
}

/** Resolve once `predicate` holds, failing the test rather than hanging forever. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached before the deadline')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('session_create with a worktree request', () => {
  it('creates the session in the workspace first, then creates and enters the worktree', async () => {
    const order: string[] = []
    const controller = fakeController()
    const originalCreate = controller.create as (request: AnyRecord) => Promise<unknown>
    controller.create = async (request: AnyRecord) => {
      order.push('session')
      return await originalCreate(request)
    }
    const worktrees = worktreeDouble({
      create: async (agent, request) => {
        order.push('worktree')
        expect(agent).toBe(COLD_AGENT)
        expect(request).toEqual({ name: 'wt-1', from: 'main' })
        return worktreeRecord('wt-1')
      },
    })
    const { driver } = makeDriver({ controller, registry: fakeRegistry(), worktrees: worktrees.service })

    const created = await driver.createSession({
      workspaceId: 'ws-1',
      worktree: { name: 'wt-1', from: 'main' },
    })

    // The session must exist before its checkout can be created: creation commits
    // the durable header (which keeps the workspace grouping), the worktree only
    // moves the live working directory.
    expect(order).toEqual(['session', 'worktree'])
    expect(controller.creates).toEqual([{ workspaceId: 'ws-1' }])
    expect(controller.resolved).toEqual([SESSION])
    expect(worktrees.creates[0]?.agent).toBe(COLD_AGENT)
    expect(created).toMatchObject({
      sessionId: SESSION,
      cwd: '/repo',
      worktree: { ...worktreeRecord('wt-1'), from: 'main' },
      workingDirectory: worktreeRecord('wt-1').path,
    })
    expect(created.worktreeError).toBeUndefined()
  })

  it('lets the harness generate the branch when the caller passes no name or from', async () => {
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({ controller: fakeController(), registry: fakeRegistry(), worktrees: worktrees.service })

    const created = await driver.createSession({ workspaceId: 'ws-1', worktree: {} })

    // The request carries neither key: the harness's own generator/first-parent
    // defaults apply, and `from: null` says "the source HEAD" rather than echoing
    // a revision nobody named.
    expect(worktrees.creates[0]?.request).toEqual({})
    expect(created.worktree?.from).toBeNull()
  })

  it('reports worktreeError instead of failing a session whose worktree could not be created', async () => {
    const worktrees = worktreeDouble({
      create: async () => {
        throw new Error('git worktree add failed: branch "wt-1" already exists')
      },
    })
    const controller = fakeController()
    const { driver } = makeDriver({ controller, registry: fakeRegistry(), worktrees: worktrees.service })

    const created = await driver.createSession({ workspaceId: 'ws-1', worktree: { name: 'wt-1' } })

    // The session itself succeeded and is usable in the workspace; failing the
    // whole call would tell the caller nothing happened while a live session sat
    // in the DSH UI.
    expect(controller.creates).toHaveLength(1)
    expect(created.sessionId).toBe(SESSION)
    expect(created.worktree).toBeUndefined()
    expect(created.workingDirectory).toBeUndefined()
    expect(created.worktreeError).toMatch(/the session was created, but its worktree was not/)
    expect(created.worktreeError).toMatch(/branch "wt-1" already exists/)
  })

  it('refuses the request before creating a session when the profile has no worktrees service', async () => {
    const controller = fakeController()
    const { driver } = makeDriver({ controller, registry: fakeRegistry(), worktrees: null })

    await expect(driver.createSession({ workspaceId: 'ws-1', worktree: {} }))
      .rejects.toThrow(/provides no worktrees service/)
    // Pre-validation exists to avoid an orphan session nobody asked for.
    expect(controller.creates).toEqual([])
  })
})

describe('DshDriver.createWorktree', () => {
  it('calls the service with the resolved agent and the exact request, and reports the record', async () => {
    const controller = fakeController()
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({ controller, worktrees: worktrees.service })
    const signal = new AbortController().signal

    const reply = await driver.createWorktree({
      sessionId: SESSION,
      name: 'wt-1',
      from: 'HEAD~2',
      signal,
    })

    // No live agent in this profile: the controller's bridge is the scope.
    expect(controller.resolved).toEqual([SESSION])
    expect(worktrees.creates[0]?.agent).toBe(COLD_AGENT)
    expect(worktrees.creates[0]?.request).toEqual({ name: 'wt-1', from: 'HEAD~2' })
    // The request's abort signal must reach the service: that is what bounds a
    // Git command to the caller's lifetime.
    expect(worktrees.creates[0]?.signal).toBe(signal)
    expect(reply).toEqual({ sessionId: SESSION, ...worktreeRecord('wt-1'), from: 'HEAD~2' })
  })

  it('reports from: null and sends no name/from keys when the caller named neither', async () => {
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({ controller: fakeController(), worktrees: worktrees.service })

    const reply = await driver.createWorktree({ sessionId: SESSION })

    expect(worktrees.creates[0]?.request).toEqual({})
    expect(reply.from).toBeNull()
  })

  it('prefers the live agent and does not resolve one', async () => {
    const controller = fakeController()
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({
      controller,
      agents: { get: () => LIVE_AGENT },
      worktrees: worktrees.service,
    })

    await driver.createWorktree({ sessionId: SESSION })

    // `resolveAgent` on a cold session resumes it (opens its log, takes the
    // single-writer handle); a live agent is the same object without that cost.
    expect(controller.resolved).toEqual([])
    expect(worktrees.creates[0]?.agent).toBe(LIVE_AGENT)
  })

  it('reports a session it cannot scope and does not call the worktree service', async () => {
    const controller = fakeController({
      resolveAgent: async () => ({ error: new Error('session/writer-held: another client holds it') }),
    })
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({ controller, worktrees: worktrees.service })

    const error = await driver.createWorktree({ sessionId: SESSION }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/could not be scoped to an agent/)
    expect((error as Error).message).toMatch(/session\/writer-held/)
    // Never run the Git command under someone else's scope: that would ignore the
    // session's own file policy.
    expect(worktrees.creates).toEqual([])
  })

  it('names the missing resolveAgent capability instead of failing obscurely', async () => {
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({
      controller: fakeController({ resolveAgent: undefined }),
      worktrees: worktrees.service,
    })

    await expect(driver.createWorktree({ sessionId: SESSION }))
      .rejects.toThrow(/sessionController\.resolveAgent is missing/)
    expect(worktrees.creates).toEqual([])
  })

  it('refuses to move a session that is running a turn', async () => {
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({
      controller: fakeController(),
      agents: { get: () => ({ status: 'running' }) },
      worktrees: worktrees.service,
    })

    const error = await driver.createWorktree({ sessionId: SESSION }).catch((caught: unknown) => caught)

    // Switching the working directory under an open turn would move the ground
    // beneath work in flight; the refusal names both ways out.
    expect((error as Error).message).toMatch(/has a running turn/)
    expect((error as Error).message).toMatch(/session_cancel/)
    expect(worktrees.creates).toEqual([])
  })

  it('wraps a create failure with the session and keeps the cause', async () => {
    const cause = new Error('branch "wt-1" already exists')
    const worktrees = worktreeDouble({ create: async () => { throw cause } })
    const { driver } = makeDriver({ controller: fakeController(), worktrees: worktrees.service })

    const error = await driver.createWorktree({ sessionId: SESSION }).catch((caught: unknown) => caught)

    expect((error as Error).message)
      .toBe(`could not create a worktree for session ${SESSION}: branch "wt-1" already exists`)
    expect((error as Error).cause).toBe(cause)
  })

  it('names the missing worktrees service before resolving an agent', async () => {
    const controller = fakeController()
    const { driver } = makeDriver({ controller, worktrees: null })

    await expect(driver.createWorktree({ sessionId: SESSION }))
      .rejects.toThrow(/provides no worktrees service/)
    expect(controller.resolved).toEqual([])
  })

  it('refuses a session the ownership scope does not cover, before touching the service', async () => {
    const archive = worktreeDouble()
    const controller = fakeController()
    const { driver } = makeDriver({
      controller,
      worktrees: archive.service,
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })

    await expect(driver.createWorktree({ sessionId: 'someone-elses-session' }))
      .rejects.toThrow(/was not created by this endpoint/)
    expect(archive.creates).toEqual([])
  })
})

describe('worktree operation serialization', () => {
  it('waits for the previous operation on the same session', async () => {
    const started: string[] = []
    let releaseFirst: (() => void) | undefined
    const worktrees = worktreeDouble({
      create: async (_agent, request) => {
        const name = request.name as string
        started.push(name)
        if (name === 'first') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        return worktreeRecord(name)
      },
    })
    const { driver } = makeDriver({ controller: fakeController(), worktrees: worktrees.service })

    const first = driver.createWorktree({ sessionId: SESSION, name: 'first' })
    await until(() => started.length === 1)
    const second = driver.createWorktree({ sessionId: SESSION, name: 'second' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    // The service has no lock of its own: two creates would race Git's locks and
    // the working-directory commit.
    expect(started).toEqual(['first'])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(started).toEqual(['first', 'second'])
  })

  it('still runs operations on different sessions concurrently', async () => {
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const worktrees = worktreeDouble({
      create: async (_agent, request) => {
        const name = request.name as string
        started.push(name)
        await new Promise<void>((resolve) => {
          releases.set(name, resolve)
        })
        return worktreeRecord(name)
      },
    })
    const { driver } = makeDriver({
      controller: fakeController({
        resolveAgent: async (sessionId: string) => ({ agent: { id: `agent-${sessionId}` } }),
      }),
      worktrees: worktrees.service,
    })

    const first = driver.createWorktree({ sessionId: 'session-a', name: 'a' })
    const second = driver.createWorktree({ sessionId: 'session-b', name: 'b' })
    await until(() => started.length === 2)

    // Per-session, not global: two sessions must not block each other.
    expect([...started].sort()).toEqual(['a', 'b'])
    for (const release of releases.values()) release()
    await Promise.all([first, second])
  })
})

describe('DshDriver.restoreWorktree', () => {
  it('calls the service with the recorded worktree and reports the branch outcome', async () => {
    const controller = fakeController()
    const worktrees = worktreeDouble({
      restore: async (_agent, request) => ({ path: request.path, branchRecreated: true }),
    })
    const { driver } = makeDriver({ controller, worktrees: worktrees.service })
    const signal = new AbortController().signal
    const record = worktreeRecord('wt-1')

    const reply = await driver.restoreWorktree({ sessionId: SESSION, ...record, signal })

    expect(controller.resolved).toEqual([SESSION])
    expect(worktrees.restores[0]?.agent).toBe(COLD_AGENT)
    expect(worktrees.restores[0]?.request).toEqual(record)
    expect(worktrees.restores[0]?.signal).toBe(signal)
    expect(reply).toEqual({ sessionId: SESSION, path: record.path, branchRecreated: true })
  })

  it('wraps a restore failure with the session', async () => {
    const worktrees = worktreeDouble({
      restore: async () => {
        throw new Error('fatal: invalid reference')
      },
    })
    const { driver } = makeDriver({ controller: fakeController(), worktrees: worktrees.service })

    await expect(driver.restoreWorktree({ sessionId: SESSION, ...worktreeRecord('wt-1') }))
      .rejects.toThrow(/could not restore the worktree of session session-1: fatal: invalid reference/)
  })

  it('refuses to restore the worktree of a session with a running turn', async () => {
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({
      controller: fakeController(),
      agents: { get: () => ({ status: 'running' }) },
      worktrees: worktrees.service,
    })

    await expect(driver.restoreWorktree({ sessionId: SESSION, ...worktreeRecord('wt-1') }))
      .rejects.toThrow(/before restoring its worktree/)
    expect(worktrees.restores).toEqual([])
  })

  it('refuses a session the ownership scope does not cover, before touching the service', async () => {
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({
      controller: fakeController(),
      worktrees: worktrees.service,
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })

    await expect(driver.restoreWorktree({ sessionId: 'someone-elses-session', ...worktreeRecord('wt-1') }))
      .rejects.toThrow(/was not created by this endpoint/)
    expect(worktrees.restores).toEqual([])
  })
})

describe('worktree state in session_status', () => {
  it('folds the live working directory and the forge worktree record', async () => {
    const record = { ...worktreeRecord('wt-1'), from: 'main' }
    const projectionReads: unknown[] = []
    const controller = fakeController({
      projections: async (request: unknown) => {
        projectionReads.push(request)
        return {
          kind: 'sequenced',
          asOfSeq: 7,
          values: { workingDirectory: record.path, forgeWorktree: record },
        }
      },
    })
    const { driver } = makeDriver({ controller })

    const status = await driver.sessionStatus({ sessionId: SESSION })

    expect(projectionReads).toEqual([{ sessionId: SESSION }])
    expect(status.workingDirectory).toBe(record.path)
    expect(status.worktree).toEqual(record)
  })

  it('reports a null working directory and no worktree record when the projection has none', async () => {
    const controller = fakeController({
      projections: async () => ({ kind: 'sequenced', asOfSeq: 1, values: { workingDirectory: null } }),
    })
    const { driver } = makeDriver({ controller })

    const status = await driver.sessionStatus({ sessionId: SESSION })

    // `null` is the harness saying "no directory yet"; absent would mean "not
    // reported". The two must not be conflated.
    expect(status.workingDirectory).toBeNull()
    expect(status.worktree).toBeUndefined()
  })

  it('omits both fields when the profile has no projection reader', async () => {
    const controller = fakeController()
    const { driver } = makeDriver({ controller })

    const status = await driver.sessionStatus({ sessionId: SESSION })

    expect(status).not.toHaveProperty('workingDirectory')
    expect(status).not.toHaveProperty('worktree')
    // The rest of the report is unaffected by the missing diagnostic.
    expect(status.sessionId).toBe(SESSION)
    expect(status.logReadable).toBe(false)
  })

  it('falls back to observeSession and disposes the lease when the controller has no projections', async () => {
    let disposed = false
    const observed: unknown[] = []
    const controller = fakeController()
    const query = {
      readSession: async () => ({ session: { id: SESSION }, inheritedEventCount: 0, events: [] }),
      observeSession: async (sessionId: string, options: unknown) => {
        observed.push({ sessionId, options })
        return {
          source: 'prepared',
          header: { id: sessionId },
          inheritedEventCount: 0,
          events: [],
          cursor: 0,
          projections: { asOfSeq: 2, values: { workingDirectory: '/repo/.agents/worktrees/wt-2' } },
          [Symbol.dispose]: () => {
            disposed = true
          },
        }
      },
    }
    const { driver } = makeDriver({ controller, query })

    const status = await driver.sessionStatus({ sessionId: SESSION })

    expect(observed).toEqual([{ sessionId: SESSION, options: { projectionMode: 'all' } }])
    expect(status.workingDirectory).toBe('/repo/.agents/worktrees/wt-2')
    // Not releasing the lease pins the prepared-session cache, so the fallback
    // must dispose it immediately.
    expect(disposed).toBe(true)
  })

  it('reports a changed status when the session enters a worktree during a wait', async () => {
    let directory = '/repo'
    const controller = fakeController({
      projections: async () => ({ kind: 'sequenced', asOfSeq: 1, values: { workingDirectory: directory } }),
    })
    const { driver, ctx } = makeDriver({ controller })

    const pending = driver.sessionStatus({ sessionId: SESSION, waitMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    directory = '/repo/.agents/worktrees/wt-1'
    // Wake the held wait the way the harness does: a post-commit session event.
    ;(ctx as unknown as { emit(name: string, ...args: unknown[]): void })
      .emit('session/event', { id: SESSION }, { type: 'working-directory/change' })

    const status = await pending
    // A held status poll is how a supervisor learns the directory moved; if the
    // signature ignored it the caller would wait out the whole bound.
    expect(status.changed).toBe(true)
    expect(status.workingDirectory).toBe('/repo/.agents/worktrees/wt-1')
    expect(status.waitedMs).toBeLessThan(5_000)
  })
})

describe('worktree state in session_list', () => {
  it('folds the listing\'s projection hints without a per-session read', async () => {
    const projectionReads: unknown[] = []
    const forge = worktreeRecord('b')
    const controller = fakeController({
      list: async () => ({
        items: [
          {
            sessionId: 'a',
            running: false,
            blank: false,
            updatedAt: 2,
            projections: {
              kind: 'sequenced',
              asOfSeq: 3,
              values: { workingDirectory: '/repo/.agents/worktrees/a' },
            },
          },
          {
            sessionId: 'b',
            running: false,
            blank: false,
            updatedAt: 1,
            projections: {
              kind: 'cached',
              asOfSeq: 1,
              values: { workingDirectory: null, forgeWorktree: forge },
            },
          },
        ],
      }),
      projections: async (request: unknown) => {
        projectionReads.push(request)
        return null
      },
    })
    const { driver } = makeDriver({ controller })

    const listed = await driver.listSessions(20, { includeWorktree: true })

    expect(listed.sessions[0]).toMatchObject({
      sessionId: 'a',
      workingDirectory: '/repo/.agents/worktrees/a',
    })
    expect(listed.sessions[1]?.workingDirectory).toBeNull()
    expect(listed.sessions[1]?.worktree).toMatchObject({ ...forge, from: null })
    // The summary already carries the values; one exact read per row would be
    // pure cost on the common 0.2.2 path.
    expect(projectionReads).toEqual([])
  })

  it('reads projections per session only when the listing carries no hints', async () => {
    const projectionReads: { sessionId: string }[] = []
    const controller = fakeController({
      list: async () => ({
        items: [
          { sessionId: 'a', running: false, blank: false, updatedAt: 2 },
          { sessionId: 'b', running: false, blank: false, updatedAt: 1 },
        ],
      }),
      projections: async (request: { sessionId: string }) => {
        projectionReads.push(request)
        return {
          kind: 'sequenced',
          asOfSeq: 1,
          values: { workingDirectory: `/worktrees/${request.sessionId}` },
        }
      },
    })
    const { driver } = makeDriver({ controller })

    const listed = await driver.listSessions(20, { includeWorktree: true })

    expect(projectionReads).toEqual([{ sessionId: 'a' }, { sessionId: 'b' }])
    expect(listed.sessions.map((session) => session.workingDirectory))
      .toEqual(['/worktrees/a', '/worktrees/b'])
  })

  it('does not read projections unless includeWorktree is asked', async () => {
    let reads = 0
    const controller = fakeController({
      list: async () => ({
        items: [{
          sessionId: 'a',
          running: false,
          blank: false,
          updatedAt: 1,
          projections: { kind: 'sequenced', asOfSeq: 1, values: { workingDirectory: '/worktrees/a' } },
        }],
      }),
      projections: async () => {
        reads += 1
        return null
      },
    })
    const { driver } = makeDriver({ controller })

    const listed = await driver.listSessions(20)

    expect(reads).toBe(0)
    expect(listed.sessions[0]).not.toHaveProperty('workingDirectory')
    expect(listed.sessions[0]).not.toHaveProperty('worktree')
  })

  it('falls back to observeSession when the controller has no projection read', async () => {
    let disposed = false
    const controller = fakeController({
      list: async () => ({
        items: [{ sessionId: 'a', running: false, blank: false, updatedAt: 1 }],
      }),
    })
    const query = {
      readSession: async () => ({ session: { id: 'a' }, inheritedEventCount: 0, events: [] }),
      observeSession: async (sessionId: string) => ({
        source: 'prepared',
        header: { id: sessionId },
        inheritedEventCount: 0,
        events: [],
        cursor: 0,
        projections: { asOfSeq: 4, values: { workingDirectory: '/worktrees/a' } },
        [Symbol.dispose]: () => {
          disposed = true
        },
      }),
    }
    const { driver } = makeDriver({ controller, query })

    const listed = await driver.listSessions(20, { includeWorktree: true })

    expect(listed.sessions[0]?.workingDirectory).toBe('/worktrees/a')
    expect(disposed).toBe(true)
  })

  it('reports archived and pinned flags from the registry sets', async () => {
    const controller = fakeController({
      list: async () => ({
        items: [
          { sessionId: 'archived-one', running: false, blank: false, updatedAt: 3 },
          { sessionId: 'pinned-one', running: false, blank: false, updatedAt: 2 },
          { sessionId: 'plain-one', running: false, blank: false, updatedAt: 1 },
        ],
      }),
    })
    const { driver } = makeDriver({
      controller,
      registry: fakeRegistry({ archivedSessionIds: ['archived-one'], pinnedSessionIds: ['pinned-one'] }),
    })

    const listed = await driver.listSessions(20)

    const flags = new Map(listed.sessions.map((session) => [
      session.sessionId,
      { archived: session.archived, pinned: session.pinned },
    ]))
    expect(flags.get('archived-one')).toEqual({ archived: true, pinned: false })
    expect(flags.get('pinned-one')).toEqual({ archived: false, pinned: true })
    expect(flags.get('plain-one')).toEqual({ archived: false, pinned: false })
  })

  it('omits archive and pin flags when the registry exposes no sets', async () => {
    const controller = fakeController({
      list: async () => ({
        items: [{ sessionId: 'a', running: false, blank: false, updatedAt: 1 }],
      }),
    })
    const { driver } = makeDriver({ controller, registry: fakeRegistry() })

    const listed = await driver.listSessions(20)

    // An older host has no archive feature at all: claiming `false` there would be
    // a guess, so the fields are absent rather than wrong.
    expect(listed.sessions[0]).not.toHaveProperty('archived')
    expect(listed.sessions[0]).not.toHaveProperty('pinned')
  })
})

describe('DshDriver.archiveSession', () => {
  it('archives and reports the new state, passing stopActivity only when asked', async () => {
    const calls: unknown[][] = []
    const registry = fakeRegistry({
      archiveSession: async (sessionId: string, options: unknown) => {
        calls.push([sessionId, options])
      },
    })
    const { driver } = makeDriver({ controller: fakeController(), registry })

    await expect(driver.archiveSession({ sessionId: SESSION }))
      .resolves.toEqual({ sessionId: SESSION, archived: true })
    await expect(driver.archiveSession({ sessionId: SESSION, stopActivity: true }))
      .resolves.toEqual({ sessionId: SESSION, archived: true })

    // Stopping work is something the caller has to ask for; it must not be
    // implied by the archive request itself.
    expect(calls).toEqual([[SESSION, {}], [SESSION, { stopActivity: true }]])
  })

  it('explains how to archive a session whose work is still running', async () => {
    const registry = fakeRegistry({
      archiveSession: async () => {
        throw new Error('session has running work')
      },
    })
    const { driver } = makeDriver({ controller: fakeController(), registry })

    const plain = await driver.archiveSession({ sessionId: SESSION }).catch((caught: unknown) => caught)
    expect((plain as Error).message).toMatch(/could not archive session session-1: session has running work/)
    expect((plain as Error).message).toMatch(/stopActivity: true/)

    // With the flag the advice is not repeated: the caller already chose it.
    const withFlag = await driver
      .archiveSession({ sessionId: SESSION, stopActivity: true })
      .catch((caught: unknown) => caught)
    expect((withFlag as Error).message).not.toMatch(/If it still has running work/)
  })

  it('names the missing archive capability', async () => {
    const { driver } = makeDriver({ controller: fakeController(), registry: fakeRegistry() })

    await expect(driver.archiveSession({ sessionId: SESSION }))
      .rejects.toThrow(/cannot archive sessions \(workspaceRegistry\.archiveSession is missing\)/)
    await expect(driver.unarchiveSession({ sessionId: SESSION }))
      .rejects.toThrow(/cannot unarchive sessions \(workspaceRegistry\.unarchiveSession is missing\)/)
  })

  it('names the missing workspace registry service', async () => {
    const { driver } = makeDriver({ controller: fakeController() })

    await expect(driver.archiveSession({ sessionId: SESSION }))
      .rejects.toThrow(/provides no workspaceRegistry service/)
  })

  it('refuses an unowned session before touching the registry', async () => {
    const calls: unknown[] = []
    const registry = fakeRegistry({
      archiveSession: async (sessionId: string) => {
        calls.push(sessionId)
      },
    })
    const { driver } = makeDriver({
      controller: fakeController(),
      registry,
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })

    await expect(driver.archiveSession({ sessionId: 'someone-elses-session' }))
      .rejects.toThrow(/was not created by this endpoint/)
    expect(calls).toEqual([])
  })
})

describe('DshDriver.unarchiveSession / pinSession / unpinSession', () => {
  it('forwards the session id and reports the new state', async () => {
    const calls: { action: string; sessionId: string }[] = []
    const registry = fakeRegistry({
      unarchiveSession: async (sessionId: string) => {
        calls.push({ action: 'unarchive', sessionId })
      },
      pinSession: async (sessionId: string) => {
        calls.push({ action: 'pin', sessionId })
      },
      unpinSession: async (sessionId: string) => {
        calls.push({ action: 'unpin', sessionId })
      },
    })
    const { driver } = makeDriver({ controller: fakeController(), registry })

    await expect(driver.unarchiveSession({ sessionId: SESSION }))
      .resolves.toEqual({ sessionId: SESSION, archived: false })
    await expect(driver.pinSession({ sessionId: SESSION }))
      .resolves.toEqual({ sessionId: SESSION, pinned: true })
    await expect(driver.unpinSession({ sessionId: SESSION }))
      .resolves.toEqual({ sessionId: SESSION, pinned: false })

    expect(calls).toEqual([
      { action: 'unarchive', sessionId: SESSION },
      { action: 'pin', sessionId: SESSION },
      { action: 'unpin', sessionId: SESSION },
    ])
  })

  it('names the missing pin capability', async () => {
    const { driver } = makeDriver({ controller: fakeController(), registry: fakeRegistry() })

    await expect(driver.pinSession({ sessionId: SESSION }))
      .rejects.toThrow(/cannot pin sessions \(workspaceRegistry\.pinSession is missing\)/)
    await expect(driver.unpinSession({ sessionId: SESSION }))
      .rejects.toThrow(/cannot unpin sessions \(workspaceRegistry\.unpinSession is missing\)/)
  })

  it('wraps a pin failure with the session', async () => {
    const registry = fakeRegistry({
      pinSession: async () => {
        throw new Error('session is archived')
      },
    })
    const { driver } = makeDriver({ controller: fakeController(), registry })

    await expect(driver.pinSession({ sessionId: SESSION }))
      .rejects.toThrow(/could not pin session session-1: session is archived/)
  })
})

describe('describeCapabilities for the worktree and archive surface', () => {
  it('reports the new probes from the mounted services', () => {
    const controller = fakeController({
      projections: async () => ({ kind: 'sequenced', asOfSeq: 0, values: {} }),
    })
    const registry = fakeRegistry({
      archiveSession: async () => {},
      unarchiveSession: async () => {},
      pinSession: async () => {},
      unpinSession: async () => {},
    })
    const worktrees = worktreeDouble()
    const { driver } = makeDriver({ controller, registry, worktrees: worktrees.service })

    expect(driver.describeCapabilities()).toMatchObject({
      worktrees: true,
      agentResolve: true,
      sessionArchive: true,
      sessionPin: true,
      sessionViews: true,
    })
  })

  it('reports sessionViews through observeSession when the controller has no projection read', () => {
    const query = {
      readSession: async () => ({ session: { id: SESSION }, inheritedEventCount: 0, events: [] }),
      observeSession: async () => ({ events: [] }),
    }
    const { driver } = makeDriver({ controller: fakeController(), query })

    expect(driver.describeCapabilities()).toMatchObject({ sessionViews: true })
  })

  it('reports them false on a profile that provides none of it', () => {
    const { driver } = makeDriver({ controller: fakeController({ resolveAgent: undefined }) })

    expect(driver.describeCapabilities()).toMatchObject({
      worktrees: false,
      agentResolve: false,
      sessionArchive: false,
      sessionPin: false,
      sessionViews: false,
    })
  })
})
