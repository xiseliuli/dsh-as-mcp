import { describe, expect, it } from 'vitest'

import { testConfig } from './harness.js'
import { DshDriver } from '../src/dsh/driver.js'
import type { DshSessionController, DshSessionQuery } from '../src/dsh/types.js'

/**
 * A driver whose controller forks and whose query reports the child's cut.
 *
 * The controller's `fork` is the seam under test: the store's own fork exists but
 * produces a session the controller's first prompt cannot resume, which is why the
 * driver uses the controller's.
 */
function driverWith(options: {
  fork?: (request: { sessionId: string; atSeq?: number }) => Promise<{ sessionId: string }>
  inheritedEventCount?: number
  cwd?: string
  readError?: Error
  events?: readonly { type: string; seq: number; time: number; data: unknown }[]
}): { driver: DshDriver; forks: unknown[] } {
  const forks: unknown[] = []
  const controller = {
    fork: async (request: { sessionId: string; atSeq?: number }) => {
      forks.push(request)
      if (options.fork !== undefined) return options.fork(request)
      return { sessionId: 'session-child' }
    },
  } as unknown as DshSessionController

  const query = {
    readSession: async (sessionId: string) => {
      if (options.readError !== undefined) throw options.readError
      return {
        session: { id: sessionId, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) },
        inheritedEventCount: options.inheritedEventCount ?? 0,
        events: options.events ?? [],
      }
    },
  } as unknown as DshSessionQuery

  const ctx = {
    get: (name: string) => (name === 'sessionController' ? controller : name === 'sessionQuery' ? query : undefined),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }
  return { driver: new DshDriver(ctx, () => testConfig()), forks }
}

describe('forkSession', () => {
  it('forks through the controller and reports the child cut', async () => {
    const { driver, forks } = driverWith({ inheritedEventCount: 22, cwd: '/tmp/project' })

    const child = await driver.forkSession({ sessionId: 'session-live', atSeq: 11 })

    expect(forks).toEqual([{ sessionId: 'session-live', atSeq: 11 }])
    expect(child).toEqual({
      sessionId: 'session-child',
      parentSessionId: 'session-live',
      inheritedEventCount: 22,
      cwd: '/tmp/project',
    })
    // The child is this endpoint's session, so the approver scope follows it.
    expect(driver.ownsSession('session-child')).toBe(true)
  })

  it('omits the boundary so the harness picks the latest completed turn', async () => {
    const { driver, forks } = driverWith({})
    await driver.forkSession({ sessionId: 'session-live' })
    expect(forks).toEqual([{ sessionId: 'session-live' }])
  })

  it('resolves a turn boundary to the last event of that turn', async () => {
    const { driver, forks } = driverWith({
      events: [
        { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
        { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 0, message: { content: [] } } },
        { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        { type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } },
        { type: 'assistant/message', seq: 5, time: 5, data: { turn: 2, step: 0, message: { content: [] } } },
      ],
    })
    const child = await driver.forkSession({ sessionId: 'session-live', atTurn: 1 })
    expect(forks).toEqual([{ sessionId: 'session-live', atSeq: 3 }])
    expect(child.atTurn).toBe(1)
    expect(child.atSeq).toBe(3)
    // An unknown turn is a legible error that lists what the log does record.
    await expect(driver.forkSession({ sessionId: 'session-live', atTurn: 9 }))
      .rejects.toThrow(/turn 9 is not in session.*turns it records are: 1, 2/s)
    // Two ways of naming one cut are refused instead of silently preferring one.
    await expect(driver.forkSession({ sessionId: 'session-live', atSeq: 1, atTurn: 1 }))
      .rejects.toThrow(/atSeq or atTurn, not both/)
  })

  it('keeps the fork when the child cut cannot be read', async () => {
    const { driver } = driverWith({ readError: new Error('corpus is busy') })
    const child = await driver.forkSession({ sessionId: 'session-live' })
    // The session exists; a failed analytics read must not turn a successful fork
    // into an error the caller would retry.
    expect(child).toMatchObject({ sessionId: 'session-child', inheritedEventCount: 0 })
    expect(child.cwd).toBeUndefined()
  })

  it('refuses when the controller exposes no fork', async () => {
    const ctx = {
      get: (name: string) => (name === 'sessionController' ? {} : undefined),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }
    const driver = new DshDriver(ctx, () => testConfig())
    await expect(driver.forkSession({ sessionId: 'session-live' }))
      .rejects.toThrow(/no sessionController\.fork\(\)/)
  })

  it('surfaces the harness rejection for a boundary that does not exist', async () => {
    const { driver } = driverWith({
      fork: async () => {
        throw new Error('fork boundary 99 does not exist in session "session-live" (last seq: 5)')
      },
    })
    await expect(driver.forkSession({ sessionId: 'session-live', atSeq: 99 }))
      .rejects.toThrow(/boundary 99 does not exist/)
  })
})
