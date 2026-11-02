/**
 * Token usage, folded out of the durable session log.
 *
 * The harness records provider-reported usage on the assistant settlement events
 * themselves — `assistant/message.data.usage` (and, on a retried attempt, the
 * usage chunk inside `assistant/attempt.data.stream`). There is no event that
 * carries a turn's aggregate: `turn/end` is `{ turn, reason }` only. The total
 * the DSH UI shows for a session is a session *projection*
 * (`tokenUsage`, `packages/llm/token-meter/src/usage-projection.ts`), and the
 * per-turn figure next to a reply is a pure client-side fold over the same
 * events (`token-meter/src/turn-usage.ts`).
 *
 * This module reimplements that fold, and only that fold, from the event shapes
 * themselves. Two reasons it is not imported from the harness:
 *
 * 1. This package imports no `@deepseek-ai/*` module at runtime (see
 *    `src/dsh/types.ts`): the published artifacts trail the harness inside DSH
 *    Desktop, and an import that resolves in one profile is a boot failure in
 *    another.
 * 2. The fold is the whole contract. Keeping it here makes the arithmetic that
 *    a caller bills against reviewable in one file, with tests, instead of
 *    depending on an internal helper whose signature is free to change.
 *
 * The replacement rule is the projection's, and it is load-bearing:
 *
 * - A usage sample is filed under its `(turn, step)` slot. A newer sample for
 *   the same slot **replaces** the older one rather than adding to it, because
 *   the same step can report usage more than once as a stream settles.
 * - `llm/retry-started` clears the slot, so the *next* attempt for that step
 *   adds to the total. Together with the rule above this is what makes a failed
 *   attempt's tokens stay counted (they were billed) while a re-reported sample
 *   does not double count.
 *
 * The buckets are disjoint, exactly as the provider reports them: `inputTokens`
 * is *uncached* prompt input, cache reads and writes are separate charges, and
 * `reasoningTokens` is a subset of the output tokens rather than a fifth
 * bucket. So the billable total is the sum of the four buckets, and that is what
 * {@link UsageTotals.totalTokens} reports.
 *
 * @module dsh-as-mcp/dsh/usage
 */

import type { DshSessionEvent, DshTokenUsage, DshTokenUsageProjection } from './types.js'

/** The four disjoint token buckets a provider reports. */
export interface UsageBuckets {
  /** Prompt tokens the provider did not serve from its cache. */
  readonly uncachedInputTokens: number
  /** Prompt tokens billed as cache reads. */
  readonly cacheReadTokens: number
  /** Prompt tokens billed as cache writes (cache creation). */
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

/** Buckets plus the one number a caller bills against: their sum. */
export interface UsageTotals extends UsageBuckets {
  /** `uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`. */
  readonly totalTokens: number
}

/** One turn's usage, which is the unit a released `session_prompt` reports. */
export interface TurnUsage extends UsageTotals {
  /** The harness's turn number inside the session; starts at 1. */
  readonly turn: number
  /** How many distinct steps inside this turn reported usage. */
  readonly steps: number
}

/**
 * Usage attributed to one provider/model route.
 *
 * A retried attempt is billed but carries no assistant message, so it has no
 * route to attribute; those tokens appear in the `provider: null, model: null`
 * row rather than being silently dropped from the breakdown.
 */
export interface ModelUsage extends UsageTotals {
  readonly provider: string | null
  readonly model: string | null
  /**
   * How many settlements contributed tokens to this row.
   *
   * A route that was only ever reported with zero tokens is absent from
   * `byModel` entirely rather than listed as a zero row.
   */
  readonly samples: number
}

/** One session's usage across its whole log. */
export interface SessionUsage {
  readonly totals: UsageTotals
  /** Per-turn totals, ascending by turn number. */
  readonly byTurn: readonly TurnUsage[]
  /** Per-route totals, largest `totalTokens` first. */
  readonly byModel: readonly ModelUsage[]
  /**
   * How many provider calls contributed to the totals.
   *
   * One per billed call: a retried attempt counts separately (it was billed),
   * while a corrected or repeated report for a call already counted replaces its
   * buckets without adding one. It can differ from `steps` when a call was
   * retried, and it can exceed the sum of `byModel[].samples`, because a call
   * that reported zero tokens still counts here while `byModel` lists only the
   * routes that actually charged something.
   */
  readonly samples: number
  /**
   * Samples that carried a usage record this module could not read (missing or
   * non-integer counts). Non-zero means the totals under-report what the
   * provider charged, so it is reported rather than hidden.
   */
  readonly ignoredSamples: number
}

/** One decoded provider usage sample, with the route that reported it. */
interface UsageSample {
  readonly usage: DshTokenUsage
  readonly route: Route | null
}

/** `provider/model` a sample was billed under. */
interface Route {
  readonly provider: string
  readonly model: string
}

/** The `(turn, step)` slot the projection's replacement rule is keyed on. */
interface Slot {
  readonly turn: number
  readonly step: number
  readonly buckets: UsageBuckets
  readonly route: Route | null
}

/** A running per-turn cell. */
interface TurnCell {
  buckets: UsageBuckets
  readonly steps: Set<number>
}

/** A running per-route cell. */
interface ModelCell {
  readonly route: Route | null
  buckets: UsageBuckets
  samples: number
}

/** Do the two bucket sets charge the same tokens? */
function bucketsEqual(left: UsageBuckets, right: UsageBuckets): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.outputTokens === right.outputTokens
}

