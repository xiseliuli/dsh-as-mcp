/**
 * Observability: live agents, the subagent tree, and the skill catalog.
 *
 * Three reads that answer "what is DSH doing, what did it spawn, and what
 * instructions does it follow":
 *
 * - `agent_list` reads the live agent registry, so unlike `session_list` it sees only
 *   sessions with an agent in memory, and it says whether each is a root;
 * - `subagent_tree` reads the parent/child topology the Subagent panel renders,
 *   including a child it could not read (reported with a `reason`, not dropped);
 * - `skill_list`/`skill_read` expose the instruction library. Both are refused under
 *   `session.scope: "owned"`, because a skill belongs to the instance's project/user
 *   instruction files rather than to a session — the same boundary the schedule
 *   surface uses.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { DshDriver } from '../src/dsh/driver.js'
import { testConfig } from './harness.js'

type AnyRecord = Record<string, unknown>

const SESSION = 'session-1'
/** The agent object the skill registry is scoped by. */
const LIVE_AGENT = { id: SESSION }

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

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
  agents?: AnyRecord | null
  subagents?: AnyRecord | null
  skills?: AnyRecord | null
  config?: Partial<Config>
} = {}): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  if (options.agents !== undefined && options.agents !== null) ctx.provide('agents', options.agents)
  if (options.subagents !== undefined && options.subagents !== null) ctx.provide('subagents', options.subagents)
  if (options.skills !== undefined && options.skills !== null) ctx.provide('skills', options.skills)
  return { driver: new DshDriver(ctx, () => configWith(options.config)), ctx }
}

describe('agent_list', () => {
  it('reports live agents with status and root membership', async () => {
    const { driver } = makeDriver({
      agents: {
        get: () => undefined,
        list: () => [{ id: 'agent-1', status: 'running' }, { id: 'agent-2', status: 'idle' }],
        roots: () => [{ id: 'agent-1' }],
      },
    })
    await expect(driver.listLiveAgents()).resolves.toEqual({
      agents: [
        { sessionId: 'agent-1', status: 'running', root: true },
        { sessionId: 'agent-2', status: 'idle', root: false },
      ],
      count: 2,
    })
  })

  it('reports an empty list rather than failing when nothing is live', async () => {
    const { driver } = makeDriver({ agents: { get: () => undefined, list: () => [], roots: () => [] } })
    await expect(driver.listLiveAgents()).resolves.toEqual({ agents: [], count: 0 })
  })

  it('names the bundle when the registry is absent', async () => {
    const { driver } = makeDriver({ agents: null })
    await expect(driver.listLiveAgents()).rejects.toThrow(/agent registry/)
  })

  it('filters to owned sessions under session.scope: owned', async () => {
    const { driver } = makeDriver({
      agents: {
        get: () => undefined,
        list: () => [{ id: 'mine', status: 'idle' }, { id: 'foreign', status: 'idle' }],
        roots: () => [],
      },
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })
    const listed = await driver.listLiveAgents()
    // `ownsSession` is driven by the ownership record; a fresh driver owns nothing, so
    // the containment view is empty — and that is the safe direction to be wrong in.
    expect(listed.agents.map((agent) => agent.sessionId)).not.toContain('foreign')
  })
})

describe('subagent_tree', () => {
  it('reports children, and the whole subtree when asked', async () => {
    const asked: AnyRecord[] = []
    const { driver } = makeDriver({
      subagents: {
        listChildren: async (parentSessionId: string) => {
          asked.push({ method: 'listChildren', parentSessionId })
          return [{ id: 'child-1', createdAt: 5, mode: 'one-shot', label: 'explore', hasChildren: true }]
        },
        listDescendants: async (rootSessionId: string) => {
          asked.push({ method: 'listDescendants', rootSessionId })
          return [{ id: 'grandchild-1', createdAt: 6, mode: 'one-shot', parentId: 'child-1', depth: 2 }]
        },
      },
    })
    const shallow = await driver.subagentTree({ sessionId: SESSION })
    expect(shallow.children).toHaveLength(1)
    expect(shallow.descendants).toBeUndefined()
    expect(asked).toEqual([{ method: 'listChildren', parentSessionId: SESSION }])

    const deep = await driver.subagentTree({ sessionId: SESSION, includeDescendants: true })
    expect(deep.descendants).toEqual([
      { id: 'grandchild-1', createdAt: 6, mode: 'one-shot', parentId: 'child-1', depth: 2 },
    ])
    expect(asked).toHaveLength(3)
  })

  it('keeps a diagnostic child instead of dropping it', async () => {
    const { driver } = makeDriver({
      subagents: {
        listChildren: async () => [{ id: 'broken', createdAt: 1, reason: 'corrupt' }],
        listDescendants: async () => [],
      },
    })
    const tree = await driver.subagentTree({ sessionId: SESSION })
    expect(tree.children[0]).toMatchObject({ id: 'broken', reason: 'corrupt' })
  })

  it('names the bundle when the service is absent, and respects the owned scope', async () => {
    await expect(makeDriver({ subagents: null }).driver.subagentTree({ sessionId: SESSION }))
      .rejects.toThrow(/subagent service/)
    const owned = makeDriver({
      subagents: { listChildren: async () => [], listDescendants: async () => [] },
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })
    await expect(owned.driver.subagentTree({ sessionId: 'foreign' })).rejects.toThrow(/session.scope is "owned"/)
  })
})

