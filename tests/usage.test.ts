import { describe, expect, it } from 'vitest'

import {
  combineUsage,
  emptyBuckets,
  foldCompactionUsage,
  foldSessionUsage,
  isEmptyBuckets,
  projectionMatches,
  projectionTotals,
  sumTotals,
  toTotals,
  usageOfTurn,
} from '../src/dsh/usage.js'
import type { DshSessionEvent, DshTokenUsage } from '../src/dsh/types.js'

/** One durable-log entry. */
function event(type: string, data: unknown, seq: number, time = 1_700_000_000_000 + seq): DshSessionEvent {
  return { type, data, seq, time }
}

/** A usage record with the buckets a DeepSeek adapter reports. */
function usage(
  uncached: number,
  cacheRead: number,
  output: number,
  cacheWrite = 0,
): DshTokenUsage {
  return {
    inputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    totalTokens: uncached + cacheRead + cacheWrite + output,
  }
}

/** One assistant settlement carrying usage, as the agent loop commits it. */
function settlement(
  seq: number,
  turn: number,
  step: number,
  record: DshTokenUsage,
  route: { provider: string; model: string } = { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
): DshSessionEvent {
  return event('assistant/message', {
    turn,
    step,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', ...route },
    },
    usage: record,
  }, seq)
}

describe('foldSessionUsage', () => {
  it('sums disjoint buckets and derives totalTokens from them', () => {
    const folded = foldSessionUsage([
      settlement(1, 1, 1, usage(1000, 5000, 200)),
      settlement(2, 1, 2, usage(10, 9000, 50)),
    ])
    expect(folded.totals).toEqual({
      uncachedInputTokens: 1010,
      cacheReadTokens: 14000,
      cacheWriteTokens: 0,
      outputTokens: 250,
      totalTokens: 15260,
    })
    expect(folded.samples).toBe(2)
    expect(folded.ignoredSamples).toBe(0)
  })

  it('names the routes that charged each turn', () => {
    const folded = foldSessionUsage([
      settlement(1, 1, 1, usage(10, 0, 1), { provider: 'deepseek', model: 'cheap' }),
      settlement(2, 2, 1, usage(10, 0, 1), { provider: 'deepseek', model: 'expensive' }),
      settlement(3, 2, 2, usage(10, 0, 1), { provider: 'deepseek', model: 'expensive' }),
      // A sample with no source (a corrected/retried report) still counts toward the
      // turn's tokens, but it names no route, so the models list stays absent.
      event('assistant/message', {
        turn: 3,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: usage(5, 0, 0),
      }, 4),
    ])
    expect(folded.byTurn.map((turn) => [turn.turn, turn.models])).toEqual([
      [1, ['deepseek/cheap']],
      [2, ['deepseek/expensive']],
      [3, undefined],
    ])
  })

  it('reports each turn\'s wall-clock duration when the log has both boundaries', () => {
    const folded = foldSessionUsage([
      event('turn/start', { turn: 1 }, 1, 1_000),
      settlement(2, 1, 1, usage(10, 0, 1)),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3, 2_500),
      // A turn still running has a start but no end: no guessed duration.
      event('turn/start', { turn: 2 }, 4, 3_000),
      settlement(5, 2, 1, usage(10, 0, 1)),
    ])
    expect(folded.byTurn.map((turn) => [turn.turn, turn.durationMs])).toEqual([
      [1, 1_500],
      [2, undefined],
    ])
  })

  it('attributes usage per turn and counts the steps inside each', () => {
    const folded = foldSessionUsage([
      settlement(1, 1, 1, usage(100, 0, 10)),
      settlement(2, 1, 2, usage(100, 0, 10)),
      settlement(3, 2, 1, usage(100, 0, 10)),
    ])
    expect(folded.byTurn).toEqual([
      {
        turn: 1,
        steps: 2,
        uncachedInputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        totalTokens: 220,
        models: ['deepseek/deepseek-v4.1-flash'],
      },
      {
        turn: 2,
        steps: 1,
        uncachedInputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10,
        totalTokens: 110,
        models: ['deepseek/deepseek-v4.1-flash'],
      },
    ])
    expect(folded.byTurn.reduce((sum, turn) => sum + turn.totalTokens, 0)).toBe(folded.totals.totalTokens)
    expect(usageOfTurn(folded, 2)?.totalTokens).toBe(110)
    // No turn began, so there is no turn to report — not an error, an empty answer.
    expect(usageOfTurn(folded, null)).toBeUndefined()
    expect(usageOfTurn(folded, 9)).toBeUndefined()
  })

  it('replaces a re-reported sample for the same (turn, step) instead of double counting', () => {
    // The same step can settle with a newer cumulative sample as a stream ends;
    // the harness projection subtracts the previous slot, so the fold must too.
    const folded = foldSessionUsage([
      settlement(1, 1, 1, usage(100, 0, 10)),
      settlement(2, 1, 1, usage(300, 0, 40)),
    ])
    expect(folded.totals.uncachedInputTokens).toBe(300)
    expect(folded.totals.outputTokens).toBe(40)
    // A correction is the same call reported again, not a second billed call.
    expect(folded.samples).toBe(1)
    expect(folded.byModel.reduce((sum, row) => sum + row.samples, 0)).toBe(folded.samples)
  })

  it('is a no-op for an identical re-report', () => {
    const folded = foldSessionUsage([
      settlement(1, 1, 1, usage(100, 0, 10)),
      settlement(2, 1, 1, usage(100, 0, 10)),
    ])
    expect(folded.totals.uncachedInputTokens).toBe(100)
    // An identical re-report is not a second contribution: the fold skips it the
    // same way the harness projection returns its state unchanged.
    expect(folded.samples).toBe(1)
  })

  it('keeps a failed attempt and adds the retried attempt', () => {
    // llm-retry logs: failed assistant/attempt -> llm/retry -> llm/retry-started
    // -> the retried attempt settles as assistant/message. Both attempts were
    // billed, so both count; the projection clears its slot on retry-started and
    // so does this fold.
    const failed: DshSessionEvent = event('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{ type: 'chunk', chunk: { type: 'usage', usage: usage(10, 2, 3) } }],
    }, 1)
    const folded = foldSessionUsage([
      failed,
      event('llm/retry', { turn: 1, step: 1 }, 2),
      event('llm/retry-started', { turn: 1, step: 1 }, 3),
      settlement(4, 1, 1, usage(14, 5, 8)),
    ])
    expect(folded.totals).toEqual({
      uncachedInputTokens: 24,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      outputTokens: 11,
      totalTokens: 42,
    })
    expect(folded.samples).toBe(2)
  })

  it('does not let a retry clear a slot belonging to a different step', () => {
    const folded = foldSessionUsage([
      settlement(1, 1, 1, usage(100, 0, 10)),
      event('llm/retry-started', { turn: 1, step: 2 }, 2),
      settlement(3, 1, 2, usage(100, 0, 10)),
    ])
    expect(folded.totals.uncachedInputTokens).toBe(200)
  })

  it('reads usage out of the stream when the settlement carries no usage field', () => {
    const folded = foldSessionUsage([
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [], source: { provider: 'deepseek', model: 'm' } },
        stream: [
          { type: 'chunk', chunk: { type: 'text', text: 'hi' } },
          { type: 'chunk', chunk: { type: 'usage', usage: usage(7, 3, 2) } },
        ],
      }, 1),
    ])
    expect(folded.totals).toEqual({
      uncachedInputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      outputTokens: 2,
      totalTokens: 12,
    })
  })

  it('keeps the last usage chunk when a stream reports several', () => {
    const folded = foldSessionUsage([
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [], source: { provider: 'deepseek', model: 'm' } },
        stream: [
          { type: 'chunk', chunk: { type: 'usage', usage: usage(1, 1, 1) } },
          { type: 'chunk', chunk: { type: 'usage', usage: usage(9, 9, 9) } },
        ],
      }, 1),
    ])
    expect(folded.totals.totalTokens).toBe(27)
  })

  it('groups by provider and model, with an unattributed row for retries', () => {
    const folded = foldSessionUsage([
      settlement(1, 1, 1, usage(100, 0, 10), { provider: 'deepseek', model: 'v4' }),
      settlement(2, 1, 2, usage(100, 0, 10), { provider: 'other', model: 'x' }),
      // A retried attempt carries no assistant message, so no route to name.
      event('assistant/attempt', {
        turn: 1,
        step: 3,
        stream: [{ type: 'chunk', chunk: { type: 'usage', usage: usage(5, 0, 1) } }],
      }, 3),
    ])
    expect(folded.byModel.map((row) => [row.provider, row.model, row.totalTokens])).toEqual([
      ['deepseek', 'v4', 110],
      ['other', 'x', 110],
      [null, null, 6],
    ])
    expect(folded.byModel.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(226)
    expect(folded.byModel.reduce((sum, row) => sum + row.samples, 0)).toBe(3)
  })

  it('reports a sample it cannot read instead of folding NaN into the total', () => {
    const broken = { inputTokens: 'many', outputTokens: 3 } as unknown as DshTokenUsage
    const folded = foldSessionUsage([
      settlement(1, 1, 1, usage(100, 0, 10)),
      settlement(2, 1, 2, broken),
    ])
    expect(folded.totals.uncachedInputTokens).toBe(100)
    expect(folded.ignoredSamples).toBe(1)
  })

  it('excludes a fork-inherited prefix when asked to', () => {
    // A forked session replays its parent's events as its own first events; that
    // spend belongs to the parent, so `fromSeq` is the inherited event count.
    const events = [
      settlement(0, 1, 1, usage(1000, 0, 100)),
      settlement(1, 2, 1, usage(2000, 0, 200)),
    ]
    const all = foldSessionUsage(events)
    const own = foldSessionUsage(events, { fromSeq: 1 })
    expect(all.totals.uncachedInputTokens).toBe(3000)
    expect(own.totals.uncachedInputTokens).toBe(2000)
    expect(own.byTurn.map((turn) => turn.turn)).toEqual([2])
  })

  it('answers an empty log with zeros, not an error', () => {
    const folded = foldSessionUsage([])
    expect(folded.totals.totalTokens).toBe(0)
    expect(folded.byTurn).toEqual([])
    expect(folded.byModel).toEqual([])
    expect(folded.samples).toBe(0)
  })

  it('ignores events that are not settlements', () => {
    const folded = foldSessionUsage([
      event('turn/start', { turn: 1 }, 1),
      event('user/message', { turn: 1, content: [] }, 2),
      event('tool/call', { turn: 1, step: 1, name: 'bash' }, 3),
      event('step/end', { turn: 1, step: 1 }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ])
    expect(folded.samples).toBe(0)
    expect(folded.totals.totalTokens).toBe(0)
  })
})