/** A count the provider can have reported: a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The zero for the additive group of buckets. */
export function emptyBuckets(): UsageBuckets {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

/** Present buckets as totals by adding the one derived number. */
export function toTotals(buckets: UsageBuckets): UsageTotals {
  return {
    ...buckets,
    // Computed from the buckets rather than trusting a provider `totalTokens`:
    // the sum is what the buckets themselves assert, and a provider that omits
    // the field (or disagrees with it) otherwise loses its tokens here.
    totalTokens: buckets.uncachedInputTokens + buckets.cacheReadTokens
      + buckets.cacheWriteTokens + buckets.outputTokens,
  }
}

/** Add two bucket sets. */
function addBuckets(left: UsageBuckets, right: UsageBuckets): UsageBuckets {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

/**
 * Add several totals together.
 *
 * Used where two already-aggregated figures have to be combined — a forked
 * session's inherited prefix and its own spend, say — rather than raw samples.
 */
export function sumTotals(list: readonly UsageTotals[]): UsageTotals {
  const buckets = list.reduce<UsageBuckets>(
    (sum, entry) => addBuckets(sum, entry),
    emptyBuckets(),
  )
  return toTotals(buckets)
}

/**
 * The part of `whole` that `part` does not account for, per bucket.
 *
 * Used to price a forked session's inherited prefix as "whole-log minus own
 * spend" rather than folding the prefix separately: the fold's replacement rule
 * is sequential, so the two are only guaranteed to agree when they are derived
 * from one another. Buckets are clamped at zero, because a negative charge would
 * be a reporting bug surfaced as nonsense rather than as a number a caller might
 * bill.
 */
export function subtractTotals(whole: UsageTotals, part: UsageTotals): UsageTotals {
  const difference = subtractBuckets(whole, part)
  return toTotals({
    uncachedInputTokens: Math.max(0, difference.uncachedInputTokens),
    cacheReadTokens: Math.max(0, difference.cacheReadTokens),
    cacheWriteTokens: Math.max(0, difference.cacheWriteTokens),
    outputTokens: Math.max(0, difference.outputTokens),
  })
}

/** Subtract `right` from `left`; used to undo a replaced slot. */
function subtractBuckets(left: UsageBuckets, right: UsageBuckets): UsageBuckets {
  return {
    uncachedInputTokens: left.uncachedInputTokens - right.uncachedInputTokens,
    cacheReadTokens: left.cacheReadTokens - right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens - right.cacheWriteTokens,
    outputTokens: left.outputTokens - right.outputTokens,
  }
}

/** Whether every bucket is zero. */
export function isEmptyBuckets(buckets: UsageBuckets): boolean {
  return buckets.uncachedInputTokens === 0 && buckets.cacheReadTokens === 0
    && buckets.cacheWriteTokens === 0 && buckets.outputTokens === 0
}

/**
 * Read a provider usage record into buckets.
 *
 * `undefined` means the record cannot be trusted (a required count is missing or
 * not a non-negative integer), which the caller reports as an ignored sample
 * rather than folding NaN into the totals.
 */
function bucketsFrom(usage: DshTokenUsage): UsageBuckets | undefined {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  return {
    uncachedInputTokens: inputTokens,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    outputTokens,
  }
}

/** The `(turn, step)` an assistant event belongs to, when it carries both. */
function positionOf(event: DshSessionEvent): { turn: number; step: number } | undefined {
  const data = event.data as { turn?: unknown; step?: unknown } | undefined
  if (!isCount(data?.turn) || !isCount(data?.step)) return undefined
  return { turn: data.turn, step: data.step }
}

/** The `provider/model` an assistant message was billed under, if it names one. */
function routeOf(source: unknown): Route | null {
  if (source === null || typeof source !== 'object') return null
  const { provider, model } = source as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || provider === '') return null
  if (typeof model !== 'string' || model === '') return null
  return { provider, model }
}

/**
 * The last usage sample embedded in a streamed response.
 *
 * A usage chunk is cumulative for the call, and the adapter emits it once at the
 * end, so the last one wins. Scanned backwards because that is where it is, and
 * because a stream can be long.
 */
function streamUsage(stream: unknown): DshTokenUsage | undefined {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index] as
      | { type?: unknown; chunk?: { type?: unknown; usage?: DshTokenUsage } }
      | undefined
    if (record?.type !== 'chunk' || record.chunk?.type !== 'usage') continue
    const usage = record.chunk.usage
    if (usage !== undefined) return usage
  }
  return undefined
}

