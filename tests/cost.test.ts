import { describe, expect, it } from 'vitest'

import { combineCosts, readSessionCost, type CostReport } from '../src/dsh/cost.js'

/**
 * A Cordis-shaped context whose `get(name)` returns the given services.
 *
 * `serviceOf` in `src/dsh/types.ts` is the only thing the cost module touches,
 * so this is enough to drive it without a Cordis runtime.
 */
function contextWith(services: Record<string, unknown>): { get(name: string): unknown } {
  return { get: (name) => services[name] }
}

describe('readSessionCost', () => {
  it('explains an absent price source instead of failing', async () => {
    const report = await readSessionCost(contextWith({}), 'session-1')
    expect(report.available).toBe(false)
    expect(report.reason).toContain('dsh-cost-meter plugin is not installed')
    // The important part: no throw, so the caller still gets its token counts.
    expect(report.costUsd).toBeUndefined()
  })

  it('treats a service without the method as absent', async () => {
    const report = await readSessionCost(contextWith({ costMeter: {} }), 'session-1')
    expect(report.available).toBe(false)
  })

  it('reports real money as apiCost, and the list-price estimate separately', async () => {
    const report = await readSessionCost(contextWith({
      costMeter: {
        getSessionCost: async () => ({
          found: true,
          own: { id: 'session-1', calls: 12, cost: 0.5, apiCost: 0.4, costCny: 3.2, costEur: 0.44 },
        }),
      },
    }), 'session-1')
    expect(report).toEqual({
      available: true,
      source: 'dsh-cost-meter',
      estimate: true,
      // `apiCost` is real money; `cost` is the list-price estimate in USD, which
      // differs from it on a plan-covered route.
      costUsd: 0.4,
      costEstimateUsd: 0.5,
      costCny: 3.2,
      costEur: 0.44,
      calls: 12,
    })
  })

  it('reports a plan-covered call as zero real money but a non-zero estimate', async () => {
    const report = await readSessionCost(contextWith({
      costMeter: {
        getSessionCost: async () => ({ found: true, own: { id: 's', calls: 2, cost: 0.25, apiCost: 0 } }),
      },
    }), 's')
    // A subscription covered the call: nothing left the account, but the
    // list-price estimate still says what it would have cost at API rates.
    expect(report.costUsd).toBe(0)
    expect(report.costEstimateUsd).toBe(0.25)
  })

  it('falls back to cost for a ledger row written before apiCost existed', async () => {
    const report = await readSessionCost(contextWith({
      costMeter: {
        getSessionCost: async () => ({ found: true, own: { id: 's', calls: 1, cost: 0.25 } }),
      },
    }), 's')
    expect(report.costUsd).toBe(0.25)
  })

  it('says so when the ledger has no row for the session', async () => {
    const report = await readSessionCost(contextWith({
      costMeter: { getSessionCost: async () => ({ found: false, own: { id: 's', calls: 0, cost: 0 } }) },
    }), 's')
    expect(report.available).toBe(false)
    expect(report.reason).toContain('no ledger entry')
  })

  it('contains a throwing price service', async () => {
    const report = await readSessionCost(contextWith({
      costMeter: {
        getSessionCost: async () => {
          throw new Error('ledger is being rewritten')
        },
      },
    }), 's')
    expect(report.available).toBe(false)
    expect(report.reason).toContain('ledger is being rewritten')
  })
})

describe('combineCosts', () => {
  const priced = (costUsd: number): CostReport => ({ available: true, source: 'dsh-cost-meter', estimate: true, costUsd })
  const unpriced: CostReport = { available: false, reason: 'no price source' }

  it('stays unavailable when nothing was priced', () => {
    const combined = combineCosts([unpriced, unpriced])
    expect(combined.available).toBe(false)
    expect(combined.reason).toBe('no price source')
  })

  it('sums USD and marks a total that skipped an unpriced session', () => {
    const combined = combineCosts([priced(0.5), unpriced, priced(0.25)])
    expect(combined.available).toBe(true)
    expect(combined.costUsd).toBe(0.75)
    expect(combined.partial).toBe(true)
    expect(combined.reason).toContain('1 of 3')
  })

  it('is complete when every session was priced', () => {
    const combined = combineCosts([priced(0.5), priced(0.5)])
    expect(combined.partial).toBeUndefined()
    expect(combined.costUsd).toBe(1)
  })

  it('sums real money only, never the list-price estimate', () => {
    const combined = combineCosts([
      { available: true, source: 'dsh-cost-meter', costUsd: 0, costEstimateUsd: 9 },
      { available: true, source: 'dsh-cost-meter', costUsd: 0.5, costEstimateUsd: 9 },
    ])
    // A plan-covered row contributes 0 real money; the estimate is not spend.
    expect(combined.costUsd).toBe(0.5)
  })

  it('explains an empty report', () => {
    expect(combineCosts([]).reason).toContain('no session in this report')
  })

  it('sums the list-price estimate beside real money when every priced row has one', () => {
    const combined = combineCosts([
      { available: true, source: 'dsh-cost-meter', estimate: true, costUsd: 0.5, costEstimateUsd: 0.8 },
      { available: true, source: 'dsh-cost-meter', estimate: true, costUsd: 0, costEstimateUsd: 0.2 },
    ])
    // Real money and the list-price estimate are different questions, so both
    // totals are reported rather than one being derived from the other.
    expect(combined.costUsd).toBe(0.5)
    expect(combined.costEstimateUsd).toBe(1)
  })

  it('omits the estimate total when a priced row does not report one', () => {
    const combined = combineCosts([
      { available: true, source: 'dsh-cost-meter', estimate: true, costUsd: 0.5, costEstimateUsd: 0.8 },
      { available: true, source: 'dsh-cost-meter', estimate: true, costUsd: 0.1 },
    ])
    expect(combined.costUsd).toBe(0.6)
    // A partial estimate would understate list-price value, so it is omitted
    // rather than reported as if complete.
    expect(combined.costEstimateUsd).toBeUndefined()
  })

  it('does not claim a price source was missing when the row simply had no ledger entry', () => {
    const combined = combineCosts([
      { available: true, source: 'dsh-cost-meter', costUsd: 1 },
      { available: false, reason: 'dsh-cost-meter has no ledger entry for this session' },
    ])
    expect(combined.reason).toContain('could not be priced')
    expect(combined.reason).not.toContain('no price source')
  })
})
