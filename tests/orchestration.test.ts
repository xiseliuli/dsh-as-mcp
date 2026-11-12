/**
 * Session orchestration: slash commands and durable goals.
 *
 * A human drives a long DSH session with three cheap moves the composer offers —
 * type `/compact`, turn plan mode on or off, and set or pause a goal — and none of
 * them spends a model turn. These tests pin the driver's side of that: which
 * service sees which call, that the command line is normalised before the registry
 * parses it, that the two dangerous shipped commands are refused *before* a handler
 * runs, and that a goal mutation carries the harness's own revision guard.
 *
 * The fakes model the behaviour that made the implementation what it is:
 * every command and goal call is agent-scoped, so a session that cannot resolve an
 * agent cannot be orchestrated; `commands.execute` returns `undefined` for a name
 * or argument the profile did not admit (nothing is logged in that case); and
 * `goals.*` mutators take the `GoalRef` that a read produced, not one the caller
 * invented.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { DshDriver } from '../src/dsh/driver.js'
import { testConfig } from './harness.js'

type AnyRecord = Record<string, unknown>

const SESSION = 'session-1'
const AGENT = { id: 'agent-cold' }

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
  commands?: AnyRecord | null
  goals?: AnyRecord | null
  controller?: AnyRecord | null
  config?: Partial<Config>
} = {}): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  if (options.controller !== null) {
    ctx.provide('sessionController', options.controller ?? {
      resolveAgent: async () => ({ agent: AGENT }),
    })
  }
  if (options.commands !== undefined && options.commands !== null) ctx.provide('commands', options.commands)
  if (options.goals !== undefined && options.goals !== null) ctx.provide('goals', options.goals)
  return { driver: new DshDriver(ctx, () => configWith(options.config)), ctx }
}

/** A `ctx.commands` double recording what reached it. */
function commandDouble(options: {
  names?: readonly string[]
  result?: unknown
  admitted?: boolean
} = {}): AnyRecord & { listed: unknown[]; executed: AnyRecord[] } {
  const listed: unknown[] = []
  const executed: AnyRecord[] = []
  const names = options.names ?? ['compact', 'plan', 'goal', 'export', 'feedback', 'permission']
  return {
    listed,
    executed,
    list: (agent: unknown) => {
      listed.push(agent)
      return names.map((name) => ({
        name,
        description: `${name} description`,
        ...(name === 'goal' ? { input: { hint: '<objective>' } } : {}),
      }))
    },
    execute: async (agent: unknown, line: string, attachments: unknown[], signal: AbortSignal) => {
      executed.push({ agent, line, attachments, signal })
      if (options.admitted === false) return undefined
      return {
        commandId: 'command-7',
        result: options.result ?? { kind: 'success', text: `ran ${line}`, sourceEventSeq: 42 },
      }
    },
  }
}

/** A `ctx.goals` double over one mutable view. */
function goalDouble(initial?: AnyRecord): AnyRecord & { calls: string[] } {
  const calls: string[] = []
  let goal: AnyRecord | undefined = initial
  const view = (overrides: AnyRecord = {}): AnyRecord => ({
    id: 'goal-1',
    revision: 3,
    objective: 'ship it',
    phase: 'active',
    activation: 'armed',
    maxGoalRounds: 8,
    roundsStarted: 1,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  })
  return {
    calls,
    get: () => {
      calls.push('get')
      return goal
    },
    create: (_agent: unknown, request: AnyRecord) => {
      calls.push('create')
      goal = view({ revision: 1, objective: request.objective, roundsStarted: 0 })
      return goal
    },
    edit: (_agent: unknown, ref: AnyRecord, request: AnyRecord) => {
      calls.push('edit')
      goal = view({ ...ref, ...request })
      return goal
    },
    pause: (_agent: unknown, ref: AnyRecord) => {
      calls.push('pause')
      goal = view({ ...ref, phase: 'paused', activation: 'disarmed' })
      return goal
    },
    resume: (_agent: unknown, ref: AnyRecord) => {
      calls.push('resume')
      goal = view({ ...ref, phase: 'active', activation: 'armed' })
      return goal
    },
    complete: (_agent: unknown, ref: AnyRecord) => {
      calls.push('complete')
      goal = view({ ...ref, phase: 'complete' })
      return goal
    },
    clear: (_agent: unknown, ref: AnyRecord) => {
      calls.push('clear')
      goal = undefined
      return ref
    },
  }
}