/**
 * The usage a settlement event reported, in the order the harness itself reads it.
 *
 * `assistant/message` carries the record on `data.usage`; every other streamed
 * event only has it inside the stream. Both the message and the retried-attempt
 * event are read because both were billed.
 */
function sampleOf(event: DshSessionEvent): UsageSample | undefined {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const data = event.data as
    | {
      usage?: unknown
      stream?: unknown
      message?: { source?: unknown }
    }
    | undefined
  const route = routeOf(data?.message?.source)
  if (event.type === 'assistant/message' && data?.usage !== undefined) {
    return { usage: data.usage as DshTokenUsage, route }
  }
  const usage = streamUsage(data?.stream)
  return usage === undefined ? undefined : { usage, route }
}

/** Stable map key for a route, including the unattributed row. */
function routeKey(route: Route | null): string {
  return route === null ? '' : `${route.provider}\u0000${route.model}`
}

/** Cell for one route, created on first use. */
function modelCell(cells: Map<string, ModelCell>, route: Route | null): ModelCell {
  const key = routeKey(route)
  const existing = cells.get(key)
  if (existing !== undefined) return existing
  const created: ModelCell = { route, buckets: emptyBuckets(), samples: 0 }
  cells.set(key, created)
  return created
}

/** Cell for one turn, created on first use. */
function turnCell(cells: Map<number, TurnCell>, turn: number): TurnCell {
  const existing = cells.get(turn)
  if (existing !== undefined) return existing
  const created: TurnCell = { buckets: emptyBuckets(), steps: new Set<number>() }
  cells.set(turn, created)
  return created
}

/**
 * Fold one session log into per-turn, per-route, and total usage.
 *
 * @param events - the session's durable events, in log order.
 * @param options.fromSeq - first seq to include. A forked session's
 *   `inheritedEventCount` goes here to report only the child's own spend; the
 *   inherited prefix belongs to the session it was forked from.
 * @returns the fold; a log with no usage samples yields zero totals, `samples:
 *   0`, and empty breakdowns — never an error, because "no model ran" is a
 *   legitimate answer for a session that only received a message.
 */
