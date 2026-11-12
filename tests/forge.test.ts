/**
 * Forge reads: change requests, local diffs and branches.
 *
 * These are read-only views of what the DSH forge panel shows. The tests pin the
 * three things a stub can get wrong in a way that only shows up live:
 *
 * - the reads are scoped by a **live session handle** (`ctx.sessions.get` answers
 *   only for a session the harness currently holds), so a cold session is a clear
 *   error rather than an empty result;
 * - a binding whose snapshot could not be read is still reported with its
 *   `failure`, because that is what the panel shows — silently dropping it would
 *   make "forge is not signed in" look like "this session opened no requests";
 * - every payload is bounded: file listings by `maxFiles`, patch text by
 *   `maxChars`, and the result says when it was cut.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { DshDriver } from '../src/dsh/driver.js'
import { testConfig } from './harness.js'

type AnyRecord = Record<string, unknown>

const SESSION = 'session-1'
const LIVE_SESSION = { id: SESSION }

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

function makeDriver(options: {
  sessions?: AnyRecord | null
  forgeSession?: AnyRecord | null
  forgePanel?: AnyRecord | null
  config?: Partial<Config>
} = {}): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  if (options.sessions !== null) {
    ctx.provide('sessions', options.sessions ?? { get: (id: string) => (id === SESSION ? LIVE_SESSION : undefined) })
  }
  if (options.forgeSession !== undefined && options.forgeSession !== null) ctx.provide('forgeSession', options.forgeSession)
  if (options.forgePanel !== undefined && options.forgePanel !== null) ctx.provide('forgePanel', options.forgePanel)
  return { driver: new DshDriver(ctx, () => configWith(options.config)), ctx }
}

/** One snapshot as the forge reports it. */
function snapshot(overrides: AnyRecord = {}): AnyRecord {
  return {
    url: 'https://github.com/example/repo/pull/7',
    title: 'add the feature',
    state: 'open',
    draft: false,
    author: 'someone',
    headBranch: 'feature',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    additions: 12,
    deletions: 3,
    mergeability: 'mergeable',
    mergeReady: true,
    mergeMethods: ['merge', 'squash'],
    reviewDecision: 'approved',
    checks: [
      { name: 'ci', state: 'success', url: 'https://ci/1', workflow: 'ci', startedAt: 't0', completedAt: 't1' },
    ],
    checksRollup: 'success',
    unresolvedThreads: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    ...overrides,
  }
}

/** One binding as `forgeSession.changeRequests` reports it. */
function binding(overrides: AnyRecord = {}): AnyRecord {
  return {
    url: 'https://github.com/example/repo/pull/7',
    origin: 'created',
    ref: {
      repository: { forge: 'github', host: 'github.com', owner: 'example', name: 'repo' },
      number: 7,
    },
    update: { fetchedAt: 1_700_000_000_000, snapshot: snapshot() },
    ...overrides,
  }
}

/** One diff file. */
function diffFile(overrides: AnyRecord = {}): AnyRecord {
  return {
    path: 'src/index.ts',
    previousPath: null,
    status: 'modified',
    binary: false,
    oversized: false,
    untracked: false,
    additions: 3,
    deletions: 1,
    hunks: [{ header: '@@' }],
    ...overrides,
  }
}

describe('the forge capability gate', () => {
  it('names the forge bundle when the services are absent', async () => {
    const { driver } = makeDriver({ forgeSession: null, forgePanel: null })
    await expect(driver.forgeChanges({ sessionId: SESSION })).rejects.toThrow(/forge read surface/)
    await expect(driver.forgeLocalDiff({ sessionId: SESSION })).rejects.toThrow(/forge read surface/)
    await expect(driver.forgeBranches({ sessionId: SESSION })).rejects.toThrow(/forge read surface/)
  })

  it('refuses a cold session with an explanation instead of an empty list', async () => {
    const { driver } = makeDriver({
      sessions: { get: () => undefined },
      forgeSession: { changeRequests: () => [] },
      forgePanel: { branches: async () => ({ current: null, branches: [] }), localDiff: async () => ({ base: null, files: [], omitted: 0 }), localText: async () => '' },
    })
    await expect(driver.forgeChanges({ sessionId: 'cold' })).rejects.toThrow(/live session handle/)
    await expect(driver.forgeLocalDiff({ sessionId: 'cold' })).rejects.toThrow(/live session handle/)
    await expect(driver.forgeBranches({ sessionId: 'cold' })).rejects.toThrow(/live session handle/)
  })

  it('respects session.scope: owned', async () => {
    const { driver } = makeDriver({
      forgeSession: { changeRequests: () => [] },
      forgePanel: { branches: async () => ({ current: null, branches: [] }), localDiff: async () => ({ base: null, files: [], omitted: 0 }), localText: async () => '' },
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })
    await expect(driver.forgeChanges({ sessionId: 'not-mine' })).rejects.toThrow(/session.scope is "owned"/)
  })
})

