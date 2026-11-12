/**
 * Host scheduled automation.
 *
 * A scheduled task is the one surface here that is not session-scoped: the harness
 * owns the record, delivers the prompt at each occurrence (even with no client
 * connected), and `edit` addresses it by bare id. Everything these tests pin is a
 * consequence of that shape:
 *
 * - the timing is one of three caller forms and never a silent mix, because a
 *   request that names two of them would leave which one wins unexplained;
 * - the target decides whether a delivery updates a conversation, reuses one
 *   created on first delivery, or starts a fresh one — and a new-conversation
 *   target must not name a session id, which would contradict itself;
 * - `session.scope: "owned"` refuses the *whole* surface, because an ownership
 *   check cannot be expressed on a record with no owner field;
 * - a conflict and a miss are answered as data (`conflict: true`, `found: false`),
 *   not as thrown errors, so a polling caller can react without parsing text.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { DshDriver } from '../src/dsh/driver.js'
import { testConfig } from './harness.js'

type AnyRecord = Record<string, unknown>

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
  schedule?: AnyRecord | null
  config?: Partial<Config>
} = {}): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  if (options.schedule !== undefined && options.schedule !== null) ctx.provide('schedule', options.schedule)
  return { driver: new DshDriver(ctx, () => configWith(options.config)), ctx }
}

/** One stored task, shaped like the harness's `ScheduleCatalogEntry`. */
function entry(overrides: AnyRecord = {}): AnyRecord {
  return {
    id: 'schedule-1',
    kind: 'every',
    title: 'hourly sweep',
    prompt: 'check the build',
    scheduledAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    target: { kind: 'new', create: {} },
    everySeconds: 3600,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A `ctx.schedule` double recording the calls it receives. */
function scheduleDouble(options: {
  created?: AnyRecord
  views?: AnyRecord
  editResults?: AnyRecord[]
  listResult?: AnyRecord
} = {}): AnyRecord & { calls: AnyRecord[] } {
  const calls: AnyRecord[] = []
  const editResults = [...(options.editResults ?? [])]
  return {
    calls,
    create: async (request: AnyRecord, actorSessionId?: string) => {
      calls.push({ method: 'create', request, actorSessionId })
      return options.created ?? entry({ id: 'schedule-created' })
    },
    list: async (request: AnyRecord) => {
      calls.push({ method: 'list', request })
      return options.listResult ?? { items: [entry()], shown: 1, total: 1, limit: 20, offset: 0 }
    },
    view: async (request: AnyRecord) => {
      calls.push({ method: 'view', request })
      return options.views ?? entry()
    },
    edit: async (request: AnyRecord) => {
      calls.push({ method: 'edit', request })
      return editResults.shift() ?? entry()
    },
  }
}

describe('schedule_create', () => {
  it('creates an RRULE task against a new conversation by default', async () => {
    const schedule = scheduleDouble({ created: entry({ id: 'schedule-9' }) })
    const { driver } = makeDriver({ schedule })
    const created = await driver.createScheduledTask({
      title: 'hourly sweep',
      prompt: 'check the build',
      rrule: 'DTSTART;TZID=Asia/Singapore:20260901T080000\nRRULE:FREQ=DAILY;COUNT=3',
    })
    expect(created.task.id).toBe('schedule-9')
    const call = schedule.calls[0] as { request: AnyRecord }
    expect(call.request.timing).toEqual({
      kind: 'rrule',
      rrule: 'DTSTART;TZID=Asia/Singapore:20260901T080000\nRRULE:FREQ=DAILY;COUNT=3',
    })
    // No session id and no target means "a fresh conversation per delivery".
    expect(call.request.target).toEqual({ kind: 'new' })
    expect(call.request.title).toBe('hourly sweep')
  })

  it('maps the two shorthand timings onto the service shapes', async () => {
    const schedule = scheduleDouble()
    const { driver } = makeDriver({ schedule })
    await driver.createScheduledTask({ title: 'once', prompt: 'go', afterSeconds: 90 })
    await driver.createScheduledTask({ title: 'repeat', prompt: 'go', everySeconds: 3600 })
    const [first, second] = schedule.calls as { request: AnyRecord }[]
    expect(first?.request.timing).toEqual({ kind: 'after', after_seconds: 90 })
    expect(second?.request.timing).toEqual({ kind: 'every', every_seconds: 3600 })
  })

  it('targets an existing conversation and carries the create spec for new ones', async () => {
    const schedule = scheduleDouble()
    const { driver } = makeDriver({ schedule })
    await driver.createScheduledTask({
      title: 'session task',
      prompt: 'go',
      everySeconds: 60,
      sessionId: 'session-1',
    })
    await driver.createScheduledTask({
      title: 'fresh task',
      prompt: 'go',
      everySeconds: 60,
      target: 'new',
      cwd: '/tmp/repo',
      agentPreset: 'standard',
    })
    const [withSession, withCreate] = schedule.calls as { request: AnyRecord }[]
    expect(withSession?.request.target).toEqual({ kind: 'session', sessionId: 'session-1' })
    expect(withCreate?.request.target).toEqual({
      kind: 'new',
      create: { cwd: '/tmp/repo', agentPreset: 'standard' },
    })
  })

  it('refuses a request that names two timing forms, or none', async () => {
    const { driver } = makeDriver({ schedule: scheduleDouble() })
    await expect(driver.createScheduledTask({
      title: 'both', prompt: 'go', afterSeconds: 5, everySeconds: 60,
    })).rejects.toThrow(/exactly one timing form; received afterSeconds, everySeconds/)
    await expect(driver.createScheduledTask({ title: 'none', prompt: 'go' }))
      .rejects.toThrow(/needs one timing form/)
  })

  it('refuses empty fields, an over-long title and a self-contradicting target', async () => {
    const schedule = scheduleDouble()
    const { driver } = makeDriver({ schedule })
    await expect(driver.createScheduledTask({ title: '  ', prompt: 'go', everySeconds: 60 }))
      .rejects.toThrow(/non-empty title/)
    await expect(driver.createScheduledTask({ title: 'ok', prompt: '  ', everySeconds: 60 }))
      .rejects.toThrow(/non-empty prompt/)
    await expect(driver.createScheduledTask({ title: 'x'.repeat(121), prompt: 'go', everySeconds: 60 }))
      .rejects.toThrow(/at most 120/)
    await expect(driver.createScheduledTask({ title: 'ok', prompt: 'go', everySeconds: 60, target: 'session' }))
      .rejects.toThrow(/needs sessionId/)
    await expect(driver.createScheduledTask({
      title: 'ok', prompt: 'go', everySeconds: 60, target: 'new', sessionId: 'session-1',
    })).rejects.toThrow(/must not name sessionId/)
    // Nothing reached the service.
    expect(schedule.calls).toEqual([])
  })
})

describe('the owned-scope boundary', () => {
  const owned = { session: { ...testConfig().session, scope: 'owned' as const } }

  it('refuses every schedule tool, with the reason, when scope is owned', async () => {
    const schedule = scheduleDouble()
    const { driver } = makeDriver({ schedule, config: owned })
    await expect(driver.createScheduledTask({ title: 'a', prompt: 'b', everySeconds: 60 }))
      .rejects.toThrow(/session.scope is "owned"/)
    await expect(driver.listScheduledTasks()).rejects.toThrow(/session.scope is "owned"/)
    await expect(driver.viewScheduledTask({ scheduleId: 'schedule-1' })).rejects.toThrow(/session.scope is "owned"/)
    await expect(driver.editScheduledTask({ scheduleId: 'schedule-1', action: 'delete' }))
      .rejects.toThrow(/session.scope is "owned"/)
    expect(schedule.calls).toEqual([])
  })
})

describe('schedule_list and schedule_view', () => {
  it('bounds the page size and offset before the service sees them', async () => {
    const schedule = scheduleDouble()
    const { driver } = makeDriver({ schedule })
    await driver.listScheduledTasks({ limit: 9_999, offset: -4 })
    const call = schedule.calls[0] as { request: AnyRecord }
    expect(call.request.limit).toBe(200)
    expect(call.request.offset).toBe(0)
    await driver.listScheduledTasks()
    const second = schedule.calls[1] as { request: AnyRecord }
    expect(second.request.limit).toBe(20)
    expect(second.request.offset).toBe(0)
  })

  it('passes the active filter through', async () => {
    const schedule = scheduleDouble()
    const { driver } = makeDriver({ schedule })
    await driver.listScheduledTasks({ active: false })
    const call = schedule.calls[0] as { request: AnyRecord }
    expect(call.request.active).toBe(false)
  })

  it('answers a missing id as found: false rather than throwing', async () => {
    const schedule = scheduleDouble({ views: { id: 'gone', code: 'schedule_not_found' } })
    const { driver } = makeDriver({ schedule })
    await expect(driver.viewScheduledTask({ scheduleId: 'gone' }))
      .resolves.toEqual({ found: false, id: 'gone' })
  })

  it('returns the task when it exists', async () => {
    const schedule = scheduleDouble({ views: entry({ id: 'schedule-7' }) })
    const { driver } = makeDriver({ schedule })
    const viewed = await driver.viewScheduledTask({ scheduleId: 'schedule-7' })
    expect(viewed.found).toBe(true)
    expect(viewed.task?.id).toBe('schedule-7')
  })
})

describe('schedule_edit', () => {
  it('builds an update patch from the changed fields only', async () => {
    const schedule = scheduleDouble({ editResults: [entry({ title: 'renamed', status: 'paused' })] })
    const { driver } = makeDriver({ schedule })
    const outcome = await driver.editScheduledTask({
      scheduleId: 'schedule-1',
      action: 'update',
      title: 'renamed',
      active: false,
    })
    expect(outcome.updated).toBe(true)
    expect(outcome.task?.title).toBe('renamed')
    const call = schedule.calls[0] as { request: AnyRecord }
    expect(call.request).toEqual({
      id: 'schedule-1',
      action: 'update',
      patch: { title: 'renamed', active: false },
    })
  })

  it('maps a timing edit onto the service timing shape', async () => {
    const schedule = scheduleDouble({ editResults: [entry()] })
    const { driver } = makeDriver({ schedule })
    await driver.editScheduledTask({
      scheduleId: 'schedule-1',
      action: 'update',
      everySeconds: 120,
    })
    const call = schedule.calls[0] as { request: AnyRecord }
    expect((call.request.patch as AnyRecord).timing).toEqual({ kind: 'every', every_seconds: 120 })
  })

  it('requires at least one change for an update', async () => {
    const { driver } = makeDriver({ schedule: scheduleDouble() })
    await expect(driver.editScheduledTask({ scheduleId: 'schedule-1', action: 'update' }))
      .rejects.toThrow(/needs at least one change/)
  })

  it('refuses change fields on a delete', async () => {
    const { driver } = makeDriver({ schedule: scheduleDouble() })
    await expect(driver.editScheduledTask({
      scheduleId: 'schedule-1', action: 'delete', title: 'nope',
    })).rejects.toThrow(/accepts no change fields/)
  })

  it('reports a delete as deleted with found false', async () => {
    const schedule = scheduleDouble({ editResults: [{ id: 'schedule-1', deleted: true }] })
    const { driver } = makeDriver({ schedule })
    await expect(driver.editScheduledTask({ scheduleId: 'schedule-1', action: 'delete' }))
      .resolves.toEqual({ found: false, deleted: true, id: 'schedule-1' })
  })

  it('answers a stale updatedAt as conflict: true and changes nothing', async () => {
    const schedule = scheduleDouble({ editResults: [{ id: 'schedule-1', code: 'schedule_conflict' }] })
    const { driver } = makeDriver({ schedule })
    const outcome = await driver.editScheduledTask({
      scheduleId: 'schedule-1',
      action: 'update',
      title: 'renamed',
      expectedUpdatedAt: '2025-01-01T00:00:00.000Z',
    })
    expect(outcome).toEqual({ found: true, conflict: true, id: 'schedule-1' })
    const call = schedule.calls[0] as { request: AnyRecord }
    expect(call.request.expectedUpdatedAt).toBe('2025-01-01T00:00:00.000Z')
  })

  it('answers a miss on edit as found: false', async () => {
    const schedule = scheduleDouble({ editResults: [{ id: 'gone', code: 'schedule_not_found' }] })
    const { driver } = makeDriver({ schedule })
    await expect(driver.editScheduledTask({ scheduleId: 'gone', action: 'update', title: 'x' }))
      .resolves.toEqual({ found: false, id: 'gone' })
  })
})

describe('a profile without the service', () => {
  it('names the bundle that provides the schedule store', async () => {
    const { driver } = makeDriver({ schedule: null })
    await expect(driver.listScheduledTasks()).rejects.toThrow(/schedule service/)
  })
})