describe('foldCompactionUsage', () => {
  it('sums the summarization calls separately from conversation usage', () => {
    const folded = foldCompactionUsage([
      event('compaction/summary', { compactionId: 'c', provider: 'deepseek', model: 'v4', usage: usage(900, 100, 40) }, 1),
      event('compaction/summary', { compactionId: 'd', provider: 'deepseek', model: 'v4' }, 2),
      event('compaction/summary', { compactionId: 'e', provider: 'deepseek', model: 'v4', usage: { inputTokens: 1 } }, 3),
    ])
    // A summary with no usage record is a prune, not a failure; a malformed one
    // is counted as ignored.
    expect(folded.summaries).toBe(1)
    expect(folded.ignoredSummaries).toBe(1)
    expect(folded.totals.totalTokens).toBe(1040)
  })

  it('honours fromSeq for a forked session', () => {
    const folded = foldCompactionUsage([
      event('compaction/summary', { usage: usage(100, 0, 10) }, 0),
      event('compaction/summary', { usage: usage(7, 0, 1) }, 1),
    ], { fromSeq: 1 })
    expect(folded.totals.totalTokens).toBe(8)
  })
})

describe('projection helpers', () => {
  it('reads the harness view shape', () => {
    expect(projectionTotals({
      uncachedInputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    })).toEqual({
      uncachedInputTokens: 1,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      outputTokens: 2,
      totalTokens: 10,
    })
  })

  it('refuses an incomplete or absent projection', () => {
    expect(projectionTotals(undefined)).toBeUndefined()
    expect(projectionTotals({ uncachedInputTokens: 1, outputTokens: 2 })).toBeUndefined()
  })

  it('compares buckets, not derived totals', () => {
    expect(projectionMatches(
      { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 },
      { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 },
    )).toBe(true)
    expect(projectionMatches(
      { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 },
      { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 5 },
    )).toBe(false)
  })
})