describe('session_command_list', () => {
  it('lists the agent\'s commands and marks which ones this endpoint runs', async () => {
    const commands = commandDouble()
    const { driver } = makeDriver({ commands })
    const listed = await driver.listSessionCommands({ sessionId: SESSION })
    // Every command is reported, so a caller can see that `/permission` exists and
    // why it is not executed — filtering it out would look like a missing feature.
    expect(listed.commands.map((command) => command.name)).toEqual([
      'compact', 'plan', 'goal', 'export', 'feedback', 'permission',
    ])
    expect(listed.commands.filter((command) => command.permitted).map((command) => command.name))
      .toEqual(['compact', 'plan', 'goal', 'export'])
    expect(listed.commands.find((command) => command.name === 'goal')?.input).toEqual({ hint: '<objective>' })
    // The list is agent-scoped, and the scope comes from resolveAgent.
    expect(commands.listed).toEqual([AGENT])
  })

  it('refuses a profile with no commands service, naming the bundle that provides it', async () => {
    const { driver } = makeDriver({ commands: null })
    await expect(driver.listSessionCommands({ sessionId: SESSION })).rejects.toThrow(/commands service/)
  })

  it('respects session.scope: owned', async () => {
    const { driver } = makeDriver({
      commands: commandDouble(),
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })
    await expect(driver.listSessionCommands({ sessionId: 'foreign' })).rejects.toThrow(/session.scope is "owned"/)
  })
})

