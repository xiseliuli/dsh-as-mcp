import { describe, expect, it } from 'vitest'

import { waitForSessionActivity } from '../src/dsh/driver.js'

/** A minimal event bus, in the shape `eventsOf(ctx)` consumes. */
function busContext(): {
  ctx: unknown
  emit(sessionId: string): void
  listeners(): number
} {
  const registered = new Set<(...args: unknown[]) => void>()
  const ctx = {
    on: (_name: string, listener: (...args: unknown[]) => void) => {
      registered.add(listener)
      return () => {
        registered.delete(listener)
      }
    },
  }
  return {
    ctx,
    emit: (sessionId) => {
      for (const listener of [...registered]) listener({ id: sessionId })
    },
    listeners: () => registered.size,
  }
}

/** Elapsed wall time for one await. */
async function timed(run: () => Promise<void>): Promise<number> {
  const started = Date.now()
  await run()
  return Date.now() - started
}

describe('waitForSessionActivity', () => {
  it('wakes on an event from its own session', async () => {
    const bus = busContext()
    setTimeout(() => bus.emit('session-1'), 5)
    const elapsed = await timed(() => waitForSessionActivity(bus.ctx, 'session-1', 5_000))
    expect(elapsed).toBeLessThan(1_000)
    // The listener is released, so a long-lived context does not accumulate one
    // per wait.
    expect(bus.listeners()).toBe(0)
  })

  it('ignores events from other sessions', async () => {
    const bus = busContext()
    const timer = setInterval(() => bus.emit('other-session'), 5)
    try {
      const elapsed = await timed(() => waitForSessionActivity(bus.ctx, 'session-1', 60))
      // Only the timeout (60 ms) ends this wait; the noisy neighbour does not.
      expect(elapsed).toBeGreaterThanOrEqual(40)
    } finally {
      clearInterval(timer)
    }
    expect(bus.listeners()).toBe(0)
  })

  it('ends at the timeout when nothing happens', async () => {
    const bus = busContext()
    const elapsed = await timed(() => waitForSessionActivity(bus.ctx, 'session-1', 40))
    expect(elapsed).toBeGreaterThanOrEqual(25)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('returns immediately when the signal is already aborted', async () => {
    const bus = busContext()
    const controller = new AbortController()
    controller.abort()
    const elapsed = await timed(() => waitForSessionActivity(bus.ctx, 'session-1', 5_000, controller.signal))
    expect(elapsed).toBeLessThan(50)
    expect(bus.listeners()).toBe(0)
  })

  it('wakes when the wait is aborted mid-flight', async () => {
    const bus = busContext()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    const elapsed = await timed(() => waitForSessionActivity(bus.ctx, 'session-1', 5_000, controller.signal))
    expect(elapsed).toBeLessThan(1_000)
    expect(bus.listeners()).toBe(0)
  })

  it('falls back to the timeout on a context with no event bus', async () => {
    const elapsed = await timed(() => waitForSessionActivity({}, 'session-1', 30))
    expect(elapsed).toBeGreaterThanOrEqual(15)
  })

  it('still times out when subscribing throws', async () => {
    const ctx = {
      on: () => {
        throw new Error('this context refuses subscriptions')
      },
    }
    const elapsed = await timed(() => waitForSessionActivity(ctx, 'session-1', 30))
    expect(elapsed).toBeGreaterThanOrEqual(15)
  })
})
