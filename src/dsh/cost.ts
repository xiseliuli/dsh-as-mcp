/**
 * Money, when this DSH profile has a plugin that knows prices.
 *
 * Token counts live in the harness (`usage.ts` folds them out of the durable
 * log). Prices do not: the harness has no billing or currency service at all, so
 * "how much did this session cost" can only be answered by a plugin that
 * maintains a price catalog. The one that does on this machine is the
 * third-party **`dsh-cost-meter`**, which registers a host service
 * `costMeter` with a `getSessionCost(sessionId)` method
 * (`dsh-cost-meter/lib/index.js:3795,2923`).
 *
 * This module is the whole of that integration, and it is deliberately
 * defensive:
 *
 * - The service is resolved by name through `ctx.get`, never imported, so a
 *   profile without the plugin is not a load-time failure.
 * - Every call is guarded: a missing service, a foreign ledger, a thrown
 *   method, or `found: false` all become `available: false` with a reason a
 *   caller can read. Token counts are unaffected either way.
 * - Both amounts are labelled with what they are, because the two differ and
 *   conflating them is the easy mistake. See {@link CostReport}.
 *
 * @module dsh-as-mcp/dsh/cost
 */

import { serviceOf, type DshCostMeter } from './types.js'

/** The service name `dsh-cost-meter` provides. */
const COST_METER_SERVICE = 'costMeter'

/**
 * What this endpoint could learn about money for one session.
 *
 * cost-meter keeps two USD figures per session, and they answer different
 * questions:
 *
 * - **`costUsd`** is the real money charged — its `apiCost`, which is `0` for
 *   calls covered by a subscription or coding plan, because no per-token money
 *   left the account. It is the field to sum when the question is "what did this
 *   cost me".
 * - **`costEstimateUsd`** is the list-price estimate — its `cost`, computed from
 *   the price catalog regardless of how the call was billed. It is what the
 *   session would have cost at API rates, and it is the only figure that moves
 *   for a plan-covered session.
 *
 * Neither is an invoice: cost-meter prices from a bundled catalog, applies
 * peak/off-peak windows, and matches an unrecognised provider route by model
 * name. The harness ledger is USD-canonical, so both amounts are USD; the CNY and
 * EUR fields cost-meter keeps are frozen FX copies of the estimate, passed
 * through unchanged rather than converted here.
 */
export interface CostReport {
  /** False when no price source answered; `reason` then says why. */
  readonly available: boolean
  /** Which service produced the number. */
  readonly source?: 'dsh-cost-meter'
  /**
   * True whenever the amounts came from a price catalog rather than an invoice.
   * Always true for this source; stated so a caller does not bill customers off
   * it.
   */
  readonly estimate?: boolean
  /**
   * Real-money USD charged: cost-meter's `apiCost`, and the field to sum across
   * sessions. `0` for a call a subscription plan covered.
   */
  readonly costUsd?: number
  /**
   * List-price USD estimate: cost-meter's `cost`. This is what the session would
   * have cost at API rates, which is why it differs from {@link costUsd} on a
   * plan-covered route.
   */
  readonly costEstimateUsd?: number
  /** cost-meter's frozen CNY/EUR copies of the estimate, passed through untouched. */
  readonly costCny?: number
  readonly costEur?: number
  /** LLM calls cost-meter booked: turns, compaction, and titling. */
  readonly calls?: number
  /** Set when `available` is false, or when a combined total is incomplete. */
  readonly reason?: string
  /** Set when some sessions in a combined total had no price source. */
  readonly partial?: boolean
}