describe('forge_changes', () => {
  it('projects a bound change request with its cached snapshot', async () => {
    const seen: unknown[] = []
    const { driver } = makeDriver({
      forgeSession: {
        changeRequests: (session: unknown) => {
          seen.push(session)
          return [binding()]
        },
      },
      forgePanel: { branches: async () => ({ current: null, branches: [] }), localDiff: async () => ({ base: null, files: [], omitted: 0 }), localText: async () => '' },
    })
    const reply = await driver.forgeChanges({ sessionId: SESSION })
    // The handle handed to the forge service is the live-session one.
    expect(seen).toEqual([LIVE_SESSION])
    expect(reply.changes).toHaveLength(1)
    expect(reply.changes[0]).toMatchObject({
      url: 'https://github.com/example/repo/pull/7',
      origin: 'created',
      number: 7,
      title: 'add the feature',
      state: 'open',
      headBranch: 'feature',
      baseBranch: 'main',
      additions: 12,
      deletions: 3,
      mergeability: 'mergeable',
      mergeReady: true,
      reviewDecision: 'approved',
      checksRollup: 'success',
      unresolvedThreads: 0,
      fetchedAt: 1_700_000_000_000,
    })
    expect(reply.changes[0]?.checks).toEqual([{
      name: 'ci',
      state: 'success',
      url: 'https://ci/1',
      workflow: 'ci',
      startedAt: 't0',
      completedAt: 't1',
    }])
    expect(reply.truncated).toBeUndefined()
  })

  it('keeps a binding whose snapshot failed, reporting the failure', async () => {
    const { driver } = makeDriver({
      forgeSession: {
        changeRequests: () => [binding({
          update: { fetchedAt: 5, failure: { code: 'unauthenticated', message: 'run gh auth login' } },
        })],
      },
      forgePanel: { branches: async () => ({ current: null, branches: [] }), localDiff: async () => ({ base: null, files: [], omitted: 0 }), localText: async () => '' },
    })
    const reply = await driver.forgeChanges({ sessionId: SESSION })
    expect(reply.changes[0]?.failure).toEqual({ code: 'unauthenticated', message: 'run gh auth login' })
    expect(reply.changes[0]?.title).toBeUndefined()
  })

  it('refreshes checks when asked, and marks the view stale when the refresh fails', async () => {
    let refreshed = 0
    const { driver } = makeDriver({
      forgeSession: { changeRequests: () => [binding()] },
      forgePanel: {
        branches: async () => ({ current: null, branches: [] }),
        localDiff: async () => ({ base: null, files: [], omitted: 0 }),
        localText: async () => '',
        changeRequestChecks: async () => {
          refreshed += 1
          return snapshot({ checksRollup: 'failure', checks: [{ name: 'ci', state: 'failure', url: null, workflow: null, startedAt: null, completedAt: null }] })
        },
      },
    })
    const fresh = await driver.forgeChanges({ sessionId: SESSION, includeChecks: true })
    expect(refreshed).toBe(1)
    expect(fresh.changes[0]?.checksRollup).toBe('failure')
    expect(fresh.changes[0]?.checks?.[0]?.state).toBe('failure')

    const failing = await driver.forgeChanges({ sessionId: SESSION, includeChecks: true })
    void failing
    const { driver: broken } = makeDriver({
      forgeSession: { changeRequests: () => [binding()] },
      forgePanel: {
        branches: async () => ({ current: null, branches: [] }),
        localDiff: async () => ({ base: null, files: [], omitted: 0 }),
        localText: async () => '',
        changeRequestChecks: async () => {
          throw new Error('forge unavailable')
        },
      },
    })
    const stale = await broken.forgeChanges({ sessionId: SESSION, includeChecks: true })
    // The cached snapshot is kept and the failure is visible.
    expect(stale.changes[0]?.checksStale).toBe(true)
    expect(stale.changes[0]?.checksRollup).toBe('success')
    expect(stale.truncated).toEqual({ checks: true })
  })

  it('adds a bounded diff listing when asked', async () => {
    const { driver } = makeDriver({
      forgeSession: { changeRequests: () => [binding()] },
      forgePanel: {
        branches: async () => ({ current: null, branches: [] }),
        localDiff: async () => ({ base: null, files: [], omitted: 0 }),
        localText: async () => '',
        changeRequestDiff: async () => ({
          headSha: 'b'.repeat(40),
          files: [diffFile(), diffFile({ path: 'src/b.ts' }), diffFile({ path: 'src/c.ts' })],
          localAhead: 2,
        }),
      },
    })
    const reply = await driver.forgeChanges({ sessionId: SESSION, includeDiff: true, maxFiles: 2 })
    const diff = reply.changes[0]?.diff
    expect(diff?.headSha).toBe('b'.repeat(40))
    expect(diff?.localAhead).toBe(2)
    expect(diff?.files).toHaveLength(2)
    expect(diff?.truncated).toBe(true)
    expect(reply.truncated).toEqual({ diff: true })
  })
})