describe('session_command', () => {
  it('runs a permitted command through the session\'s agent', async () => {
    const commands = commandDouble()
    const { driver } = makeDriver({ commands })
    const reply = await driver.runSessionCommand({ sessionId: SESSION, command: 'compact' })
    expect(reply).toMatchObject({ sessionId: SESSION, commandId: 'command-7', ok: true, text: 'ran /compact' })
    expect(commands.executed).toHaveLength(1)
    expect(commands.executed[0]?.agent).toEqual(AGENT)
    // Normalised to the slash form the registry parses.
    expect(commands.executed[0]?.line).toBe('/compact')
    expect(commands.executed[0]?.attachments).toEqual([])
    expect(commands.executed[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('accepts an already-slashed line with arguments unchanged', async () => {
    const commands = commandDouble()
    const { driver } = makeDriver({ commands })
    await driver.runSessionCommand({ sessionId: SESSION, command: '/goal finish the migration' })
    expect(commands.executed[0]?.line).toBe('/goal finish the migration')
  })

  it('refuses /permission and /feedback before any handler runs', async () => {
    for (const name of ['permission', 'feedback']) {
      const commands = commandDouble()
      const { driver } = makeDriver({ commands })
      await expect(driver.runSessionCommand({ sessionId: SESSION, command: `/${name}` }))
        .rejects.toThrow(/not a command this endpoint runs/)
      // Nothing reached the registry: a refusal must not write command/run into the
      // session log.
      expect(commands.executed).toEqual([])
    }
  })

  it('tells an unknown name which commands are admitted', async () => {
    const commands = commandDouble()
    const { driver } = makeDriver({ commands })
    await expect(driver.runSessionCommand({ sessionId: SESSION, command: 'nope' }))
      .rejects.toThrow(/\/compact, \/plan, \/goal, \/export/)
  })

  it('reports an admission miss as an error that explains nothing was logged', async () => {
    const commands = commandDouble({ admitted: false })
    const { driver } = makeDriver({ commands })
    await expect(driver.runSessionCommand({ sessionId: SESSION, command: '/goal' }))
      .rejects.toThrow(/nothing was logged/)
  })

  it('reports a handler error result as ok: false with the handler text', async () => {
    const commands = commandDouble({ result: { kind: 'error', text: 'compaction unavailable' } })
    const { driver } = makeDriver({ commands })
    const reply = await driver.runSessionCommand({ sessionId: SESSION, command: 'compact' })
    expect(reply.ok).toBe(false)
    expect(reply.text).toBe('compaction unavailable')
    expect(reply.sourceEventSeq).toBeUndefined()
  })
})

describe('session_goal', () => {
  it('reports null when the session carries no goal', async () => {
    const { driver } = makeDriver({ goals: goalDouble(undefined) })
    await expect(driver.sessionGoal({ sessionId: SESSION })).resolves.toEqual({ sessionId: SESSION, goal: null })
  })

  it('projects the harness GoalView onto the reported fields', async () => {
    const goals = goalDouble({
      id: 'goal-9',
      revision: 4,
      objective: 'finish',
      phase: 'paused',
      activation: 'disarmed',
      maxGoalRounds: 12,
      roundsStarted: 2,
      createdAt: 1,
      updatedAt: 2,
      blockedReason: { code: 'test', message: 'blocked' },
    })
    const { driver } = makeDriver({ goals })
    const reply = await driver.sessionGoal({ sessionId: SESSION })
    expect(reply.goal).toEqual({
      id: 'goal-9',
      revision: 4,
      objective: 'finish',
      phase: 'paused',
      activation: 'disarmed',
      maxGoalRounds: 12,
      roundsStarted: 2,
      blockedReason: { code: 'test', message: 'blocked' },
      createdAt: 1,
      updatedAt: 2,
    })
  })

  it('creates a goal and requires an objective', async () => {
    const goals = goalDouble(undefined)
    const { driver } = makeDriver({ goals })
    await expect(driver.mutateSessionGoal({ sessionId: SESSION, action: 'create' })).rejects.toThrow(/objective/)
    const created = await driver.mutateSessionGoal({
      sessionId: SESSION,
      action: 'create',
      objective: 'ship it',
      maxGoalRounds: 3,
    })
    expect(created.goal?.objective).toBe('ship it')
    expect(goals.calls).toContain('create')
  })

  it('mutates the goal that exists now, using its own ref', async () => {
    const goals = goalDouble({ id: 'goal-1', revision: 5 })
    const { driver } = makeDriver({ goals })
    const paused = await driver.mutateSessionGoal({ sessionId: SESSION, action: 'pause' })
    expect(paused.goal?.phase).toBe('paused')
    expect(paused.goal?.revision).toBe(5)
    const resumed = await driver.mutateSessionGoal({ sessionId: SESSION, action: 'resume' })
    expect(resumed.goal?.phase).toBe('active')
    const completed = await driver.mutateSessionGoal({ sessionId: SESSION, action: 'complete' })
    expect(completed.goal?.phase).toBe('complete')
  })

  it('refuses a mutation whose expected revision no longer matches', async () => {
    const goals = goalDouble({ id: 'goal-1', revision: 5 })
    const { driver } = makeDriver({ goals })
    await expect(driver.mutateSessionGoal({
      sessionId: SESSION,
      action: 'pause',
      expectedRevision: 4,
    })).rejects.toThrow(/expected revision 4, the goal is at revision 5/)
    // The guard fires before the service mutates anything.
    expect(goals.calls.filter((call) => call === 'pause')).toEqual([])
  })

  it('refuses to mutate a session that has no goal', async () => {
    const { driver } = makeDriver({ goals: goalDouble(undefined) })
    await expect(driver.mutateSessionGoal({ sessionId: SESSION, action: 'pause' }))
      .rejects.toThrow(/has no goal/)
  })

  it('clears a goal and reports the cleared shape', async () => {
    const goals = goalDouble({ id: 'goal-1', revision: 2 })
    const { driver } = makeDriver({ goals })
    const cleared = await driver.mutateSessionGoal({ sessionId: SESSION, action: 'clear' })
    expect(cleared).toEqual({ sessionId: SESSION, action: 'clear', goal: null, cleared: true })
    expect(goals.calls).toContain('clear')
  })

  it('edit needs an objective or a round cap', async () => {
    const goals = goalDouble({ id: 'goal-1', revision: 2 })
    const { driver } = makeDriver({ goals })
    await expect(driver.mutateSessionGoal({ sessionId: SESSION, action: 'edit' }))
      .rejects.toThrow(/needs objective and\/or maxGoalRounds/)
    const edited = await driver.mutateSessionGoal({
      sessionId: SESSION,
      action: 'edit',
      maxGoalRounds: 20,
    })
    expect(edited.goal?.maxGoalRounds).toBe(20)
  })

  it('refuses a profile with no goals service', async () => {
    const { driver } = makeDriver({ goals: null })
    await expect(driver.sessionGoal({ sessionId: SESSION })).rejects.toThrow(/goals service/)
  })
})

describe('agent scope is required', () => {
  it('refuses to orchestrate a session that cannot resolve an agent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionController', {})
    ctx.provide('commands', commandDouble())
    ctx.provide('goals', goalDouble({ id: 'goal-1', revision: 1 }))
    const driver = new DshDriver(ctx, () => configWith())
    await expect(driver.runSessionCommand({ sessionId: SESSION, command: 'compact' }))
      .rejects.toThrow(/resolveAgent/)
    await expect(driver.sessionGoal({ sessionId: SESSION })).rejects.toThrow(/resolveAgent/)
  })
})
