import { describe, expect, it } from 'vitest'

import { buildUsageReport, summarizeUsage, type UsageCut } from '../src/dsh/report.js'
import type { DshSessionEvent, DshTokenUsage } from '../src/dsh/types.js'

/** One durable-log entry. */
function event(type: string, data: unknown, seq: number): DshSessionEvent {
  return { type, data, seq, time: 1_700_000_000_000 + seq }
}

/** A usage record. */
function usage(uncached: number, cacheRead: number, output: number): DshTokenUsage {
  return { inputTokens: uncached, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output }
}

/** One assistant settlement carrying usage. */
function settlement(seq: number, turn: number, step: number, record: DshTokenUsage): DshSessionEvent {
  return event('assistant/message', {
    turn,
    step,
    message: { content: [], source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    usage: record,
  }, seq)
}

/** The harness's own projection value for the totals a cut folds to. */
function projectionOf(uncached: number, cacheRead: number, output: number): unknown {
  return {
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: output,
  }
}

/** A cut over a one-turn, one-model log. */
function cut(overrides: Partial<UsageCut> = {}): UsageCut {
  return {
    sessionId: 'session-1',
    events: [
      settlement(1, 1, 1, usage(100, 1000, 10)),
      settlement(2, 1, 2, usage(50, 2000, 5)),
    ],
    inheritedEventCount: 0,
    ...overrides,
  }
}

describe('buildUsageReport', () => {
  it('folds totals, per-turn and per-model from one cut', () => {
    const report = buildUsageReport(cut())
    expect(report.totals).toEqual({
      uncachedInputTokens: 150,
      cacheReadTokens: 3000,
      cacheWriteTokens: 0,
      outputTokens: 15,
      totalTokens: 3165,
    })
    expect(report.turns).toBe(1)
    expect(report.steps).toBe(2)
    expect(report.samples).toBe(2)
    expect(report.byTurn.map((turn) => turn.turn)).toEqual([1])
    expect(report.byModel[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  })

  it('verifies the fold against the harness projection when it agrees', () => {
    const report = buildUsageReport(cut({ projection: projectionOf(150, 3000, 15) }))
    expect(report.verifiedAgainstProjection).toBe(true)
    expect(report.projectionTotals).toBeUndefined()
  })

  it('shows the harness figure when it disagrees, instead of hiding the disagreement', () => {
    const report = buildUsageReport(cut({ projection: projectionOf(999, 999, 999) }))
    expect(report.verifiedAgainstProjection).toBe(false)
    expect(report.projectionTotals).toEqual({
      uncachedInputTokens: 999,
      cacheReadTokens: 999,
      cacheWriteTokens: 0,
      outputTokens: 999,
      totalTokens: 2997,
    })
    // The log fold stays authoritative: it is the number that decomposes.
    expect(report.totals.uncachedInputTokens).toBe(150)
  })

  it('reports no verification when the host exposes no projection', () => {
    const report = buildUsageReport(cut())
    expect(report.verifiedAgainstProjection).toBe(false)
    expect(report.projectionTotals).toBeUndefined()
  })

  it('separates a forked prefix from the session own spend', () => {
    // Events 0 and 1 are the inherited prefix; the verification compares the
    // projection against own + inherited, because that is the whole log.
    const report = buildUsageReport({
      sessionId: 'session-1',
      events: [
        settlement(0, 1, 1, usage(1000, 0, 100)),
        settlement(1, 2, 1, usage(2000, 0, 200)),
        settlement(2, 3, 1, usage(3000, 0, 300)),
      ],
      inheritedEventCount: 2,
      projection: projectionOf(6000, 0, 600),
    })
    expect(report.totals.uncachedInputTokens).toBe(3000)
    expect(report.inherited?.uncachedInputTokens).toBe(3000)
    expect(report.turns).toBe(1)
    expect(report.verifiedAgainstProjection).toBe(true)
  })

  it('carries compaction spend separately, never inside the conversation total', () => {
    const report = buildUsageReport({
      ...cut(),
      events: [
        ...cut().events,
        event('compaction/summary', { compactionId: 'c', usage: usage(900, 0, 40) }, 3),
      ],
    })
    expect(report.totals.uncachedInputTokens).toBe(150)
    expect(report.compaction?.totals.uncachedInputTokens).toBe(900)
    expect(report.compaction?.summaries).toBe(1)
  })

  it('omits the compaction block when the log has none', () => {
    expect(buildUsageReport(cut()).compaction).toBeUndefined()
  })

  it('marks a still-growing report partial when asked', () => {
    expect(buildUsageReport(cut(), { partial: true }).partial).toBe(true)
    expect(buildUsageReport(cut(), { partial: false }).partial).toBeUndefined()
  })

  it('drops the per-turn breakdown when unasked but keeps the counts', () => {
    const report = buildUsageReport(cut(), { includeTurns: false })
    expect(report.byTurn).toEqual([])
    expect(report.turns).toBe(1)
    expect(report.steps).toBe(2)
  })

  it('summarizeUsage removes only the per-turn array', () => {
    const summary = summarizeUsage(buildUsageReport(cut(), { includeTurns: true }))
    expect(Object.hasOwn(summary, 'byTurn')).toBe(false)
    expect(summary.totals.totalTokens).toBe(3165)
  })

  it('answers an empty log with zeros', () => {
    const report = buildUsageReport({ sessionId: 's', events: [], inheritedEventCount: 0 })
    expect(report.totals.totalTokens).toBe(0)
    expect(report.turns).toBe(0)
    expect(report.verifiedAgainstProjection).toBe(false)
  })
})
