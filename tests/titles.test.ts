import { describe, expect, it } from 'vitest'

import { testConfig } from './harness.js'
import { DshDriver } from '../src/dsh/driver.js'
import type { DshSessionController, DshSessionQuery } from '../src/dsh/types.js'

/** A driver whose controller lists the given sessions and whose query folds titles. */
function driverWith(options: {
  sessions: { sessionId: string; updatedAt: number; cwd?: string; running?: boolean; blank?: boolean }[]
  titles?: Record<string, string>
  titleError?: (sessionId: string) => Error | undefined
  hasTitleReader?: boolean
}): { driver: DshDriver; titleCalls: string[] } {
  const titleCalls: string[] = []
  const controller: DshSessionController = {
    create: async () => ({ sessionId: 'unused' }),
    list: async () => ({
      items: options.sessions.map((session) => ({
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
        running: session.running ?? false,
        blank: session.blank ?? false,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      })),
    }),
    selectModel: async (request: { provider: string; model: string }) => ({
      selected: { provider: request.provider, model: request.model },
    }),
    prompt: async () => {},
    cancel: () => ({ accepted: true }),
    inspect: async () => ({ meta: { id: 'unused' }, inheritedEventCount: 0, events: [] }),
    resolveAgent: async () => ({ error: new Error('not needed in this test') }),
  } as unknown as DshSessionController

  const query: DshSessionQuery = {
    readSession: async () => ({ session: { id: 'unused' }, inheritedEventCount: 0, events: [] }),
  }
  if (options.hasTitleReader !== false) {
    query.readTitleSnapshot = async (sessionId: string) => {
      titleCalls.push(sessionId)
      const failure = options.titleError?.(sessionId)
      if (failure !== undefined) throw failure
      const title = options.titles?.[sessionId]
      return {
        session: { id: sessionId },
        ...(title === undefined ? {} : { title: { title, eventSeq: 5 } }),
      }
    }
  }

  const ctx = {
    get: (name: string) => (name === 'sessionController' ? controller : name === 'sessionQuery' ? query : undefined),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }
  return { driver: new DshDriver(ctx, () => testConfig()), titleCalls }
}