/** A number cost-meter could have reported. */
function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The money fields of one cost-meter ledger row, as this plugin reports them. */
function reportFrom(
  own: {
    readonly calls?: unknown
    readonly cost?: unknown
    readonly apiCost?: unknown
    readonly costCny?: unknown
    readonly costEur?: unknown
  },
): CostReport {
  // Older ledger snapshots predate `apiCost` (added when plan and API spend were
  // split), and cost-meter reads such a row as "all of it was API money" — the
  // same fallback is used here so a pre-split row is not reported as zero.
  const costUsd = isAmount(own.apiCost) ? own.apiCost : isAmount(own.cost) ? own.cost : undefined
  return {
    available: true,
    source: 'dsh-cost-meter',
    estimate: true,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(isAmount(own.cost) ? { costEstimateUsd: own.cost } : {}),
    ...(isAmount(own.costCny) ? { costCny: own.costCny } : {}),
    ...(isAmount(own.costEur) ? { costEur: own.costEur } : {}),
    ...(isAmount(own.calls) ? { calls: own.calls } : {}),
  }
}

/**
 * The money one session cost, or an explanation of why that is unknown.
 *
 * Never throws: a caller that asked for tokens and money must still get its
 * tokens when the price plugin is absent, broken, or has no row for this
 * session.
 *
 * @param ctx - the plugin's Cordis context.
 * @param sessionId - the session to price.
 * @returns a report; `available: false` carries a reason.
 */
export async function readSessionCost(ctx: unknown, sessionId: string): Promise<CostReport> {
  const service = serviceOf<DshCostMeter>(ctx, COST_METER_SERVICE)
  if (typeof service?.getSessionCost !== 'function') {
    return {
      available: false,
      reason:
        'no price source in this DSH profile: the optional dsh-cost-meter plugin is not installed, '
        + 'and the harness itself exposes tokens only',
    }
  }
  try {
    const result = await service.getSessionCost(sessionId)
    if (result === undefined || result === null || result.found !== true) {
      return {
        available: false,
        reason:
          'dsh-cost-meter has no ledger entry for this session (it may have been created before the '
          + 'plugin was installed, or pruned by its retention window)',
      }
    }
    return reportFrom(result.own ?? {})
  } catch (error) {
    return {
      available: false,
      reason: `dsh-cost-meter failed to price this session: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Add per-session money into one total.
 *
 * Summing money across sessions means {@link CostReport.costUsd} (real money, in
 * the ledger's own currency), and the list-price estimate is summed beside it when
 * every priced row reports one. Both are "the same figure on every row", which is
 * what makes a total meaningful. A row with no usable `costUsd` (no price source, or a ledger row
 * that predates it) makes the total `partial`; a total with no priced row at all
 * stays unavailable with the first reason.
 *
 * @param reports - per-session reports, in report order.
 */
export function combineCosts(reports: readonly CostReport[]): CostReport {
  const priced = reports.filter((report) => report.available && report.costUsd !== undefined)
  const unpriced = reports.filter((report) => !report.available || report.costUsd === undefined)
  if (priced.length === 0) {
    const reason = reports.find((report) => !report.available && report.reason !== undefined)?.reason
    return {
      available: false,
      ...(reason === undefined
        ? { reason: 'no session in this report has a priced ledger entry' }
        : { reason }),
    }
  }
  const costUsd = priced.reduce((sum, report) => sum + (report.costUsd ?? 0), 0)
  // The estimate is summed separately and only when every priced row has one:
  // a total that silently omitted part of the list-price value would be as wrong
  // as one that omitted part of the real money.
  const estimates = priced.map((report) => report.costEstimateUsd)
  const costEstimateUsd = estimates.every((amount): amount is number => amount !== undefined)
    ? estimates.reduce((sum, amount) => sum + amount, 0)
    : undefined
  return {
    available: true,
    source: 'dsh-cost-meter',
    estimate: true,
    costUsd,
    ...(costEstimateUsd === undefined ? {} : { costEstimateUsd }),
    ...(unpriced.length === 0
      ? {}
      : {
        partial: true,
        reason: `${unpriced.length} of ${reports.length} session(s) could not be priced, so this total is incomplete`,
      }),
  }
}