describe('forge_local_diff', () => {
  it('lists the working-tree files and reports how many were omitted', async () => {
    const scopes: unknown[] = []
    const { driver } = makeDriver({
      forgeSession: { changeRequests: () => [] },
      forgePanel: {
        branches: async () => ({ current: 'feature', branches: ['main', 'feature'] }),
        localDiff: async (_session: unknown, scope: unknown) => {
          scopes.push(scope)
          return { base: 'main', files: [diffFile(), diffFile({ path: 'src/b.ts' })], omitted: 4 }
        },
        localText: async () => '',
      },
    })
    const reply = await driver.forgeLocalDiff({ sessionId: SESSION, maxFiles: 1 })
    // Default scope is the panel's "everything uncommitted" view.
    expect(scopes).toEqual([{ kind: 'uncommitted' }])
    expect(reply.base).toBe('main')
    expect(reply.files).toHaveLength(1)
    expect(reply.files[0]).toMatchObject({ path: 'src/index.ts', additions: 3, deletions: 1, hunks: 1 })
    // 4 the forge omitted plus 1 this endpoint cut.
    expect(reply.omitted).toBe(5)
  })

  it('returns one file patch text, bounded and flagged when cut', async () => {
    const asked: unknown[] = []
    const { driver } = makeDriver({
      forgeSession: { changeRequests: () => [] },
      forgePanel: {
        branches: async () => ({ current: 'main', branches: ['main'] }),
        localDiff: async () => ({ base: null, files: [], omitted: 0 }),
        localText: async (_session: unknown, scope: unknown, path: string) => {
          asked.push({ scope, path })
          return 'x'.repeat(5_000)
        },
      },
    })
    const reply = await driver.forgeLocalDiff({ sessionId: SESSION, path: 'src/index.ts', maxChars: 1_000 })
    expect(asked).toEqual([{ scope: { kind: 'uncommitted' }, path: 'src/index.ts' }])
    expect(reply.text).toHaveLength(1_000)
    expect(reply.textTruncated).toBe(true)
    expect(reply.files).toEqual([])
  })

  it('passes an explicit scope through', async () => {
    const scopes: unknown[] = []
    const { driver } = makeDriver({
      forgeSession: { changeRequests: () => [] },
      forgePanel: {
        branches: async () => ({ current: 'main', branches: [] }),
        localDiff: async (_session: unknown, scope: unknown) => {
          scopes.push(scope)
          return { base: null, files: [], omitted: 0 }
        },
        localText: async () => '',
      },
    })
    await driver.forgeLocalDiff({ sessionId: SESSION, scope: 'staged' })
    expect(scopes).toEqual([{ kind: 'staged' }])
  })
})

describe('forge_branches', () => {
  it('reports the current branch and the list', async () => {
    const { driver } = makeDriver({
      forgeSession: { changeRequests: () => [] },
      forgePanel: {
        branches: async () => ({ current: 'feature', branches: ['main', 'feature'] }),
        localDiff: async () => ({ base: null, files: [], omitted: 0 }),
        localText: async () => '',
      },
    })
    await expect(driver.forgeBranches({ sessionId: SESSION })).resolves.toEqual({
      sessionId: SESSION,
      current: 'feature',
      branches: ['main', 'feature'],
    })
  })
})