export function foldSessionUsage(
  events: readonly DshSessionEvent[],
  options: { readonly fromSeq?: number } = {},
): SessionUsage {
  const fromSeq = options.fromSeq ?? 0
  const turns = new Map<number, TurnCell>()
  const models = new Map<string, ModelCell>()
  let slot: Slot | undefined
  let samples = 0
  let ignoredSamples = 0

  for (const event of events) {
    if (event.seq < fromSeq) continue
    if (event.type === 'llm/retry-started') {
      // The slot is freed, *not* emptied: the failed attempt it held was billed
      // and stays in the totals. The next attempt for that step therefore adds.
      const position = positionOf(event)
      if (position !== undefined && slot?.turn === position.turn && slot.step === position.step) {
        slot = undefined
      }
      continue
    }

    const sample = sampleOf(event)
    if (sample === undefined) continue
    const position = positionOf(event)
    if (position === undefined) continue

    const buckets = bucketsFrom(sample.usage)
    if (buckets === undefined) {
      ignoredSamples += 1
      continue
    }

    const previous = slot !== undefined && slot.turn === position.turn && slot.step === position.step
      ? slot
      : undefined
    // A streamed step can report the same cumulative sample twice; the
    // projection treats an identical re-report as a no-op and so does this.
    if (previous !== undefined && bucketsEqual(previous.buckets, buckets)) continue

    if (previous !== undefined) {
      // A correction for a call already counted: swap the buckets, but do not
      // count a second call.
      const turn = turnCell(turns, position.turn)
      turn.buckets = subtractBuckets(turn.buckets, previous.buckets)
      const model = modelCell(models, previous.route)
      model.buckets = subtractBuckets(model.buckets, previous.buckets)
      model.samples -= 1
    } else {
      samples += 1
    }

    const turn = turnCell(turns, position.turn)
    turn.buckets = addBuckets(turn.buckets, buckets)
    turn.steps.add(position.step)
    const model = modelCell(models, sample.route)
    model.buckets = addBuckets(model.buckets, buckets)
    model.samples += 1

    slot = { turn: position.turn, step: position.step, buckets, route: sample.route }
  }

  const byTurn: TurnUsage[] = [...turns.entries()]
    .sort(([left], [right]) => left - right)
    .map(([turn, cell]) => ({ turn, steps: cell.steps.size, ...toTotals(cell.buckets) }))

  const byModel: ModelUsage[] = [...models.values()]
    .filter((cell) => !isEmptyBuckets(cell.buckets))
    .map((cell) => ({
      provider: cell.route?.provider ?? null,
      model: cell.route?.model ?? null,
      samples: cell.samples,
      ...toTotals(cell.buckets),
    }))
    // Attributed routes first, largest first; the unattributed (retried) row
    // last, where a reader looking for a model will not mistake it for one.
    .sort((left, right) => {
      if ((left.model === null) !== (right.model === null)) return left.model === null ? 1 : -1
      if (right.totalTokens !== left.totalTokens) return right.totalTokens - left.totalTokens
      // Tie-break on the route name so the breakdown is byte-identical across
      // reads of the same log; insertion order is a detail of event order and
      // would make a documented shape depend on which model spoke first.
      return `${left.provider}\u0000${left.model}`.localeCompare(`${right.provider}\u0000${right.model}`)
    })

  const totals = toTotals(byTurn.reduce<UsageBuckets>(
    (sum, turn) => addBuckets(sum, turn),
    emptyBuckets(),
  ))

  return { totals, byTurn, byModel, samples, ignoredSamples }
}

/**
 * The usage one turn reported.
 *
 * @param usage - the session fold.
 * @param turn - the turn number, or `null` when the turn never began.
 * @returns that turn's totals, or `undefined` when the turn billed nothing —
 *   which is a real answer for a turn that was cancelled before its first step.
 */
export function usageOfTurn(
  usage: { readonly byTurn: readonly TurnUsage[] },
  turn: number | null,
): TurnUsage | undefined {
  if (turn === null) return undefined
  return usage.byTurn.find((entry) => entry.turn === turn)
}

/**
 * The part of a usage report that can be added up across sessions.
 *
 * Structural rather than {@link SessionUsage} so a caller's report type (which
 * may omit the ignored-sample count) can be combined without being reshaped
 * first; the fields are the ones that mean the same thing for one session and
 * for many.
 */
export interface CombinableUsage {
  readonly totals: UsageTotals
  readonly byModel: readonly ModelUsage[]
  readonly samples: number
  readonly ignoredSamples?: number
}

/**
 * Combine several sessions' usage into one session-shaped total.
 *
 * Used by the aggregate report: totals and the per-route breakdown add up, while
 * the per-turn breakdown is deliberately dropped — turn numbers are local to a
 * session and a merged list under one `turn` key would be a lie. Callers that
 * want per-turn detail ask for one session at a time.
 */
