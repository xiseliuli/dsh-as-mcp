/**
 * The usage payload shapes an MCP caller receives, assembled from one session cut.
 *
 * `usage.ts` is the arithmetic; this module is the report. It exists separately
 * for two reasons: the driver stays about harness services rather than payload
 * shapes, and the assembly rules below — which number is compared with the
 * harness's own projection, what "partial" means, when `byTurn` is present —
 * are decisions a reader should find in one place.
 *
 * Two sources are combined, and they are not the same number:
 *
 * - **`totals`** is folded from the durable log (`usage.ts`), which is what the
 *   caller is billed against and the only figure that decomposes per turn and
 *   per model.
 * - **`verifiedAgainstProjection`** records whether the harness's own cumulative
 *   `tokenUsage` projection was present *and* agreed. When it is present and
 *   disagrees, `projectionTotals` carries the harness figure so the disagreement
 *   is visible instead of silently resolved.
 *
 * @module dsh-as-mcp/dsh/report
 */

import type { DshSessionEvent } from './types.js'
import {
  foldCompactionUsage,
  foldSessionUsage,
  projectionMatches,
  projectionTotals,
  subtractTotals,
  sumTotals,
  type CompactionUsage,
  type ModelUsage,
  type TurnUsage,
  type UsageTotals,
} from './usage.js'

/**
 * One immutable read of a session's usage inputs.
 *
 * A cut exists so the events that were folded and the projection that is used to
 * verify them come from the same read of the same log, rather than two reads that
 * could straddle an append.
 */
export interface UsageCut {
  readonly sessionId: string
  readonly events: readonly DshSessionEvent[]
  /**
   * Number of leading events inherited from a forked parent.
   *
   * Their usage was billed to the parent session, so it is reported separately
   * as {@link UsageSummary.inherited} rather than folded into `totals`.
   */
  readonly inheritedEventCount: number
  readonly cwd?: string
  /** The harness's `tokenUsage` projection value, when the host exposed one. */
  readonly projection?: unknown
}

/** Usage without the per-turn breakdown — the shape every report carries. */
export interface UsageSummary {
  readonly totals: UsageTotals
  /** Per-route totals, largest first; an unattributed row when retries carried no route. */
  readonly byModel: readonly ModelUsage[]
  /** How many turns reported usage. */
  readonly turns: number
  /** How many steps within those turns reported usage. */
  readonly steps: number
  /** How many assistant settlements were folded. */
  readonly samples: number
  /** Usage billed to the session this one was forked from; present only when forked. */
  readonly inherited?: UsageTotals
  /** Summarizing-compaction spend; excluded from `totals` on purpose. */
  readonly compaction?: CompactionUsage
  /** True when the harness's own projection was present and matched `totals`. */
  readonly verifiedAgainstProjection: boolean
  /** The harness's own figure, present only when it disagreed with the log fold. */
  readonly projectionTotals?: UsageTotals
  /** Samples whose usage record could not be read; present only when non-zero. */
  readonly ignoredSamples?: number
  /**
   * True when the turn being described had not finished, so these totals can
   * still grow: a turn still running when the log was read, or a settle that was
   * cut short by a timeout, a client abort, or a cancellation.
   */
  readonly partial?: boolean
}

/** Usage with the per-turn breakdown, as the `session_usage` tool reports it. */
export interface UsageReport extends UsageSummary {
  /** Per-turn totals, ascending. */
  readonly byTurn: readonly TurnUsage[]
}

/** Options that decide how much detail a report carries. */
export interface UsageBuildOptions {
  /** Include the per-turn breakdown (the aggregate path drops it when unasked). */
  readonly includeTurns?: boolean
  /** Mark the totals as still growing (a turn that has not settled). */
  readonly partial?: boolean
}

/** How many turns and steps a fold covered. */
function counts(byTurn: readonly TurnUsage[]): { turns: number; steps: number } {
  let steps = 0
  for (const turn of byTurn) steps += turn.steps
  return { turns: byTurn.length, steps }
}

/**
 * Fold one cut into a usage report.
 *
 * The whole log is folded, and then — only for a forked session — folded again
 * from {@link UsageCut.inheritedEventCount} so the child's own spend is
 * separated from its parent's. The second fold is skipped when there is no
 * inherited prefix, which is every session this endpoint creates.
 *
 * @param cut - the read to fold.
 * @param options - detail and partiality.
 */
export function buildUsageReport(cut: UsageCut, options: UsageBuildOptions = {}): UsageReport {
  const fromSeq = cut.inheritedEventCount > 0 ? cut.inheritedEventCount : 0
  const own = foldSessionUsage(cut.events, { fromSeq })
  // The inherited prefix is derived as "whole log minus own spend" rather than by
  // folding the prefix on its own: the fold's replacement rule is sequential, so
  // the two are only guaranteed to add up when one is defined from the other.
  const inherited = fromSeq === 0
    ? undefined
    : subtractTotals(foldSessionUsage(cut.events).totals, own.totals)
  const compaction = foldCompactionUsage(cut.events, { fromSeq })

  // The harness projection covers the whole log, inherited prefix included,
  // while `totals` is this session's own spend. Comparing the two therefore
  // means comparing the projection with the sum, not with `totals` alone.
  const projection = projectionTotals(cut.projection)
  const comparable = inherited === undefined ? own.totals : sumTotals([inherited, own.totals])
  const verified = projection !== undefined && projectionMatches(projection, comparable)

  const { turns, steps } = counts(own.byTurn)
  return {
    totals: own.totals,
    byModel: own.byModel,
    turns,
    steps,
    samples: own.samples,
    ...(inherited === undefined ? {} : { inherited }),
    ...(compaction.summaries === 0 && compaction.ignoredSummaries === 0
      ? {}
      : { compaction }),
    verifiedAgainstProjection: verified,
    ...(projection === undefined || verified ? {} : { projectionTotals: projection }),
    ...(own.ignoredSamples === 0 ? {} : { ignoredSamples: own.ignoredSamples }),
    ...(options.partial === true ? { partial: true } : {}),
    // The aggregate path asks for totals only: a merged report of many sessions
    // would otherwise carry a per-turn array per row for no reader.
    byTurn: options.includeTurns === false ? [] : own.byTurn,
  }
}

/** Drop the per-turn breakdown from a report, for a response that should stay small. */
export function summarizeUsage(report: UsageReport): UsageSummary {
  const { byTurn: _byTurn, ...summary } = report
  return summary
}