describe('bucket arithmetic', () => {
  it('totals the four disjoint buckets', () => {
    expect(toTotals({ uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }).totalTokens).toBe(10)
    expect(isEmptyBuckets(emptyBuckets())).toBe(true)
    expect(isEmptyBuckets(toTotals({ uncachedInputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 0 }))).toBe(false)
  })

  it('sums totals and combines per-model rows across sessions', () => {
    const one = foldSessionUsage([settlement(1, 1, 1, usage(10, 0, 1), { provider: 'deepseek', model: 'v4' })])
    const two = foldSessionUsage([
      settlement(1, 1, 1, usage(20, 0, 2), { provider: 'deepseek', model: 'v4' }),
      settlement(2, 1, 2, usage(30, 0, 3), { provider: 'other', model: 'x' }),
    ])
    const combined = combineUsage([one, two])
    expect(combined.totals.totalTokens).toBe(11 + 22 + 33)
    expect(combined.samples).toBe(3)
    expect(combined.byModel.map((row) => [row.provider, row.model, row.totalTokens])).toEqual([
      // Equal totals tie-break on the route name, so the order is stable.
      ['deepseek', 'v4', 33],
      ['other', 'x', 33],
    ])
    // Turn numbers are session-local, so a combined report never carries them.
    expect(combined.byTurn).toEqual([])
    expect(sumTotals([one.totals, two.totals]).totalTokens).toBe(combined.totals.totalTokens)
  })
})