describe('listSessions titles', () => {
  const sessions = [
    { sessionId: 'session-b', updatedAt: 2, cwd: '/tmp/project' },
    { sessionId: 'session-a', updatedAt: 1 },
  ]

  it('does not read titles unless asked', async () => {
    const { driver, titleCalls } = driverWith({ sessions, titles: { 'session-a': 'A' } })
    const listed = await driver.listSessions(10)
    expect(listed.sessions.every((entry) => entry.title === undefined)).toBe(true)
    // The default page must not pay one log read per session.
    expect(titleCalls).toEqual([])
  })

  it('folds and attaches titles when asked', async () => {
    const { driver } = driverWith({
      sessions,
      titles: { 'session-a': 'Fix the parser', 'session-b': 'Write the docs' },
    })
    const listed = await driver.listSessions(10, { includeTitle: true })
    expect(listed.sessions.map((entry) => [entry.sessionId, entry.title])).toEqual([
      ['session-b', 'Write the docs'],
      ['session-a', 'Fix the parser'],
    ])
    // Summaries keep their other fields.
    expect(listed.sessions[0]?.cwd).toBe('/tmp/project')
  })

  it('omits a title the log does not carry instead of inventing one', async () => {
    const { driver } = driverWith({ sessions, titles: { 'session-b': 'Only this one' } })
    const listed = await driver.listSessions(10, { includeTitle: true })
    expect(listed.sessions.find((entry) => entry.sessionId === 'session-a')?.title).toBeUndefined()
    expect(listed.sessions.find((entry) => entry.sessionId === 'session-b')?.title).toBe('Only this one')
  })

  it('keeps listing when one title read fails', async () => {
    const { driver } = driverWith({
      sessions,
      titles: { 'session-b': 'survives' },
      titleError: (sessionId) => (sessionId === 'session-a' ? new Error('title read failed') : undefined),
    })
    const listed = await driver.listSessions(10, { includeTitle: true })
    expect(listed.sessions).toHaveLength(2)
    expect(listed.sessions.find((entry) => entry.sessionId === 'session-b')?.title).toBe('survives')
    expect(listed.sessions.find((entry) => entry.sessionId === 'session-a')?.title).toBeUndefined()
  })

  it('filters by workspace directory before applying the limit', async () => {
    const { driver } = driverWith({
      sessions: [
        { sessionId: 'a', updatedAt: 3, cwd: '/tmp/dsh-filter-project' },
        { sessionId: 'b', updatedAt: 2, cwd: '/tmp/elsewhere' },
        { sessionId: 'c', updatedAt: 1, cwd: '/tmp/dsh-filter-project' },
      ],
    })
    const filtered = await driver.listSessions(1, { cwd: '/tmp/dsh-filter-project' })
    // The limit applies to the filtered set: 'a' is the newest match, not the
    // newest session overall. `total` still reports both matches.
    expect(filtered.sessions.map((entry) => entry.sessionId)).toEqual(['a'])
    expect(filtered.total).toBe(2)
  })

  it('filters by running state', async () => {
    const { driver } = driverWith({
      sessions: [
        { sessionId: 'running', updatedAt: 2, running: true },
        { sessionId: 'idle', updatedAt: 1, running: false },
      ],
    })
    const busy = await driver.listSessions(10, { running: true })
    expect(busy.sessions.map((entry) => entry.sessionId)).toEqual(['running'])
    const idle = await driver.listSessions(10, { running: false })
    expect(idle.sessions.map((entry) => entry.sessionId)).toEqual(['idle'])
  })

  it('lists sessions when the harness has no title reader at all', async () => {
    const { driver } = driverWith({ sessions, hasTitleReader: false })
    const listed = await driver.listSessions(10, { includeTitle: true })
    expect(listed.sessions).toHaveLength(2)
    expect(listed.sessions.every((entry) => entry.title === undefined)).toBe(true)
  })
})

describe('renameSession', () => {
  /** A driver whose controller renames, records the call, and can refuse. */
  function renamingDriver(options: {
    rename?: (request: { sessionId: string; title: string }) => Promise<{ title: string; seq: number }>
  } = {}): { driver: DshDriver; calls: unknown[] } {
    const calls: unknown[] = []
    const controller = {
      rename: async (request: { sessionId: string; title: string }) => {
        calls.push(request)
        if (options.rename !== undefined) return options.rename(request)
        return { title: request.title, seq: 42 }
      },
    } as unknown as DshSessionController
    const ctx = {
      get: (name: string) => (name === 'sessionController' ? controller : undefined),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }
    return { driver: new DshDriver(ctx, () => testConfig()), calls }
  }

  it('sets an explicit title and reports where it landed', async () => {
    const { driver, calls } = renamingDriver()
    const result = await driver.renameSession({ sessionId: 'session-1', title: 'Fix the parser' })
    expect(calls).toEqual([{ sessionId: 'session-1', title: 'Fix the parser' }])
    expect(result).toEqual({ sessionId: 'session-1', title: 'Fix the parser', seq: 42 })
  })

  it('refuses when the harness exposes no rename', async () => {
    const ctx = {
      get: () => ({}) as unknown,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }
    const driver = new DshDriver(ctx, () => testConfig())
    await expect(driver.renameSession({ sessionId: 's', title: 't' }))
      .rejects.toThrow(/no sessionController\.rename\(\)/)
  })

  it('surfaces a deployment that mounts no title service', async () => {
    const { driver } = renamingDriver({
      rename: async () => {
        throw new Error('renaming is unavailable: this deployment mounts no session-title service')
      },
    })
    await expect(driver.renameSession({ sessionId: 's', title: 't' }))
      .rejects.toThrow(/mounts no session-title service/)
  })
})