export function combineUsage(usages: readonly CombinableUsage[]): SessionUsage {
  const models = new Map<string, ModelCell>()
  let totals = emptyBuckets()
  let samples = 0
  let ignoredSamples = 0

  for (const usage of usages) {
    totals = addBuckets(totals, usage.totals)
    samples += usage.samples
    ignoredSamples += usage.ignoredSamples ?? 0
    for (const row of usage.byModel) {
      const route = row.provider === null || row.model === null
        ? null
        : { provider: row.provider, model: row.model }
      const cell = modelCell(models, route)
      cell.buckets = addBuckets(cell.buckets, row)
      cell.samples += row.samples
    }
  }

  const byModel: ModelUsage[] = [...models.values()]
    .filter((cell) => !isEmptyBuckets(cell.buckets))
    .map((cell) => ({
      provider: cell.route?.provider ?? null,
      model: cell.route?.model ?? null,
      samples: cell.samples,
      ...toTotals(cell.buckets),
    }))
    .sort((left, right) => {
      if ((left.model === null) !== (right.model === null)) return left.model === null ? 1 : -1
      if (right.totalTokens !== left.totalTokens) return right.totalTokens - left.totalTokens
      // Tie-break on the route name so the breakdown is byte-identical across
      // reads of the same log; insertion order is a detail of event order and
      // would make a documented shape depend on which model spoke first.
      return `${left.provider}\u0000${left.model}`.localeCompare(`${right.provider}\u0000${right.model}`)
    })

  return { totals: toTotals(totals), byTurn: [], byModel, samples, ignoredSamples }
}

/**
 * One session's compaction spend.
 *
 * A summarizing compaction is itself an LLM call, and the harness records the
 * provider's usage for it on `compaction/summary.data.usage`. That usage is
 * deliberately **not** part of the conversation fold above, because it is not
 * part of the harness's own `tokenUsage` projection either: reporting it inside
 * `totals` would make this endpoint's number disagree with the one the DSH UI
 * shows for the same session. It is reported as its own block instead, so a
 * caller that wants the whole bill can add it in and a caller reconciling with
 * the UI is not confused.
 *
 * (The session-title LLM call is the one in-session call with no log record at
 * all — it only appears in `session/title-llm-request`, which carries the route
 * but no usage — so no token fold can account for it.)
 */
export interface CompactionUsage {
  readonly totals: UsageTotals
  /** How many compaction summaries reported usage. */
  readonly summaries: number
  /** Summaries whose usage record could not be read. */
  readonly ignoredSummaries: number
}

/**
 * Fold every compaction summary in a session log into one total.
 *
 * @param events - the session's durable events, in log order.
 * @param options.fromSeq - first seq to include, for a forked session's own
 *   spend; the inherited prefix is its parent's.
 */
export function foldCompactionUsage(
  events: readonly DshSessionEvent[],
  options: { readonly fromSeq?: number } = {},
): CompactionUsage {
  const fromSeq = options.fromSeq ?? 0
  let totals = emptyBuckets()
  let summaries = 0
  let ignoredSummaries = 0

  for (const event of events) {
    if (event.seq < fromSeq) continue
    if (event.type !== 'compaction/summary') continue
    // Not every compaction summarizes (a prune replaces a range without calling
    // a model), and the field is optional even when one did, so an absent
    // record is not an error — it just does not add tokens.
    const usage = (event.data as { usage?: unknown } | undefined)?.usage
    if (usage === undefined) continue
    const buckets = bucketsFrom(usage as DshTokenUsage)
    if (buckets === undefined) {
      ignoredSummaries += 1
      continue
    }
    totals = addBuckets(totals, buckets)
    summaries += 1
  }

  return { totals: toTotals(totals), summaries, ignoredSummaries }
}

/**
 * Collapse a usage report onto the four buckets for comparison with the
 * harness's own projection, which reports buckets and no derived total.
 */
export function projectionMatches(projection: UsageBuckets, totals: UsageBuckets): boolean {
  return projection.uncachedInputTokens === totals.uncachedInputTokens
    && projection.cacheReadTokens === totals.cacheReadTokens
    && projection.cacheWriteTokens === totals.cacheWriteTokens
    && projection.outputTokens === totals.outputTokens
}

/**
 * Read the harness's `tokenUsage` projection into totals.
 *
 * `undefined` when the value is absent (the token-meter plugin is not mounted in
 * this profile) or not a complete bucket record — in both cases there is nothing
 * to compare against, and the report says so rather than inventing agreement.
 */
export function projectionTotals(projection: unknown): UsageTotals | undefined {
  if (projection === null || typeof projection !== 'object') return undefined
  const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } =
    projection as Partial<DshTokenUsageProjection>
  if (!isCount(uncachedInputTokens) || !isCount(outputTokens)) return undefined
  if (!isCount(cacheReadTokens) || !isCount(cacheWriteTokens)) return undefined
  return toTotals({ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
}