describe('skill_list and skill_read', () => {
  it('reports the catalog and its completeness flag', async () => {
    const { driver } = makeDriver({
      skills: {
        list: async () => [],
        snapshot: async () => ({
          complete: false,
          skills: [{ name: 'review', description: 'review a change', whenToUse: 'before merging' }],
        }),
        get: async () => undefined,
      },
    })
    const listed = await driver.listSkills({})
    expect(listed.complete).toBe(false)
    expect(listed.skills[0]).toMatchObject({ name: 'review', whenToUse: 'before merging' })
  })

  it('falls back to list() and does not claim completeness when there is no snapshot', async () => {
    const { driver } = makeDriver({
      skills: {
        list: async () => [{ name: 'a', description: 'b' }],
        get: async () => undefined,
      },
    })
    await expect(driver.listSkills()).resolves.toEqual({
      skills: [{ name: 'a', description: 'b' }],
      complete: false,
    })
  })

  it('reads one skill body, bounded and flagged when cut', async () => {
    const asked: AnyRecord[] = []
    const { driver } = makeDriver({
      skills: {
        list: async () => [],
        get: async (name: string, options: AnyRecord) => {
          asked.push({ name, options })
          return { name, description: 'd', content: 'x'.repeat(500) }
        },
      },
    })
    const read = await driver.readSkill({ name: '  review  ', cwd: '/repo', maxChars: 100 })
    expect(asked).toEqual([{ name: 'review', options: { cwd: '/repo' } }])
    expect(read.skill?.content).toHaveLength(100)
    expect(read.textTruncated).toBe(true)
  })

  it('reads skills through the live session\'s agent preset when a session is given', async () => {
    const asked: AnyRecord[] = []
    const scopedSkills = {
      list: async (options: AnyRecord) => {
        asked.push({ registry: 'preset', options })
        return [{ name: 'bundled', description: 'from the preset' }]
      },
      get: async (name: string, options: AnyRecord) => {
        asked.push({ registry: 'preset', name, options })
        return { name, description: 'from the preset', content: 'body' }
      },
    }
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agents', { get: (id: string) => (id === SESSION ? LIVE_AGENT : undefined) })
    ctx.provide('agentPresets', { serviceFor: () => scopedSkills })
    ctx.provide('skills', { list: async () => [{ name: 'host-only', description: 'host' }], get: async () => undefined })
    const driver = new DshDriver(ctx, () => configWith())
    const listed = await driver.listSkills({ sessionId: SESSION })
    expect(listed.skills[0]?.name).toBe('bundled')
    // The live agent is the registry scope, exactly as the session controller does it.
    expect(asked[0]).toEqual({ registry: 'preset', options: { scope: LIVE_AGENT } })
    const read = await driver.readSkill({ sessionId: SESSION, name: 'bundled' })
    expect(read.skill?.content).toBe('body')
    // Without a session the host catalog is used, with no scope.
    const host = await driver.listSkills({})
    expect(host.skills[0]?.name).toBe('host-only')
  })

  it('refuses a session-scoped read when the harness holds no live session for it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('skills', { list: async () => [], get: async () => undefined })
    const driver = new DshDriver(ctx, () => configWith())
    await expect(driver.listSkills({ sessionId: 'cold' })).rejects.toThrow(/live agent for cold/)
  })

  it('refuses an unknown skill with the exact-name hint', async () => {
    const { driver } = makeDriver({
      skills: { list: async () => [], get: async () => undefined },
    })
    await expect(driver.readSkill({ name: 'nope' })).rejects.toThrow(/no skill named "nope"/)
  })

  it('refuses both tools under session.scope: owned, because the catalog is instance-wide', async () => {
    const { driver } = makeDriver({
      skills: { list: async () => [], get: async () => undefined },
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })
    await expect(driver.listSkills()).rejects.toThrow(/session.scope is "owned"/)
    await expect(driver.readSkill({ name: 'x' })).rejects.toThrow(/session.scope is "owned"/)
  })

  it('names the bundle when the service is absent', async () => {
    const { driver } = makeDriver({ skills: null })
    await expect(driver.listSkills()).rejects.toThrow(/skill service/)
  })
})
