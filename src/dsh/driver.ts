import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, dirname, resolve as resolveAbsolute } from 'node:path'

import type { Config } from '../config.js'
import { optional } from '../config.js'
import { DEFAULT_AGENT_TOOLS } from '../defaults.js'
import { combineCosts, readSessionCost, type CostReport } from './cost.js'
import { loadOwnedSessions, saveOwnedSessions } from './ownership.js'
import {
  buildUsageReport,
  summarizeUsage,
  type UsageCut,
  type UsageReport,
  type UsageSummary,
} from './report.js'
import { combineUsage, usageOfTurn, type ModelUsage, type TurnUsage, type UsageTotals } from './usage.js'
import {
  eventsOf,
  loggerOf,
  serviceOf,
  type DshAgentRegistry,
  type DshCostMeter,
  type DshFileSystem,
  type DshFsTarget,
  type DshLogger,
  type DshPromptPart,
  type DshSessionController,
  type DshSessionEvent,
  type DshAgentHandle,
  type DshApprovalService,
  type DshSessionQuery,
  type DshSessionSummary,
  type DshSandboxPolicy,
  type DshAgentPresetInfo,
  type DshAgentPresetRegistry,
  type DshLlmModelInfo,
  type DshLlmProviderInfo,
  type DshLlmRegistry,
  type DshPermissionPresets,
  type DshToolRegistry,
  type DshShellExecution,
  type DshShellExecutor,
  type DshShellProcess,
  type DshShellRunResult,
  type DshWorkspaceRegistry,
  type DshRestoredWorktree,
  type DshWorktreeRecord,
  type DshWorktreeService,
  type DshToolBatchInput,
  type DshToolExecutionInput,
  type DshToolExecutionResult,
  DshCommandDescriptor,
  DshCommandService,
  DshGoalActivation,
  DshGoalPhase,
  DshGoalService,
  DshGoalView,
  DshScheduleEditResult,
  DshScheduleEntry,
  DshScheduleListResult,
  DshScheduleService,
  DshScheduleTargetRequest,
  DshScheduleTiming,
  DshForgeChangeRequestDiff,
  DshForgePanelService,
  DshForgeSessionService,
  DshSessionChangeRequest,
  DshSessionHandle,
  DshSessionsService,
  DshForgeDiffFile,
} from './types.js'

/**
 * The endpoint's server-push surface, as the driver consumes it.
 *
 * Declared here rather than in the MCP layer so the dependency points one way:
 * the transport implements this, the driver calls it. `hasSubscribers` gates
 * whether a fire-and-forget turn is worth watching at all.
 */
export interface TurnPushes {
  /**
   * Whether any `subscriptions/listen` stream is currently open.
   *
   * Watchers are armed only when someone could receive the event: a
   * fire-and-forget prompt otherwise costs a log read per second for nothing.
   * The trade-off is documented for clients — subscribe before prompting.
   */
  hasSubscribers(): boolean
  /** Publish one `notifications/resources/updated` for the session's turn resource. */
  turnSettled(sessionId: string): void
}

/**
 * Upper bound between two durable-log reads while a prompt waits for its turn.
 *
 * The wait wakes on the `session/event` feed, so this is a safety net rather than
 * the poll rate: on a healthy host a log read happens when the log changes, and
 * the cap only matters for a composition whose event feed is missing or filtered.
 * It is far above the old fixed 200 ms cadence on purpose — the loop used to
 * re-read and re-validate the whole log five times a second while a tool ran.
 */
export const TURN_POLL_INTERVAL_MS = 1_000

/**
 * How long a running turn may leave the log untouched before `session_status`
 * calls it stalled.
 *
 * This is a report, not a timeout: a model call can legitimately think for
 * minutes, so the wait keeps waiting. A minute of total silence is long enough to
 * be worth telling a polling caller about and short enough that an upstream does
 * not spend an hour believing a dead turn is healthy.
 */
export const STALL_MS = 60_000

/**
 * Upper bound on one `session_status { waitMs }` long-poll.
 *
 * A status call is meant to be cheap and repeatable; the cap keeps a caller from
 * parking a connection for as long as a prompt wait would, and is short enough
 * that the caller's own report cadence stays in control.
 */
const STATUS_MAX_WAIT_MS = 60_000

/**
 * How long a committed prompt may sit with its agent idle, and no `turn/end`, before
 * the wait calls the turn vanished.
 *
 * The harness normally closes every turn it opens, but a disposed agent or a
 * dropped loop can leave a turn open forever; without this the caller would wait
 * out the whole timeout for a turn that no longer exists. The grace period covers
 * the ordinary gap between a turn/end and the queued turn that starts right after
 * it.
 */
const VANISH_GRACE_MS = 1_500

/**
 * Hard cap on session rows in one `session_usage` report.
 *
 * Every row costs one durable-log read plus one price lookup, so an unbounded
 * report is an unbounded amount of I/O on a machine with years of sessions. The
 * cap is higher than the tool's maximum `limit` because subagent children add
 * rows of their own, and it is reported (`notes`) rather than silently applied.
 */
const MAX_USAGE_ROWS = 100

/**
 * Upper bound on subagent sessions folded into one `session_usage` receipt.
 *
 * Every child costs one durable-log read, and a session can in principle spawn
 * an unbounded number of them. The cap is reported to the caller when it bites
 * (`truncatedSubagents`), so a partial total is never passed off as complete.
 */
const MAX_SUBAGENT_SESSIONS = 50

/**
 * Why a row carries no money when the caller asked not to price it.
 *
 * `includeCost: false` exists for wide scans: cost-meter's per-session read
 * refreshes its ledger, so pricing 100 sessions is 100 ledger reads. The reason
 * is stated instead of leaving `available: false` to mean "no price source",
 * which would be a different and wrong explanation.
 */
const COST_DISABLED =
  'cost reporting was disabled for this request (includeCost: false)'

/**
 * Hard cap on entries one recursive `file_list` returns.
 *
 * A recursive listing is how a caller discovers a project, and a monorepo with
 * `node_modules` is more files than any transcript should carry. The walk stops
 * at the cap and says so (`truncated`) rather than silently returning a prefix
 * that looks complete.
 */
const MAX_LIST_ENTRIES = 2_000

/** Largest image `file_read_image` will carry back in one MCP result. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Most images one prompt may attach. */
const MAX_PROMPT_IMAGES = 4

/**
 * Image formats the harness accepts inside a prompt — `ImageMediaType` in
 * `packages/attachment/attachment/src/types.ts`.
 *
 * `readImage` can display BMP too, but a prompt cannot carry it, so the two paths
 * deliberately have different lists rather than one permissive one.
 */
const PROMPT_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Ceiling on one provider's catalog discovery inside `dsh_info`. */
const MODEL_DISCOVERY_TIMEOUT_MS = 2_000

/** How many background shell jobs may exist at once (running plus recently finished). */
const MAX_SHELL_JOBS = 16

/** Bytes of the most recent output retained for non-consuming peek/feed reads. */
const MAX_SHELL_TAIL_BYTES = 16 * 1024

/**
 * Slash commands this endpoint will execute on a session's behalf.
 *
 * An allow-list, not a deny-list, for the same reason the agent-tool list is one:
 * the command set belongs to the profile (plugins register commands), so a
 * deny-list written today would miss a command a future bundle adds. Two shipped
 * commands are deliberately absent — `/permission`, which changes the session's
 * permission preset (a remote caller must not escalate itself), and `/feedback`,
 * which writes the user's own review records. `/compact`, `/plan`, `/goal` and
 * `/export` are user-plane actions on a session the caller can already prompt.
 */
const PERMITTED_COMMANDS: ReadonlySet<string> = new Set(['compact', 'plan', 'goal', 'export'])

/** Default characters of one file patch `forge_local_diff` returns. */
const DEFAULT_FORGE_PATCH_CHARS = 16 * 1024

/** Ceiling on one file patch, so a generated file cannot blow up a caller's context. */
const MAX_FORGE_PATCH_CHARS = 64 * 1024

/** Characters a scheduled task title may use — the harness's own cap. */
const MAX_SCHEDULE_TITLE_CHARS = 120

/** Tasks one `schedule_list` page returns when the caller does not say. */
const DEFAULT_SCHEDULE_PAGE = 20

/** Ceiling on one `schedule_list` page. */
const MAX_SCHEDULE_PAGE = 200

/** Bytes retained per background job for output the caller has not read yet. */
const MAX_SHELL_BUFFER_BYTES = 128 * 1024

/** Default bytes of new output one `shell_output` call returns. */
const DEFAULT_SHELL_OUTPUT_BYTES = 64 * 1024

/** Resolve after `ms`, without holding the event loop open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * Wait for one session's log to grow, its turn to be cancelled, or a deadline.
 *
 * The `session/event` feed is post-commit and fire-and-forget
 * (`packages/core/session/src/index.ts`), which is exactly the shape a wait
 * wants: activity is announced, so the waiter re-reads the log only when there
 * is something new instead of on a fixed cadence. The timeout is the safety net
 * for a composition whose event subscription is missing or scope-filtered — and
 * it is also the caller's bound, so a wait that has nothing to hear still ends.
 *
 * Resolves on the *first* of: an event from this session, the abort signal, or
 * the timeout. It never rejects.
 *
 * @param ctx - the plugin's Cordis context, for the event bus.
 * @param sessionId - the session whose events matter.
 * @param timeoutMs - upper bound to wait; values below 1 ms are treated as 1 ms.
 * @param signal - optional cancellation, so an aborted wait does not sit out the
 *   whole timeout.
 */
export async function waitForSessionActivity(
  ctx: unknown,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return
  const bus = eventsOf(ctx)
  if (typeof bus.on !== 'function') {
    await delay(Math.max(1, timeoutMs))
    return
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off?.()
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(1, timeoutMs))
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    signal?.addEventListener('abort', finish, { once: true })
    let off: (() => unknown) | undefined
    try {
      off = bus.on('session/event', (...args: unknown[]) => {
        // The harness emits `(session, event)`; only this session's growth is
        // this wait's business.
        const session = args[0] as { id?: unknown } | undefined
        if (session?.id === sessionId) finish()
      })
    } catch {
      // A context that cannot subscribe still gets the timeout above.
    }
  })
}

/** Raised when the running profile does not provide a service a tool needs. */
export class DshCapabilityError extends Error {
  override readonly name = 'DshCapabilityError'

  constructor(
    readonly capability: string,
    message: string,
  ) {
    super(message)
  }
}

/** One workspace as reported to MCP callers. */
export interface WorkspaceInfo {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionCount: number
  readonly status: 'ok' | 'missing-dir'
}

/** One session as reported to MCP callers. */
export interface SessionInfo {
  readonly sessionId: string
  readonly cwd?: string
  readonly running: boolean
  readonly blank: boolean
  readonly updatedAt: number
  /** Latest session title, when the caller asked for titles and the log has one. */
  readonly title?: string
  /** The session this one was spawned from, for subagent sessions. */
  readonly parentSessionId?: string
  /** `subagent` when the harness created this session as an agent's child. */
  readonly origin?: 'subagent'
  /**
   * The session's live working directory, when the caller opted in and the
   * profile can report it. A session working in a worktree shows that checkout.
   */
  readonly workingDirectory?: string | null
  /** The forge-created worktree record, when the caller opted in and one exists. */
  readonly worktree?: WorktreeInfo | null
  /** Whether the session is archived (hidden from the DSH UI's grouping), when readable. */
  readonly archived?: boolean
  /** Whether the session is pinned in the DSH UI, when readable. */
  readonly pinned?: boolean
}

/** One tool invocation the agent made while answering. */
export interface ToolCallInfo {
  readonly name: string
  readonly callId?: string
  /**
   * Size of the call's arguments in bytes.
   *
   * Always present, because a `file_write` call's arguments are the whole file and
   * that size is the useful fact when the arguments themselves are omitted.
   */
  readonly argumentsBytes: number
  /** The arguments, when the caller asked for them (see {@link ToolCallDetail}). */
  readonly arguments?: string
  /** True when `arguments` was cut to the requested length. */
  readonly truncated?: boolean
}

/**
 * How much of each tool call a prompt reply carries.
 *
 * `summary` (the default) reports name, callId and argument size. Arguments are
 * omitted because an agent's `file_write` arguments are the entire file content:
 * echoing them into the caller's context duplicates the write, and for a large file
 * that is most of the reply. `full` includes them (bounded by
 * {@link maxArgumentChars}); `none` drops the list entirely.
 */
export type ToolCallDetail = 'summary' | 'full' | 'none'

/**
 * Why a turn is a failure, as opposed to an ending the caller asked for.
 *
 * The harness records the reason a turn ended; a caller that only sees "the call
 * returned" cannot tell "the agent answered" from "the model errored". This is the
 * normalized version of that reason, and the same value appears in
 * `session_status.failure`, so polling and waiting report the same facts.
 */
export interface TurnFailure {
  /**
   * The harness ending (`error`, `blocked`, `max-tokens`, `interrupted`), or one of
   * the two conditions a wait detects itself: `unreadable` (the session log stopped
   * being readable mid-wait) and `vanished` (the turn stopped without `turn/end`).
   */
  readonly kind: string
  /** One sentence a caller can log or show, naming what happened. */
  readonly message: string
}

/** The settled outcome of one driver-initiated agent turn. */
export interface TurnResult {
  /** The agent's final reply, cut to `maxReplyChars` when the caller set one. */
  readonly reply: string
  /**
   * Model routes (`provider/model`) that produced this turn's assistant messages.
   *
   * Usage says how many tokens; this says on which route. A caller that switched
   * models mid-session, or that wants to prove which model answered, does not have
   * to infer it from the token buckets.
   */
  readonly models: readonly string[]
  /** Length of the reply before any cap. */
  readonly replyChars: number
  /** True when `reply` was cut to the requested cap. */
  readonly replyTruncated?: true
  readonly toolCalls: readonly ToolCallInfo[]
  readonly turn: number | null
  readonly turnEndReason: unknown
  /** True when the wait bound elapsed before the turn settled. */
  readonly timedOut: boolean
  /** True when the turn ended because it was cancelled. */
  readonly aborted: boolean
  /**
   * Why this turn is a failure, when it ended abnormally.
   *
   * Absent for a completed turn, for a cancellation the caller asked for
   * (`aborted: true` already says that) and for a fork boundary. Present for the
   * harness's own failure endings — `error`, `blocked`, `max-tokens`, and
   * `interrupted` (the turn never ended and was closed after the fact) — and for
   * the two conditions a wait detects itself: `unreadable` (the session log
   * stopped being readable mid-wait) and `vanished` (the turn stopped without a
   * `turn/end`). `session_status.failure` carries the same value, so a polling
   * caller and a waiting caller see one contract.
   */
  readonly failure?: TurnFailure
  /**
   * Wall-clock milliseconds from the turn's start event to its end event.
   *
   * Absent for a turn that is still running (or a wait that timed out before it
   * settled). Tokens say what a turn cost; this says how long the caller waited for
   * it, which is what a timeout or an SLO is tuned against.
   */
  readonly durationMs?: number
  /**
   * Provider-reported tokens this turn consumed, when the harness recorded any.
   *
   * This is the per-prompt receipt: a turn is the unit one `session_prompt`
   * starts, and its total covers every step the agent took inside it (each tool
   * round trip is its own model call). Absent when the turn billed nothing —
   * a cancelled turn with no step, or a provider that reported no usage.
   */
  readonly usage?: TurnUsage
}

/**
 * The usage block a `session_prompt` reply carries for the whole session.
 *
 * Separate from {@link TurnResult.usage} because the caller's question is
 * usually cumulative — "how much has this session cost me so far" — and a
 * caller that only reads the last reply would otherwise have to add up turns
 * itself.
 */
export interface SessionUsageEnvelope {
  readonly sessionId: string
  /** Cumulative usage at the instant the call returned. */
  readonly usage: UsageSummary
  /** Money, when a price plugin is installed; otherwise an explained `available: false`. */
  readonly cost: CostReport
}

/** One usage read: either the report plus its wire envelope, or why it failed. */
type UsageRead =
  | { readonly ok: true; readonly envelope: SessionUsageEnvelope; readonly report: UsageReport }
  | { readonly ok: false; readonly reason: string }

/**
 * Why a prompt reply carries no usage block.
 *
 * Absence alone would be ambiguous — "this turn billed nothing" and "the usage
 * read failed" look identical to a caller that bills against these numbers — so
 * a failed read says so instead. It is not a failed prompt: the work happened and
 * the reply is the answer, and `session_usage` can be retried.
 */
export interface UsageUnavailable {
  readonly usageUnavailable: true
  /** The underlying read failure, verbatim. */
  readonly reason: string
}

/** One session's row in a `session_usage` report. */
export interface SessionUsageRow {
  readonly sessionId: string
  readonly cwd?: string
  /** `self` for the session asked about, `subagent` for a child folded into it. */
  readonly origin: 'self' | 'subagent'
  /**
   * The subagent parent this row was reached through; set only for
   * `origin: 'subagent'`.
   *
   * Deliberately absent for a self row even when the session was forked from
   * another: fork lineage is not parentage, and a caller using this field to walk
   * a task tree must not mistake a sibling for a child.
   */
  readonly parentSessionId?: string
  /** Absent when the session's log could not be read; see {@link error}. */
  readonly usage?: UsageReport
  readonly cost?: CostReport
  /** Why this row carries no usage. */
  readonly error?: string
}

/** The `session_usage` tool's reply. */
export interface SessionUsageReport {
  /** ISO timestamp of the read, so a caller can tell a stale receipt from a fresh one. */
  readonly generatedAt: string
  /** What set of sessions the report covers. */
  readonly scope: 'session' | 'sessionIds' | 'workspace' | 'pluginSessions' | 'allSessions'
  readonly sessions: readonly SessionUsageRow[]
  /** Sum over every row that could be read. */
  readonly totals: UsageTotals & { readonly turns: number; readonly steps: number; readonly samples: number }
  /** Per-route totals across the whole report. */
  readonly byModel: readonly ModelUsage[]
  /**
   * Whether the totals include at least one subagent session.
   *
   * Read off the rows rather than the request flag: `false` means the number may
   * understate what the task cost, which is exactly what a caller has to know.
   */
  /**
   * True when at least one included row was read mid-turn.
   *
   * The rows carry their own `partial`; this is the same fact at the level a
   * caller bills from, because reading only `totals` would otherwise treat a
   * snapshot that is still growing as final.
   */
  readonly partial?: true
  readonly subagentsIncluded: boolean
  /** True when the subagent cap stopped the walk before every child was read. */
  readonly truncatedSubagents?: boolean
  /** True when the row cap stopped the report before every session was read. */
  readonly truncatedRows?: boolean
  /** Money across the report; `available: false` when no price source answered. */
  readonly cost: CostReport
  /** Usage records that could not be read across the report; totals under-report by this much. */
  readonly ignoredSamples?: number
  /** Anything a caller has to know to read the numbers correctly. */
  readonly notes: readonly string[]
}

/** One image a caller wants attached to a prompt, by path. */
export interface PromptImageRequest {
  readonly path: string
  readonly cwd?: string
}

/** One liveness update while a `session_prompt` call waits for its turn. */
export interface TurnProgress {
  /** The turn being waited on, once the log makes it knowable. */
  readonly turn: number | null
  /** Tool calls the agent has made inside that turn so far. */
  readonly toolCalls: number
  /** Milliseconds since the prompt was submitted. */
  readonly elapsedMs: number
  /**
   * Milliseconds since the newest event in the log.
   *
   * `elapsedMs` is how long the caller has waited; this is how long the agent has
   * been *quiet*. A turn that is working shows a small number here even after a
   * long wait, and a stalled model call shows it growing — which is the difference
   * between "still running" and "still alive" that a heartbeat should report.
   */
  readonly idleMs: number
  /** True on the final update, when the turn has settled or the wait gave up. */
  readonly settled: boolean
}

/**
 * One session's live state, for a caller that polls instead of holding a wait open.
 *
 * Built from a durable-log read plus the harness's own agent state, so it answers
 * the two questions a waiting caller cannot ask between events: is anything
 * running, and did the last thing that ran fail.
 */
export interface SessionStatus {
  readonly sessionId: string
  /** A turn is open right now, per the harness's own agent state. */
  readonly running: boolean
  /** The open turn and step, when the log shows one. */
  readonly openTurn: number | null
  readonly openStep: number | null
  readonly lastEventSeq: number | null
  /** ISO timestamp of the newest durable event. */
  readonly lastEventAt: string | null
  /** Milliseconds since that event, as of this report. */
  readonly idleMs: number | null
  /** The most recently closed turn: its number, when it ended, and why. */
  readonly lastTurn: { readonly turn: number; readonly endedAt: string | null; readonly reason: unknown } | null
  /** Set when {@link lastTurn} ended abnormally (see {@link TurnFailure}). */
  readonly failure: TurnFailure | null
  /** Running while the log has been quiet for at least {@link STALL_MS} — a symptom, not a verdict. */
  readonly stalled: boolean
  /** False when the durable log could not be read at all. */
  readonly logReadable: boolean
  /** Only on a `waitMs` call: whether anything changed while waiting. */
  readonly changed?: boolean
  readonly waitedMs: number
  /**
   * The session's live working directory, when the profile can report it.
   *
   * This is the harness's committed working directory, not the `cwd` the session
   * was created with: a session that entered a worktree reports that checkout
   * here while its durable header keeps the directory it was created in — which is
   * what keeps a `workspaceId`-created session in its workspace group (a cwd-only
   * session was never in one). Absent when the profile provides no projection read.
   */
  readonly workingDirectory?: string | null
  /**
   * The worktree record the forge panel created for this session, when one exists.
   *
   * Only worktrees requested through the DSH UI's "New worktree" option carry this
   * record; one created by {@link DshDriver.createWorktree} is reported in that
   * call's own reply and is visible as {@link workingDirectory} afterwards.
   */
  readonly worktree?: WorktreeInfo | null
}

/**
 * One worktree as reported to MCP callers.
 *
 * {@link DshWorktreeRecord} plus the revision the checkout was created from —
 * `null` means the source checkout's `HEAD`, the same convention the harness's
 * own `forgeWorktree` projection uses.
 */
export interface WorktreeInfo extends DshWorktreeRecord {
  readonly from: string | null
}

/** The `worktree_create` reply. */
export interface WorktreeReply extends WorktreeInfo {
  readonly sessionId: string
}

/** The `worktree_restore` reply. */
export interface RestoreWorktreeReply {
  readonly sessionId: string
  readonly path: string
  /** True when the branch itself was gone and had to be recreated at `baseCommit`. */
  readonly branchRecreated: boolean
}

/**
 * One durable session event projected for a push feed.
 *
 * Deliberately not the raw event: the feed is a change signal, and shipping whole
 * assistant messages or tool results through it would duplicate the transcript and
 * blow up the resource payload. `summary` carries the first few hundred characters
 * of content; the full record stays available through `session_messages`.
 */
export interface SessionEventFeedEvent {
  readonly seq: number
  readonly type: string
  /** ISO timestamp of the event. */
  readonly at: string
  readonly turn?: number
  readonly step?: number
  /** Bounded human-readable summary, when the event type has one. */
  readonly summary?: string
  /** Set on a failed tool result or an abnormally ended turn. */
  readonly error?: boolean
}

/** The `dsh://session/{id}/events` resource payload. */
export interface SessionEventFeed {
  readonly sessionId: string
  /** Newest event sequence included; a client tracks it to tell a fresh read from a repeat. */
  readonly asOfSeq: number
  readonly events: readonly SessionEventFeedEvent[]
}

/** The reply of one slash-command execution. */
export interface SessionCommandResult {
  readonly sessionId: string
  /** The harness's own command id for this execution; usable in the log/transcript. */
  readonly commandId: string
  /** False when the handler itself reported an error result (`result.kind: 'error'`). */
  readonly ok: boolean
  /** Text the handler returned, when it returned any. */
  readonly text?: string
  /** The durable event the handler wrote, when it reported one. */
  readonly sourceEventSeq?: number
}

/** One durable goal, as this endpoint projects it from the harness's `GoalView`. */
export interface SessionGoalView {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: DshGoalPhase
  /** Whether the round driver is currently advancing it. */
  readonly activation: DshGoalActivation
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly blockedReason?: { readonly code: string; readonly message: string }
  readonly createdAt: number
  readonly updatedAt: number
}

/** One file in a forge diff listing, as this endpoint reports it. */
export interface ForgeFileSummary {
  readonly path: string
  readonly previousPath: string | null
  readonly status: string
  readonly binary: boolean
  readonly oversized: boolean
  readonly untracked: boolean
  readonly additions: number
  readonly deletions: number
  /** Hunk count; the hunks themselves stay in the forge diff and are not shipped here. */
  readonly hunks: number
}

/** One change-request diff, bounded to a file listing. */
export interface ForgeDiffSummary {
  readonly headSha: string
  readonly files: readonly ForgeFileSummary[]
  readonly localAhead: number | null
  /** True when the diff named more files than the caller asked to see. */
  readonly truncated?: true
}

/** One check on a change request. */
export interface ForgeCheckSummary {
  readonly name: string
  readonly state: string
  readonly url?: string | null
  readonly workflow?: string | null
  readonly startedAt?: string | null
  readonly completedAt?: string | null
}

/** One change request bound to a session, as `forge_changes` reports it. */
export interface ForgeChangeView {
  readonly url: string
  readonly origin: string
  readonly number?: number
  readonly repository?: { readonly forge: string; readonly host: string; readonly owner: string; readonly name: string }
  readonly title?: string
  readonly state?: string
  readonly draft?: boolean
  readonly author?: string | null
  readonly headBranch?: string
  readonly headSha?: string
  readonly baseBranch?: string
  readonly additions?: number
  readonly deletions?: number
  readonly mergeability?: string
  readonly mergeReady?: boolean
  readonly mergeMethods?: readonly string[]
  readonly reviewDecision?: string
  readonly checksRollup?: string
  readonly checksTruncated?: boolean
  readonly unresolvedThreads?: number
  readonly updatedAt?: string
  readonly closedAt?: string | null
  /** When the cached snapshot was fetched (epoch milliseconds). */
  readonly fetchedAt?: number
  /** The forge failure that left the binding without a snapshot, when there is one. */
  readonly failure?: { readonly code: string; readonly message: string }
  readonly checks?: readonly ForgeCheckSummary[]
  /** True when a requested checks refresh failed and the cached snapshot is shown. */
  readonly checksStale?: true
  readonly diff?: ForgeDiffSummary
}

/**
 * One background shell job as a non-consuming feed snapshot.
 *
 * Extends {@link ShellJobSummary} with the retained output tail, for callers that
 * want to watch a job without consuming the bytes `shell_output` delivers.
 */
export interface ShellJobPeek extends ShellJobSummary {
  /** Last {@link MAX_SHELL_TAIL_BYTES} of output, UTF-8, oldest first. */
  readonly tail: string
  /** True when the retained tail dropped older bytes. */
  readonly tailTruncated: boolean
}

/** One background shell job, as listed to a caller. */
export interface ShellJobSummary {
  readonly jobId: string
  readonly command: string
  readonly cwd?: string
  readonly status: 'running' | 'completed' | 'killed'
  readonly startedAt: number
  readonly finishedAt?: number
  readonly exitCode: number | null
  readonly signal: string | null
  /** Bytes of output the caller has not collected yet. */
  readonly pendingBytes: number
}

/** One `shell_output` reply. */
export interface ShellOutputPage {
  readonly jobId: string
  readonly status: 'running' | 'completed' | 'killed'
  readonly exitCode: number | null
  readonly signal: string | null
  /** True once the process has settled; the final output is still readable. */
  readonly done: boolean
  /** New output, up to the per-call byte cap. */
  readonly output: string
  /** Bytes still buffered for the next call. */
  readonly pendingBytes: number
  /** True when the job's buffer dropped bytes that this reply cannot include. */
  readonly truncated: boolean
  /** True when the service itself dropped bytes (see the spill paths). */
  readonly lossy: boolean
  readonly stdoutSpillPath?: string
  readonly stderrSpillPath?: string
}

/** Per-job state that never leaves the driver. */
interface ShellJobState {
  readonly jobId: string
  readonly command: string
  readonly cwd?: string
  readonly startedAt: number
  handle: DshShellProcess
  /** Output read from the process but not yet delivered to a caller. */
  buffer: string
  /**
   * Most recent output, retained so a non-consuming feed read can show progress
   * without stealing bytes the `shell_output` caller has not received yet.
   */
  tail: string
  /** True when `tail` dropped older bytes. */
  tailTruncated: boolean
  /** True when `buffer` was trimmed because it exceeded the retained cap. */
  truncated: boolean
  /** True when the service dropped bytes; the spill paths point at the full stream. */
  lossy?: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
  finishedAt?: number
  timer?: ReturnType<typeof setTimeout>
}

/** One message projected onto the caller-facing transcript. */
export interface TranscriptMessage {
  /** `tool` rows appear only when the caller asked for tool results. */
  readonly role: 'user' | 'assistant' | 'tool'
  /** Tool calls the model requested in this message, when `includeToolCalls` was asked. */
  readonly toolCalls?: readonly TranscriptToolCall[]
  /** The harness message id; queue mutations address a pending message by it. */
  readonly id?: string
  /**
   * The request id the admission was made under, for user messages.
   *
   * It is what the log records as `source.rpcId` and what `idempotencyKey` derives,
   * so a caller can correlate its own prompts (and retries) with transcript entries.
   */
  readonly requestId?: string
  /** The call a `tool` row answers; correlates with `toolCalls[].id`. */
  readonly callId?: string
  /** The turn this row belongs to, when the log attributes one. */
  readonly turn?: number
  /** The step inside that turn, when the log records one. */
  readonly step?: number
  /** True when the harness marked this tool result an error. */
  readonly error?: true
  /** The message text, cut to the caller's per-message cap when one was given. */
  readonly text: string
  readonly time: number
  readonly seq: number
  /** Length of the text before any cap. */
  readonly chars: number
  /** True when `text` was cut to the requested per-message cap. */
  readonly truncated?: boolean
}

/** One tool invocation a model requested, as the durable log records it. */
export interface TranscriptToolCall {
  /** Provider-issued call id; correlates with the tool result event. */
  readonly id?: string
  readonly name: string
  /** Raw JSON length; the arguments themselves are not repeated here. */
  readonly argumentsChars: number
  /** Length of the tool's textual result, once one is recorded. */
  readonly resultChars?: number
  /** True when the harness marked the recorded result as an error. */
  readonly error?: true
}

/** One directory entry. */
export interface DirectoryEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
  /** Path relative to the listed directory, with `/` separators; recursive listings only. */
  readonly path?: string
  /** Depth below the listed directory, 1 for a direct child; recursive listings only. */
  readonly depth?: number
  /** SHA-256 of the file's content, when the caller asked for hashes. */
  readonly sha256?: string
  /** Why no hash could be produced (too large, unreadable); present only when asked. */
  readonly sha256Unavailable?: string
}

/**
 * Where one request's prompt sits in the durable session log.
 *
 * The harness records the `requestId` given to `prompt()` as `source.rpcId` on
 * the committed user message — `sessionController`'s own idempotency check
 * matches it the same way — which is what makes it possible to attribute a turn
 * to the request that created it rather than assuming the newest turn is ours.
 */
interface TurnLocation {
  /** Index of the `user/message` carrying this request's id, or -1 if not committed yet. */
  readonly promptIndex: number
  /** Inclusive start of the content belonging to this turn. */
  readonly from: number
  /** Exclusive end of the content belonging to this turn. */
  readonly to: number
  /** The turn that consumed this prompt, or null while none has begun. */
  readonly owningTurn: number | null
  /** True once the owning turn has closed in the log. */
  readonly settled: boolean
}

/** The turn number an event belongs to, when it carries one. */
function turnOf(event: DshSessionEvent | undefined): number | null {
  const turn = (event?.data as { turn?: unknown } | undefined)?.turn
  return typeof turn === 'number' ? turn : null
}

/** Extract concatenated text from a model-facing content-block array. */
function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') text += candidate.text
  }
  return text
}

/** A recorded tool result, keyed by the call it answers. */
interface ToolResultSummary {
  readonly chars: number
  readonly error: boolean
}

/**
 * Tool invocations a model requested, from one message's content blocks.
 *
 * @param blocks - The message's content blocks.
 * @param results - Recorded results keyed by call id, so a completed call carries
 *   how large its result was and whether the harness marked it an error.
 * @returns The calls in block order.
 */
function toolCallsOfBlocks(
  blocks: unknown,
  results: ReadonlyMap<string, ToolResultSummary> = new Map(),
): TranscriptToolCall[] {
  if (!Array.isArray(blocks)) return []
  const calls: TranscriptToolCall[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
    if (candidate.type !== 'tool-call') continue
    if (typeof candidate.name !== 'string' || candidate.name === '') continue
    const id = typeof candidate.id === 'string' && candidate.id !== '' ? candidate.id : undefined
    const result = id === undefined ? undefined : results.get(id)
    calls.push({
      ...(id === undefined ? {} : { id }),
      name: candidate.name,
      // Arguments are raw provider JSON and can be large; the size is what a
      // poller needs, and it keeps a transcript read bounded.
      argumentsChars: typeof candidate.arguments === 'string' ? candidate.arguments.length : 0,
      ...(result === undefined ? {} : { resultChars: result.chars }),
      ...(result?.error === true ? { error: true as const } : {}),
    })
  }
  return calls
}

/** Summarize recorded tool results by the call id they answer. */
function toolResultsOfEvents(
  events: readonly DshSessionEvent[],
): Map<string, ToolResultSummary> {
  const results = new Map<string, ToolResultSummary>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = (event.data as { message?: Record<string, unknown> } | undefined)?.message
    if (message === undefined) continue
    const callId = message['toolCallId']
    if (typeof callId !== 'string' || callId === '') continue
    results.set(callId, {
      chars: textOfBlocks(message['content']).length,
      error: message['isError'] === true,
    })
  }
  return results
}

/** Whether a durable `turn/end` reason records a cancellation. */
function isAbortedReason(reason: unknown): boolean {
  if (reason === null || typeof reason !== 'object') return false
  return (reason as { kind?: unknown }).kind === 'aborted'
}

/**
 * Normalize a harness `turn/end` reason into a caller-facing failure, or undefined
 * when the ending is not a failure.
 *
 * Completed, caller-requested cancellation (`aborted`) and fork boundaries are not
 * failures; `error`, `blocked`, `max-tokens` and `interrupted` are. `interrupted`
 * is the harness's own name for a turn that never ended and was closed after the
 * fact — exactly the "the task died and nobody said so" case this reporting exists
 * for. An ending this plugin does not know is reported as a failure rather than
 * read as success, matching the harness's own rule for consumed work.
 */
export function failureOfReason(reason: unknown): TurnFailure | undefined {
  if (reason === null || typeof reason !== 'object') return undefined
  const record = reason as { kind?: unknown; error?: unknown }
  const kind = typeof record.kind === 'string' ? record.kind : 'unknown'
  switch (kind) {
    case 'completed':
    case 'aborted':
    case 'forked':
      return undefined
    case 'error': {
      const error = record.error as { message?: unknown; code?: unknown } | undefined
      const message = typeof error?.message === 'string' && error.message !== ''
        ? error.message
        : 'the turn failed (the harness recorded an error ending)'
      return { kind: 'error', message }
    }
    case 'blocked':
      return { kind: 'blocked', message: 'the turn was blocked before it could finish' }
    case 'max-tokens':
      return { kind: 'max-tokens', message: 'the turn reached its output-token ceiling' }
    case 'interrupted':
      return {
        kind: 'interrupted',
        message: 'the turn was closed without an ending by the harness (crash-orphaned)',
      }
    default:
      return { kind, message: `the turn ended with an unrecognized reason "${kind}"` }
  }
}

/** ISO timestamp for a durable event's own clock, or null when it has none. */
function isoOfEventTime(time: unknown): string | null {
  return typeof time === 'number' && Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** One provider route a caller may name in `session_create`. */
export interface CatalogProvider {
  /** Route key, as `session_create.provider` expects it. */
  readonly id: string
  /** Human-readable name for diagnostics. */
  readonly name: string
}

/** Models one provider route advertises, as `dsh_info` reports them on request. */
export interface CatalogProviderModels {
  /** Provider route key. */
  readonly provider: string
  readonly models: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
}

/** One agent preset a caller may name in `session_create`. */
export interface CatalogAgentPreset {
  /** Preset id, as `session_create.agentPreset` expects it. */
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Set when the preset failed to compose; it cannot be selected. */
  readonly broken?: string
}

/**
 * What this deployment accepts, read from the running services.
 *
 * The point is to stop callers guessing: `session_create`'s `provider`, `model`
 * and `agentPreset` are free-form strings, and a typo only surfaces when the
 * harness refuses the session. Every field is optional — a profile that mounts no
 * LLM registry still knows its sandbox mode — and `unavailable` says which reads
 * could not be answered instead of failing the whole diagnostic.
 */
export interface DshCatalog {
  /** How many sessions this instance currently knows about. */
  readonly sessionCount?: number
  /** Provider routes with a registered adapter. */
  readonly providers?: readonly CatalogProvider[]
  /**
   * Models per provider route, only when `dsh_info` was asked for them.
   *
   * Reading these asks each adapter, which some of them answer with remote
   * discovery, so it is opt-in and time-boxed per provider.
   */
  readonly providerModels?: readonly CatalogProviderModels[]
  /** Agent presets the caller may choose from. */
  readonly agentPresets?: readonly CatalogAgentPreset[]
  /** The preset used when a caller names none. */
  readonly defaultAgentPreset?: string
  /** The effective file policy (`read-only`, `workspace-write`, `danger-full-access`…). */
  readonly sandboxMode?: string
  /** Advertised permission presets, e.g. `read-only`, `workspace-write`. */
  readonly permissionPresets?: readonly string[]
  /** One line per catalog read that failed or had no provider, for honesty. */
  readonly unavailable?: readonly string[]
}

/**
 * The single seam between MCP tools and a running DeepSeek Harness.
 *
 * Every harness capability is resolved lazily through `ctx.get`, never through
 * `inject`. That is deliberate: this plugin must load in a plain CLI profile
 * where no session or web service exists, and a missing capability should
 * surface as one clear tool error rather than a refused plugin load.
 */
export class DshDriver {
  private readonly log: DshLogger
  /** Whether the durable ownership record has been read yet. */
  private ownershipLoaded = false

  /** Sessions this plugin created, so an opt-in approver can be scoped to them. */
  private readonly ownedSessions = new Set<string>()
  /** Per-session promise chain: one driver-initiated turn runs at a time. */
  private readonly turnQueues = new Map<string, Promise<unknown>>()
  /**
   * Per-session promise chains for worktree creation/restoration.
   *
   * The harness's worktree service does not serialize its callers: two concurrent
   * creates on one session race Git's own locks and the working-directory commit,
   * and a failed creation retains whatever it already wrote. One chain per session
   * makes the second call wait instead of racing the first.
   */
  private readonly worktreeQueues = new Map<string, Promise<unknown>>()
  /**
   * Per-session cancellation generations.
   *
   * A cancel can land after the harness opened the turn but before the prompt was
   * committed as a `user/message` — the window a client hits when it cancels as
   * soon as `session_list { running: true }` shows the session. The durable log
   * then holds no prompt for the waiter to anchor on, so `locateTurn` reports
   * `settled: false` forever and the call used to sit out its full `timeoutMs` and
   * report `timedOut: true` on a turn the caller had already cancelled (measured:
   * a 30 s timeout returned at 29 995 ms with `aborted: false`). This counter lets
   * the wait notice that a cancel was requested for its session and settle as
   * aborted instead. It is a generation, not a flag, so a prompt queued *behind*
   * the cancelled one starts with the current value and is not affected.
   */
  private readonly cancelGenerations = new Map<string, number>()
  /**
   * Idempotency keys this process admitted, with the content they admitted.
   *
   * The durable log is the normal place to find an earlier prompt, but a
   * `wait: false` call returns as soon as `controller.prompt()` resolves, and the
   * user message can be committed a moment later. A retry inside that window used
   * to miss the log entry and ask the agent to do the work twice — observed as two
   * user messages carrying the same `rpcId`. This ledger closes the window; the log
   * remains the fallback for a retry after a restart.
   */
  private readonly admittedPrompts = new Map<string, {
    readonly sessionId: string
    readonly text: string
    readonly images: number
    readonly at: number
  }>()
  /** Background shell jobs by id, in start order. */
  private readonly shellJobs = new Map<string, ShellJobState>()
  private shellJobSeq = 0

  /**
   * Fire-and-forget turns whose settlement is being watched for a push.
   *
   * One abort controller per admitted `session_prompt { wait: false }` while a
   * subscription stream is open. Keyed by the request id so an idempotent retry
   * of the same prompt does not arm a second watch, and aborted as a group when
   * the endpoint is torn down.
   */
  private readonly settlementWatches = new Map<string, AbortController>()

  constructor(
    private readonly ctx: unknown,
    private readonly configSource: () => Config,
    /**
     * The endpoint's push surface, when the transport has one.
     *
     * Absent in stdio serving and in tests that do not exercise push; arming is
     * skipped then, and nothing observes a settlement.
     */
    private readonly pushes?: TurnPushes,
  ) {
    this.log = loggerOf(ctx)
  }

  /**
   * The configuration as it stands now.
   *
   * Every reader goes through this getter, so a settings-panel edit applies to
   * the next turn, command, or request without anything being rebuilt.
   */
  private get config(): Config {
    return this.configSource()
  }

  /** Whether `sessionId` was created through this plugin. */
  ownsSession(sessionId: string): boolean {
    this.ensureOwnershipLoaded()
    return this.ownedSessions.has(sessionId)
  }

  /**
   * Load the remembered ownership record on first use.
   *
   * Lazy rather than in the constructor because a driver is also built by tests
   * and by the status route, and the file is only relevant to session scoping.
   * A failed load is not an error: it leaves the set empty, which hides sessions
   * under `owned` instead of exposing them.
   */
  private ensureOwnershipLoaded(): void {
    if (this.ownershipLoaded) return
    this.ownershipLoaded = true
    for (const sessionId of loadOwnedSessions()) this.ownedSessions.add(sessionId)
  }

  /**
   * Remember a session this endpoint created, so `session.scope: "owned"` still
   * covers it after a restart.
   *
   * Written on every create/fork regardless of the current scope: an operator can
   * switch `session.scope` at runtime, and a session created while the scope was
   * `all` should not become the one exception afterwards.
   */
  private rememberOwnedSession(sessionId: string): void {
    this.ownedSessions.add(sessionId)
    if (!saveOwnedSessions([...this.ownedSessions])) {
      this.log.debug(
        '[dsh-as-mcp] could not persist the owned-session record; ownership of %s lasts until this process restarts',
        sessionId,
      )
    }
  }

  /**
   * The owned session tree: the ids this endpoint created plus every subagent
   * session below one of them.
   *
   * A subagent session is created by the harness on behalf of an owned session, so
   * under `session.scope: "owned"` it belongs to the tree even though the endpoint
   * never called `create` for it. Without this, a session's own bill would exclude
   * the work its subagents did — the exact under-report the usage contract exists
   * to prevent.
   *
   * @param summaries - One session listing; `undefined` means the listing failed.
   * @returns Every visible id, or `undefined` when the scope is `all`.
   */
  private ownedTree(summaries: readonly DshSessionSummary[] | undefined): Set<string> | undefined {
    this.ensureOwnershipLoaded()
    if (this.config.session.scope === 'all') return undefined
    const visible = new Set(this.ownedSessions)
    if (summaries === undefined) return visible
    // One pass is not enough: a grandchild's parent is added by this same loop, so
    // iterate until the set stops growing. Depth is small, but the loop is cheap
    // and avoids an arbitrary nesting limit.
    let grew = true
    while (grew) {
      grew = false
      for (const summary of summaries) {
        if (summary.parentSessionId === undefined) continue
        if (!visible.has(summary.parentSessionId) || visible.has(summary.sessionId)) continue
        visible.add(summary.sessionId)
        grew = true
      }
    }
    return visible
  }

  /** Refuse a session the current scope does not cover, naming the setting. */
  private async assertSessionVisible(sessionId: string, action: string): Promise<void> {
    if (this.config.session.scope === 'all') return
    this.ensureOwnershipLoaded()
    if (this.ownedSessions.has(sessionId)) return
    // Not directly ours: it may still be a subagent session of one that is, and
    // reading that is part of reading the owned tree's cost.
    try {
      const visible = this.ownedTree(await this.sessionSummaries())
      if (visible?.has(sessionId) === true) return
    } catch {
      // A listing failure must fail closed below, not open.
    }
    throw new Error(
      `session ${sessionId} was not created by this endpoint, and session.scope is "owned": ${action} `
        + 'is limited to sessions this endpoint created or forked (and their subagent sessions). Set '
        + 'session.scope: "all" to allow it, or create the session through this endpoint.',
    )
  }

  /**
   * Canonicalise a caller-supplied directory, insisting that it exists and is one.
   *
   * The sandbox policy takes a session's `cwd` as its `workspaceRoot`, so this is
   * not cosmetic: whatever is returned here decides what the agent's write fence
   * contains. `realpath` is deliberate — it resolves a symlinked root to its real
   * location, so the boundary is the directory that actually exists rather than
   * the name it was reached by.
   */
  private async requireUsableDirectory(path: string): Promise<string> {
    const absolute = resolveAbsolute(path)
    let canonical: string
    try {
      canonical = await realpath(absolute)
    } catch {
      throw new Error(
        `cannot use "${path}" as a session directory: it does not exist. `
        + 'Create it first, or pass a workspaceId instead.',
      )
    }
    const info = await stat(canonical)
    if (!info.isDirectory()) {
      throw new Error(`cannot use "${path}" as a session directory: it is not a directory.`)
    }
    return canonical
  }

  /** Capabilities the running profile actually provides, for diagnostics. */
  describeCapabilities(): Record<string, boolean> {
    const query = this.sessionQuery()
    return {
      workspaceRegistry: this.workspaceRegistry() !== undefined,
      sessionController: this.sessionController() !== undefined,
      sessionQuery: query !== undefined,
      agents: this.agentRegistry() !== undefined,
      fs: this.fileSystem() !== undefined,
      shell: this.shellExecutor() !== undefined,
      webServer: serviceOf<unknown>(this.ctx, 'webServer') !== undefined,
      tools: this.toolRegistry() !== undefined,
      events: typeof eventsOf(this.ctx).on === 'function',
      // Usage reporting needs the session log, which is `sessionQuery` (or the
      // controller's `inspect` fallback on ≤0.1.7; 0.2.2 removed that method).
      // Reported separately from `sessionQuery` because "sessions work but their
      // usage cannot be read" is a real profile shape a caller should be able to see.
      tokenUsage: query !== undefined
        || typeof (this.sessionController() as { inspect?: unknown } | undefined)?.inspect === 'function',
      // Money needs a third-party price ledger; the harness has none.
      costMeter: typeof serviceOf<DshCostMeter>(this.ctx, 'costMeter')?.getSessionCost === 'function',
      // Catalog surfaces, so a caller can tell "no providers listed" from
      // "this profile has no llm service to list them from".
      llm: this.llmRegistry() !== undefined,
      agentPresets: this.agentPresetRegistry() !== undefined,
      permissionPresets: this.permissionPresetService() !== undefined,
      sandboxPolicy: this.sandboxMode() !== undefined,
      // `approval.policy: "allow"` needs the approval service and a resolvable agent.
      approval: this.approvalService() !== undefined,
      // Controller operations whose absence is version-dependent, not
      // configuration-dependent: a caller can tell "refused" from "unavailable".
      sessionQueue: typeof (this.sessionController() as { updateQueue?: unknown } | undefined)?.updateQueue === 'function',
      sessionSearch: typeof (this.sessionController() as { search?: unknown } | undefined)?.search === 'function',
      sessionRename: typeof (this.sessionController() as { rename?: unknown } | undefined)?.rename === 'function',
      sessionModel: typeof (this.sessionController() as { selectModel?: unknown } | undefined)?.selectModel === 'function',
      // Forking is a controller operation, not a store one.
      sessionFork: typeof (this.sessionController() as { fork?: unknown } | undefined)?.fork === 'function',
      // Background jobs need a launcher: `start` on 0.1.5, `execute` from 0.1.7.
      shellBackground: (() => {
        const shell = this.shellExecutor()
        return typeof shell?.start === 'function' || typeof shell?.execute === 'function'
      })(),
      // Git worktrees ship in the harness's experimental worktree package, which
      // the forge bundle composes into Desktop/Web. A profile without it still
      // creates sessions; it just cannot isolate one in a checkout.
      worktrees: this.worktreeService() !== undefined,
      // Slash commands and durable goals: both are agent-scoped services, the same
      // bridge worktree creation and dsh_tool_call need.
      commands: typeof this.commandService()?.execute === 'function',
      // Host-global, so the probe answers "is the store mounted", not "may this
      // endpoint touch it" — the scope refusal is a call-time check.
      schedule: typeof this.scheduleService()?.create === 'function',
      // Forge reads need three services together: the live-session store scopes
      // them, forgeSession holds the bindings, forgePanel serves branches/diffs.
      sessions: typeof this.sessionStore()?.get === 'function',
      forgeSession: typeof this.forgeSessionService()?.changeRequests === 'function',
      forgePanel: typeof this.forgePanelService()?.localDiff === 'function',
      goals: typeof this.goalService()?.create === 'function',
      // Creating or restoring a worktree needs the session's live agent as its
      // scope, the same bridge `dsh_tool_call` uses.
      agentResolve: typeof (this.sessionController() as { resolveAgent?: unknown } | undefined)?.resolveAgent
        === 'function',
      // The archive/pin sets the DSH sidebar writes, from the workspace registry.
      sessionArchive: typeof this.workspaceRegistry()?.archiveSession === 'function',
      sessionPin: typeof this.workspaceRegistry()?.pinSession === 'function',
      // The projection read that reports a session's live working directory and
      // the worktree the forge panel created for it. Optional: `session_status`
      // and `session_list { includeWorktree }` omit those fields without it.
      sessionViews: typeof (this.sessionController() as { projections?: unknown } | undefined)?.projections
        === 'function' || typeof query?.observeSession === 'function',
    }
  }

  /**
   * The choices this deployment actually accepts, for callers that would
   * otherwise guess at `session_create`'s provider, model and preset.
   *
   * Every field is optional and independently guarded: this is a diagnostic, so a
   * profile that mounts no LLM registry still reports the sandbox mode it does
   * know, and `unavailable` names what could not be read rather than the whole
   * call failing. Reads are deliberately local —
   * `llm.listModels()` is not used because it can perform remote discovery, and a
   * caller asking "what is available" must not trigger network work.
   */
  async describeCatalog(options: { includeModels?: boolean } = {}): Promise<DshCatalog> {
    const unavailable: string[] = []

    const providers = this.readProviders(unavailable)
    const providerModels = options.includeModels === true && providers !== undefined
      ? await this.readProviderModels(providers, unavailable)
      : undefined
    const presets = await this.readAgentPresets(unavailable)
    const sandboxMode = this.readSandboxMode(unavailable)
    const permissionPresets = this.readPermissionPresets(unavailable)
    let sessionCount: number | undefined
    try {
      const summaries = await this.sessionSummaries()
      if (summaries === undefined) unavailable.push('sessionCount: this profile provides no sessionController service')
      else sessionCount = summaries.length
    } catch (error) {
      unavailable.push(`sessionCount: ${error instanceof Error ? error.message : String(error)}`)
    }

    return {
      ...(sessionCount === undefined ? {} : { sessionCount }),
      ...(providers === undefined ? {} : { providers }),
      ...(providerModels === undefined ? {} : { providerModels }),
      ...(presets === undefined
        ? {}
        : {
          agentPresets: presets.items,
          ...(presets.defaultId === undefined ? {} : { defaultAgentPreset: presets.defaultId }),
        }),
      ...(sandboxMode === undefined ? {} : { sandboxMode }),
      ...(permissionPresets === undefined ? {} : { permissionPresets }),
      ...(unavailable.length === 0 ? {} : { unavailable }),
    }
  }

  private readProviders(unavailable: string[]): readonly CatalogProvider[] | undefined {
    const llm = this.llmRegistry()
    if (llm === undefined) {
      unavailable.push('providers: this profile provides no llm service')
      return undefined
    }
    if (typeof llm.listProviders !== 'function') {
      unavailable.push('providers: the llm service exposes no listProviders()')
      return undefined
    }
    try {
      const listed = llm.listProviders()
      if (!Array.isArray(listed)) {
        unavailable.push('providers: listProviders() returned no array')
        return undefined
      }
      return listed
        .filter((entry): entry is DshLlmProviderInfo =>
          typeof entry?.id === 'string'
          && entry.id !== ''
          && typeof entry?.name === 'string'
          && entry.name !== '')
        .map((entry) => ({ id: entry.id, name: entry.name }))
    } catch (error) {
      unavailable.push(`providers: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Read each route's advertised models, one provider at a time.
   *
   * Per-provider failure is recorded rather than thrown: a profile can mix a local
   * catalog with one adapter that cannot answer, and the rest of the list is still
   * what the caller needs. The timeout keeps a remote catalog from holding
   * `dsh_info` open indefinitely.
   */
  private async readProviderModels(
    providers: readonly CatalogProvider[],
    unavailable: string[],
  ): Promise<readonly CatalogProviderModels[] | undefined> {
    const llm = this.llmRegistry()
    if (typeof llm?.listModels !== 'function') {
      unavailable.push('providerModels: the llm service exposes no listModels()')
      return undefined
    }
    const listed: CatalogProviderModels[] = []
    for (const provider of providers) {
      try {
        const models = await withTimeout(
          llm.listModels(provider.id),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `listing models for "${provider.id}"`,
        )
        listed.push({
          provider: provider.id,
          models: (Array.isArray(models) ? models : [])
            .filter((model): model is DshLlmModelInfo =>
              typeof model?.id === 'string' && model.id !== '' && typeof model?.name === 'string')
            .map((model) => ({
              id: model.id,
              name: model.name,
              ...(typeof model.description === 'string' ? { description: model.description } : {}),
            })),
        })
      } catch (error) {
        unavailable.push(
          `providerModels[${provider.id}]: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return listed.length === 0 ? undefined : listed
  }

  private async readAgentPresets(
    unavailable: string[],
  ): Promise<{ items: readonly CatalogAgentPreset[]; defaultId?: string } | undefined> {
    const registry = this.agentPresetRegistry()
    if (registry === undefined) {
      unavailable.push('agentPresets: this profile provides no agentPresets service')
      return undefined
    }
    if (typeof registry.list !== 'function') {
      unavailable.push('agentPresets: the registry exposes no list()')
      return undefined
    }
    try {
      const listed = await registry.list()
      const items = listed
        .filter((entry): entry is DshAgentPresetInfo => typeof entry?.id === 'string' && entry.id !== '')
        .map((entry) => ({
          id: entry.id,
          ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
          ...(typeof entry.broken === 'string' ? { broken: entry.broken } : {}),
        }))
      return {
        items,
        ...(typeof registry.defaultId === 'string' ? { defaultId: registry.defaultId } : {}),
      }
    } catch (error) {
      unavailable.push(`agentPresets: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private readSandboxMode(unavailable: string[]): string | undefined {
    const mode = this.sandboxMode()
    if (mode === undefined) unavailable.push('sandboxMode: this profile provides no sandboxPolicy service')
    return mode
  }

  private readPermissionPresets(unavailable: string[]): readonly string[] | undefined {
    const service = this.permissionPresetService()
    if (service === undefined) {
      unavailable.push('permissionPresets: this profile provides no permissionPresets service')
      return undefined
    }
    try {
      const names = service.names
      if (!Array.isArray(names)) {
        unavailable.push('permissionPresets: the service reports no names')
        return undefined
      }
      return names.filter((name): name is string => typeof name === 'string' && name !== '')
    } catch (error) {
      unavailable.push(`permissionPresets: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Service lookup
  // ---------------------------------------------------------------------------

  private workspaceRegistry(): DshWorkspaceRegistry | undefined {
    return serviceOf<DshWorkspaceRegistry>(this.ctx, 'workspaceRegistry')
  }

  private sessionController(): DshSessionController | undefined {
    return serviceOf<DshSessionController>(this.ctx, 'sessionController')
  }

  private sessionQuery(): DshSessionQuery | undefined {
    return serviceOf<DshSessionQuery>(this.ctx, 'sessionQuery')
  }

  /**
   * `ctx.commands`, when the profile mounts the command registry.
   *
   * Every shipped DSH composition does (`dsh-base` mounts `@deepseek-ai/dsh-commands`
   * together with the built-in command packages), so a missing service means a
   * stripped-down profile rather than a version difference.
   */
  private commandService(): DshCommandService | undefined {
    return serviceOf<DshCommandService>(this.ctx, 'commands')
  }

  /**
   * `ctx.sessions` — the live-session store the forge services are scoped by.
   *
   * A core harness service (every composition mounts it); absent means a stripped
   * profile, and forge reads degrade to an explicit capability error rather than a
   * TypeError.
   */
  private sessionStore(): DshSessionsService | undefined {
    return serviceOf<DshSessionsService>(this.ctx, 'sessions')
  }

  /** `ctx.forgeSession` — the session → change-request bindings the panel renders. */
  private forgeSessionService(): DshForgeSessionService | undefined {
    return serviceOf<DshForgeSessionService>(this.ctx, 'forgeSession')
  }

  /** `ctx.forgePanel` — branches, local diffs and fresh checks for one session. */
  private forgePanelService(): DshForgePanelService | undefined {
    return serviceOf<DshForgePanelService>(this.ctx, 'forgePanel')
  }

  private requireForgeServices(): { session: DshSessionsService; forgeSession: DshForgeSessionService; panel: DshForgePanelService } {
    const session = this.sessionStore()
    const forgeSession = this.forgeSessionService()
    const panel = this.forgePanelService()
    if (session === undefined || forgeSession === undefined || panel === undefined) {
      throw new DshCapabilityError(
        'forgePanel',
        'this DSH profile provides no forge read surface, so change requests, local diffs and branches '
          + 'cannot be read. DSH Desktop and Web provide it through the forge bundle ("变更请求与工作树"); '
          + 'enable that bundle, or read the same data through shell_run + git.',
      )
    }
    return { session, forgeSession, panel }
  }

  /**
   * The live session handle forge reads are scoped by.
   *
   * `ctx.sessions.get` answers only for a session the harness currently holds live; a
   * cold session has no handle, and activating one just to read its diff would be a
   * side effect. The error says that plainly, because "call session_create then read
   * the diff" is otherwise a confusing dead end.
   */
  private requireLiveSession(services: { session: DshSessionsService }, sessionId: string, action: string): DshSessionHandle {
    const live = services.session.get(sessionId)
    if (live !== undefined) return live
    throw new Error(
      `${action} needs a live session handle for ${sessionId}, and the harness currently holds no live `
        + 'session for it (a cold session has none until something resumes it). Send it one prompt, or use '
        + 'session_status to check whether it is running, then retry.',
    )
  }

  /**
   * `ctx.schedule`, when the profile mounts the Host task store.
   *
   * Shipped Web compositions mount it (`dsh-web-app` composes `@deepseek-ai/dsh-schedule`),
   * but a bare CLI profile may not, and every method here is used through this guard
   * so a missing service degrades to a capability error instead of a crash.
   */
  private scheduleService(): DshScheduleService | undefined {
    return serviceOf<DshScheduleService>(this.ctx, 'schedule')
  }

  private requireScheduleService(): DshScheduleService {
    const service = this.scheduleService()
    if (service === undefined) {
      throw new DshCapabilityError(
        'schedule',
        'this DSH profile provides no schedule service, so recurring tasks cannot be managed. '
          + 'The @deepseek-ai/dsh-web-app bundle provides it through @deepseek-ai/dsh-schedule.',
      )
    }
    return service
  }

  /**
   * Refuse the host-global task surface under an owned scope.
   *
   * A scheduled task is a Host record: it has no owner session, `edit` reaches it by
   * bare id, and its target may be any conversation on this instance. `session.scope:
   * "owned"` exists to keep a handed-out token inside the sessions this endpoint
   * created, and that promise cannot be kept for a record with no owner field — so
   * the whole surface is refused rather than partially filtered.
   */
  private assertScheduleSurfaceAllowed(action: string): void {
    if (this.config.session.scope !== 'owned') return
    throw new Error(
      `${action} is unavailable while session.scope is "owned": scheduled tasks are Host records with no `
        + 'owning session, so they cannot be filtered to the sessions this endpoint created, and their '
        + 'delivery target may name any conversation. Set session.scope: "all" to manage schedules, or keep '
        + 'managing them in the DSH UI.',
    )
  }

  /**
   * `ctx.goals`, when the profile mounts the goal store.
   *
   * Shipped compositions mount it with `@deepseek-ai/dsh-tool-goal`; a profile that
   * drops the goal bundle has no goal surface at all, which is why the probe is
   * separate from `commands`.
   */
  private goalService(): DshGoalService | undefined {
    return serviceOf<DshGoalService>(this.ctx, 'goals')
  }

  private requireCommandService(): DshCommandService {
    const service = this.commandService()
    if (service === undefined) {
      throw new DshCapabilityError(
        'commands',
        'this DSH profile provides no commands service, so slash commands cannot be listed or run. '
          + 'The @deepseek-ai/dsh-base bundle provides it together with the built-in commands.',
      )
    }
    return service
  }

  private requireGoalService(): DshGoalService {
    const service = this.goalService()
    if (service === undefined) {
      throw new DshCapabilityError(
        'goals',
        'this DSH profile provides no goals service, so this session cannot carry a durable goal. '
          + 'The @deepseek-ai/dsh-base bundle provides it through the goal package.',
      )
    }
    return service
  }

  /**
   * `ctx.worktrees`, when the profile mounts one.
   *
   * The service ships in the harness's experimental worktree package, which the
   * forge bundle composes into DSH Desktop and Web ("变更请求与工作树"); a bare
   * profile may not have it at all, so every caller here degrades explicitly
   * rather than assuming it exists.
   */
  private worktreeService(): DshWorktreeService | undefined {
    return serviceOf<DshWorktreeService>(this.ctx, 'worktrees')
  }

  private requireWorktreeService(): DshWorktreeService {
    const service = this.worktreeService()
    if (service === undefined) {
      throw new DshCapabilityError(
        'worktrees',
        'this DSH profile provides no worktrees service, so Git worktrees cannot be created. '
          + 'DSH Desktop and Web provide it through the forge bundle ("变更请求与工作树"); enable that bundle, '
          + 'or use session_create { cwd } to bind a session to an existing checkout.',
      )
    }
    return service
  }

  private approvalService(): DshApprovalService | undefined {
    return serviceOf<DshApprovalService>(this.ctx, 'approval')
  }

  /**
   * Apply `approval.policy: "allow"` to a session this plugin just created.
   *
   * The harness owns the mechanism: switching the session's approval policy to
   * `never` is the deterministic unattended stance, and the harness tells the
   * agent about the switch. Nothing here fakes an approval answerer — the point is
   * that a session driven by an external harness has no human to answer prompts.
   *
   * A failure is reported beside the session rather than failing the create: the
   * session exists and is usable, and the caller needs to know the policy did not
   * take effect.
   */
  private async applyApprovalPolicy(sessionId: string): Promise<{
    approvalPolicy?: 'never'
    approvalPolicyError?: string
  }> {
    if (this.config.approval.policy !== 'allow') return {}
    const approval = this.approvalService()
    if (approval === undefined) {
      return {
        approvalPolicyError:
          'approval.policy is "allow" but this profile provides no approval service, so the session keeps the '
          + 'harness default',
      }
    }
    const controller = this.requireSessionController()
    const resolve = controller.resolveAgent
    if (typeof resolve !== 'function') {
      return {
        approvalPolicyError:
          'approval.policy is "allow" but this harness cannot resolve a session agent, so the policy was not set',
      }
    }
    try {
      const resolution = await resolve.call(controller, sessionId)
      if (!('agent' in resolution)) {
        return {
          approvalPolicyError:
            `approval.policy is "allow" but the session agent could not be resolved: `
            + `${resolution.error instanceof Error ? resolution.error.message : String(resolution.error)}`,
        }
      }
      approval.setPolicy(resolution.agent, 'never')
      return { approvalPolicy: 'never' }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.log.warn('[dsh-as-mcp] could not apply the approval policy to session %s: %s', sessionId, reason)
      return { approvalPolicyError: `approval.policy is "allow" but switching it failed: ${reason}` }
    }
  }


  private agentRegistry(): DshAgentRegistry | undefined {
    return serviceOf<DshAgentRegistry>(this.ctx, 'agents')
  }

  private llmRegistry(): DshLlmRegistry | undefined {
    return serviceOf<DshLlmRegistry>(this.ctx, 'llm')
  }

  private agentPresetRegistry(): DshAgentPresetRegistry | undefined {
    return serviceOf<DshAgentPresetRegistry>(this.ctx, 'agentPresets')
  }

  private permissionPresetService(): DshPermissionPresets | undefined {
    return serviceOf<DshPermissionPresets>(this.ctx, 'permissionPresets')
  }

  private fileSystem(): DshFileSystem | undefined {
    return serviceOf<DshFileSystem>(this.ctx, 'fs')
  }

  private shellExecutor(): DshShellExecutor | undefined {
    return serviceOf<DshShellExecutor>(this.ctx, 'shell')
  }

  /**
   * The file policy this deployment enforces, or `undefined` when no sandbox
   * policy service is mounted (a bare profile), in which case the caller's own
   * configuration is the only authority and nothing is refused.
   *
   * Read per call rather than cached: the panel can change it live.
   */
  private sandboxMode(): string | undefined {
    const policy = serviceOf<DshSandboxPolicy>(this.ctx, 'sandboxPolicy')
    if (policy === undefined) return undefined
    if (typeof policy.resolve === 'function') {
      try {
        return policy.resolve().mode
      } catch {
        // Fall through to the static default rather than failing the call. This
        // guard exists to honour a policy the operator stated, not to make
        // directory creation depend on the policy service being reachable.
      }
    }
    return policy.defaultMode
  }

  private requireWorkspaceRegistry(): DshWorkspaceRegistry {
    const registry = this.workspaceRegistry()
    if (registry === undefined) {
      throw new DshCapabilityError(
        'workspaceRegistry',
        'this DSH profile provides no workspaceRegistry service, so workspaces cannot be registered. '
          + 'The @deepseek-ai/dsh-base bundle provides it.',
      )
    }
    return registry
  }

  private requireSessionController(): DshSessionController {
    const controller = this.sessionController()
    if (controller === undefined) {
      throw new DshCapabilityError(
        'sessionController',
        'this DSH profile provides no sessionController service, so sessions cannot be created or prompted. '
          + 'The @deepseek-ai/dsh-web-app bundle provides it.',
      )
    }
    return controller
  }

  private requireFileSystem(): DshFileSystem {
    const fs = this.fileSystem()
    if (fs === undefined) {
      throw new DshCapabilityError(
        'fs',
        'this DSH profile provides no fs service, so files cannot be read or written.',
      )
    }
    return fs
  }

  private requireShell(): DshShellExecutor {
    const shell = this.shellExecutor()
    if (shell === undefined) {
      throw new DshCapabilityError(
        'shell',
        'this DSH profile provides no shell service, so commands cannot be run.',
      )
    }
    return shell
  }

  // ---------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------

  /** Register an existing directory as a workspace, creating it first when asked. */
  async createWorkspace(request: {
    path: string
    title?: string
    createDirectory?: boolean
  }): Promise<{ workspace: WorkspaceInfo; created: boolean }> {
    const registry = this.requireWorkspaceRegistry()
    const absolute = isAbsolute(request.path) ? request.path : resolveAbsolute(request.path)

    // The directory is created *before* the lookup, and the order matters.
    // `workspaceRegistry.resolveByPath` REJECTS on a path that does not exist
    // rather than returning `undefined` — the harness documents exactly that — so
    // asking it about a directory that is about to be created fails the whole call
    // with a raw ENOENT. That is the common case for this tool: registering a
    // project that does not exist yet.
    if (request.createDirectory !== false) {
      // This is the one place the driver touches `node:fs`, and it has to: the fs
      // seam exposes no directory-creation primitive, because the harness creates
      // directories as a side effect of writing a file inside the fence, and
      // `workspaceRegistry.create()` deliberately refuses a path that does not
      // exist. Registering a project that does not exist yet therefore needs a
      // real mkdir.
      //
      // What it must not do is ignore the deployment's own policy, so a
      // `read-only` instance refuses rather than quietly writing. The fs
      // sandbox's `workspace-write` containment is *not* applied here and cannot
      // be: the directory being created is the new workspace root itself, which
      // is by definition outside the roots that exist before it. The OS remains
      // the only boundary for this single call, which is why it is gated on the
      // policy and why `createDirectory: false` is available.
      const mode = this.sandboxMode()
      if (mode === 'read-only') {
        throw new Error(
          `cannot create the directory "${absolute}": this DSH instance runs the read-only file `
          + 'policy, which forbids it. Create the directory outside this endpoint and call '
          + 'workspace_create again, or change the policy.',
        )
      }
      // A path that exists as a file is a different problem from a missing
      // directory, and mkdir's own `EEXIST: ... mkdir '/etc/hosts'` reads like a
      // failed directory creation rather than "you pointed the tool at a file".
      const existingEntry = await stat(absolute).catch(() => undefined)
      if (existingEntry !== undefined && !existingEntry.isDirectory()) {
        throw new Error(
          `cannot register ${absolute} as a workspace: it exists but is not a directory. `
          + 'Pass the directory that should hold the project, or remove that path.',
        )
      }
      if (existingEntry === undefined) {
        // `workspaceRegistry.create()` canonicalizes through realpath and rejects a
        // missing directory; it deliberately does not mkdir.
        await mkdir(absolute, { recursive: true })
      }
    }

    let existing: Awaited<ReturnType<DshWorkspaceRegistry['resolveByPath']>>
    try {
      existing = await registry.resolveByPath(absolute)
    } catch (error) {
      // Turn the raw realpath failure into something a calling agent can act on:
      // it names the missing directory and the argument that creates it.
      if ((error as { code?: unknown }).code === 'ENOENT') {
        throw new Error(
          `cannot register ${absolute} as a workspace: the directory does not exist. `
          + 'Pass createDirectory: true (the default) to create it.',
        )
      }
      throw error
    }
    if (existing !== undefined) {
      return { workspace: await this.toWorkspaceInfo(existing), created: false }
    }

    const workspace = await registry.create(absolute, request.title)
    return { workspace: await this.toWorkspaceInfo(workspace), created: true }
  }

  /**
   * Unregister one workspace.
   *
   * The registration is removed; **the directory and its files are untouched**, and
   * sessions that ran in it keep their history. That is what makes this safe to
   * expose: it cleans the DSH UI's project list, not the disk. Idempotent — an
   * unknown id reports `deleted: false` rather than failing, so a retried cleanup
   * call is not an error.
   */
  async deleteWorkspace(request: { workspaceId: string }): Promise<{
    workspaceId: string
    deleted: boolean
  }> {
    const registry = this.requireWorkspaceRegistry()
    if (typeof registry.delete !== 'function') {
      throw new Error('this harness exposes no workspace delete(); the registration cannot be removed')
    }
    const deleted = await registry.delete.call(registry, request.workspaceId)
    return { workspaceId: request.workspaceId, deleted }
  }

  /** Every registered workspace, in registry order. */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const registry = this.requireWorkspaceRegistry()
    const workspaces = registry.list()
    return await Promise.all(workspaces.map(async (workspace) => await this.toWorkspaceInfo(workspace)))
  }

  /**
   * Archive one session in the registry-global archive set the DSH sidebar uses.
   *
   * Archiving hides the session from the UI's grouping and gates its future turns,
   * but keeps the log — it is the reversible counterpart to the delete the harness
   * does not offer. Archiving a session with running work is refused unless
   * `stopActivity` is set: stopping work is the part a caller has to ask for
   * explicitly, and the registry then asks the session's work to stop.
   */
  async archiveSession(request: {
    sessionId: string
    stopActivity?: boolean
  }): Promise<{ sessionId: string; archived: true }> {
    await this.assertSessionVisible(request.sessionId, 'session_archive')
    const registry = this.requireWorkspaceRegistry()
    const archive = registry.archiveSession
    if (typeof archive !== 'function') {
      throw new DshCapabilityError(
        'workspaceArchive',
        'this DSH profile cannot archive sessions (workspaceRegistry.archiveSession is missing).',
      )
    }
    try {
      await archive.call(
        registry,
        request.sessionId,
        request.stopActivity === true ? { stopActivity: true } : {},
      )
    } catch (error) {
      throw new Error(
        `could not archive session ${request.sessionId}: ${error instanceof Error ? error.message : String(error)}`
          + (request.stopActivity === true
            ? ''
            : '. If it still has running work, archive with stopActivity: true to stop that work and archive'),
        { cause: error instanceof Error ? error : undefined },
      )
    }
    return { sessionId: request.sessionId, archived: true }
  }

  /** Return an archived session to its recorded position in the DSH UI. */
  async unarchiveSession(request: { sessionId: string }): Promise<{ sessionId: string; archived: false }> {
    await this.assertSessionVisible(request.sessionId, 'session_unarchive')
    const registry = this.requireWorkspaceRegistry()
    const unarchive = registry.unarchiveSession
    if (typeof unarchive !== 'function') {
      throw new DshCapabilityError(
        'workspaceArchive',
        'this DSH profile cannot unarchive sessions (workspaceRegistry.unarchiveSession is missing).',
      )
    }
    try {
      await unarchive.call(registry, request.sessionId)
    } catch (error) {
      throw new Error(
        `could not unarchive session ${request.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }
    return { sessionId: request.sessionId, archived: false }
  }

  /** Pin one session to the top of the DSH UI's session list. */
  async pinSession(request: { sessionId: string }): Promise<{ sessionId: string; pinned: true }> {
    await this.assertSessionVisible(request.sessionId, 'session_pin')
    const registry = this.requireWorkspaceRegistry()
    const pin = registry.pinSession
    if (typeof pin !== 'function') {
      throw new DshCapabilityError(
        'workspacePin',
        'this DSH profile cannot pin sessions (workspaceRegistry.pinSession is missing).',
      )
    }
    try {
      await pin.call(registry, request.sessionId)
    } catch (error) {
      throw new Error(
        `could not pin session ${request.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }
    return { sessionId: request.sessionId, pinned: true }
  }

  /** Remove one session from the DSH UI's pin set. */
  async unpinSession(request: { sessionId: string }): Promise<{ sessionId: string; pinned: false }> {
    await this.assertSessionVisible(request.sessionId, 'session_unpin')
    const registry = this.requireWorkspaceRegistry()
    const unpin = registry.unpinSession
    if (typeof unpin !== 'function') {
      throw new DshCapabilityError(
        'workspacePin',
        'this DSH profile cannot unpin sessions (workspaceRegistry.unpinSession is missing).',
      )
    }
    try {
      await unpin.call(registry, request.sessionId)
    } catch (error) {
      throw new Error(
        `could not unpin session ${request.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }
    return { sessionId: request.sessionId, pinned: false }
  }

  // -------------------------------------------------------------------------
  // Slash commands and durable goals
  // -------------------------------------------------------------------------

  /**
   * The slash commands this session's agent can run, with the ones this endpoint
   * will actually execute marked.
   *
   * A command runs **without a model turn** (the handler is invoked directly), so
   * this is the cheap half of "do the thing a human would type into the composer".
   * `permitted` is reported rather than filtered out: a caller should be able to
   * see that `/permission` exists and that this endpoint deliberately will not run
   * it, instead of guessing why a name is missing.
   */
  async listSessionCommands(request: { sessionId: string }): Promise<{
    sessionId: string
    commands: readonly (DshCommandDescriptor & { readonly permitted: boolean })[]
  }> {
    await this.assertSessionVisible(request.sessionId, 'session_command_list')
    const service = this.requireCommandService()
    const agent = await this.agentForSession(request.sessionId)
    const commands = service.list(agent) ?? []
    return {
      sessionId: request.sessionId,
      commands: commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input === undefined ? {} : { input: command.input }),
        permitted: PERMITTED_COMMANDS.has(command.name),
      })),
    }
  }

  /**
   * Run one slash command against a session's agent.
   *
   * The allow-list is explicit and lives in {@link PERMITTED_COMMANDS}: the set of
   * commands a profile registers is not this endpoint's decision, and two of the
   * shipped ones are deliberately excluded (`/permission` escalates the session's
   * permission preset; `/feedback` writes the user's own review records). A
   * command not on the list is refused **before** the handler runs, so nothing is
   * logged into the session’s history for a refused call.
   */
  async runSessionCommand(request: {
    sessionId: string
    command: string
    signal?: AbortSignal
  }): Promise<SessionCommandResult> {
    await this.assertSessionVisible(request.sessionId, 'session_command')
    const service = this.requireCommandService()
    const line = normalizeCommandLine(request.command)
    const name = line.slice(1).split(/\s+/)[0] ?? ''
    if (!PERMITTED_COMMANDS.has(name)) {
      throw new Error(
        `"${name === '' ? line : `/${name}`}" is not a command this endpoint runs. Permitted: `
          + `${[...PERMITTED_COMMANDS].map((entry) => `/${entry}`).join(', ')}. `
          + 'Refused on purpose: /permission (it changes the session permission preset) and '
          + '/feedback (it writes your own review records). Use session_set_model or the DSH UI for '
          + 'those, or dsh_tool_call for the underlying harness tool.',
      )
    }
    const agent = await this.agentForSession(request.sessionId)
    const execution = await service.execute(
      agent,
      line,
      [],
      request.signal ?? new AbortController().signal,
    )
    if (execution === undefined) {
      throw new Error(
        `"${line}" was not admitted by this session: the command name is unknown here, or its arguments `
          + 'were rejected before a handler ran (nothing was logged). Call session_command_list to see '
          + 'the names and the input hint this agent accepts.',
      )
    }
    const result = execution.result
    return {
      sessionId: request.sessionId,
      commandId: execution.commandId,
      ok: result.kind === 'success',
      ...(result.text === undefined ? {} : { text: result.text }),
      ...(result.kind === 'success' && result.sourceEventSeq !== undefined
        ? { sourceEventSeq: result.sourceEventSeq }
        : {}),
    }
  }

  /**
   * The durable goal this session carries, if any.
   *
   * Goal state lives in the harness's own store and the round driver advances it
   * across turns, so reading it is how a supervising caller answers "what is this
   * session supposed to be doing, and is it paused".
   */
  async sessionGoal(request: { sessionId: string }): Promise<{
    sessionId: string
    goal: SessionGoalView | null
  }> {
    await this.assertSessionVisible(request.sessionId, 'session_goal')
    const service = this.requireGoalService()
    const agent = await this.agentForSession(request.sessionId)
    const goal = service.get(agent)
    return { sessionId: request.sessionId, goal: goal === undefined ? null : projectGoal(goal) }
  }

  /**
   * Create, edit, pause, resume, complete or clear a session's durable goal.
   *
   * `expectedRevision` is the lost-update guard: the harness's own `GoalRef`
   * carries a revision, and a mutation whose revision no longer matches is refused
   * rather than silently rewriting a goal the user edited in the UI a moment ago.
   */
  async mutateSessionGoal(request: {
    sessionId: string
    action: 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'clear'
    objective?: string
    maxGoalRounds?: number
    expectedRevision?: number
  }): Promise<{
    sessionId: string
    action: string
    goal: SessionGoalView | null
    cleared?: true
  }> {
    await this.assertSessionVisible(request.sessionId, 'session_goal')
    const service = this.requireGoalService()
    const agent = await this.agentForSession(request.sessionId)

    if (request.action === 'create') {
      const objective = request.objective?.trim() ?? ''
      if (objective === '') throw new Error('session_goal action "create" needs a non-empty objective')
      const created = service.create(agent, {
        objective,
        ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds }),
      })
      return {
        sessionId: request.sessionId,
        action: request.action,
        goal: projectGoal(created),
      }
    }

    // Every other action mutates the goal that exists right now, so its ref (id +
    // revision) comes from a read rather than from the caller: a caller that has
    // not read the goal first cannot address a stale one by accident.
    const current = service.get(agent)
    if (current === undefined) {
      throw new Error(
        `session ${request.sessionId} has no goal, so "${request.action}" has nothing to act on. `
          + 'Create one with session_goal { action: "create", objective }.',
      )
    }
    const ref = { id: current.id, revision: current.revision }
    if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) {
      throw new Error(
        `session ${request.sessionId}'s goal changed since it was read: expected revision `
          + `${request.expectedRevision}, the goal is at revision ${current.revision}. Re-read it with `
          + 'session_goal { action: "get" } before mutating.',
      )
    }
    switch (request.action) {
      case 'edit': {
        const objective = request.objective?.trim()
        if (objective === undefined || objective === '') {
          if (request.maxGoalRounds === undefined) {
            throw new Error('session_goal action "edit" needs objective and/or maxGoalRounds')
          }
        }
        const edited = service.edit(agent, ref, {
          ...(objective === undefined || objective === '' ? {} : { objective }),
          ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds }),
        })
        return { sessionId: request.sessionId, action: request.action, goal: projectGoal(edited) }
      }
      case 'pause':
        return { sessionId: request.sessionId, action: request.action, goal: projectGoal(service.pause(agent, ref)) }
      case 'resume':
        return { sessionId: request.sessionId, action: request.action, goal: projectGoal(service.resume(agent, ref)) }
      case 'complete':
        return { sessionId: request.sessionId, action: request.action, goal: projectGoal(service.complete(agent, ref)) }
      case 'clear': {
        service.clear(agent, ref)
        return { sessionId: request.sessionId, action: request.action, goal: null, cleared: true }
      }
      default:
        throw new Error(`unsupported goal action: ${String(request.action)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Scheduled automation
  // -------------------------------------------------------------------------

  /**
   * Create one Host scheduled task.
   *
   * The timing is given as an RRULE string (the canonical form the DSH UI writes),
   * or as one of the two simple shorthands the service also accepts (`afterSeconds`
   * for a one-shot, `everySeconds` for a fixed interval). Exactly one form is used;
   * asking for two would leave which one wins to the implementation.
   *
   * The target decides where each delivery lands: an existing conversation
   * (`session`), a conversation created on the first delivery and reused
   * (`new_once`), or a fresh conversation per delivery (`new`).
   */
  async createScheduledTask(request: {
    title: string
    prompt: string
    rrule?: string
    afterSeconds?: number
    everySeconds?: number
    target?: 'session' | 'new_once' | 'new'
    sessionId?: string
    cwd?: string
    agentPreset?: string
  }): Promise<{ task: DshScheduleEntry }> {
    this.assertScheduleSurfaceAllowed('schedule_create')
    const service = this.requireScheduleService()
    const title = request.title.trim()
    const prompt = request.prompt.trim()
    if (title === '') throw new Error('schedule_create needs a non-empty title')
    if (title.length > MAX_SCHEDULE_TITLE_CHARS) {
      throw new Error(`schedule_create title is ${title.length} characters; the harness accepts at most ${MAX_SCHEDULE_TITLE_CHARS}`)
    }
    if (prompt === '') throw new Error('schedule_create needs a non-empty prompt (the instruction delivered each time)')
    const timing = scheduleTimingOf(request)

    const targetKind = request.target ?? (request.sessionId === undefined ? 'new' : 'session')
    const create = {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    }
    let target: DshScheduleTargetRequest
    if (targetKind === 'session') {
      if (request.sessionId === undefined) {
        throw new Error('schedule_create target "session" needs sessionId (the conversation each delivery updates)')
      }
      await this.assertSessionVisible(request.sessionId, 'schedule_create')
      target = { kind: 'session', sessionId: request.sessionId }
    } else {
      if (request.sessionId !== undefined) {
        throw new Error(
          `schedule_create target "${targetKind}" creates its own conversation, so it must not name sessionId`,
        )
      }
      target = { kind: targetKind, ...(Object.keys(create).length === 0 ? {} : { create }) }
    }

    const task = await service.create({ title, prompt, timing, target })
    return { task }
  }

  /**
   * One page of Host scheduled tasks, active first by next occurrence.
   *
   * `active` filters by state: true keeps only active tasks, false only paused and
   * ended ones. Absent returns everything.
   */
  async listScheduledTasks(request: {
    active?: boolean
    limit?: number
    offset?: number
  } = {}): Promise<DshScheduleListResult> {
    this.assertScheduleSurfaceAllowed('schedule_list')
    const service = this.requireScheduleService()
    return await service.list({
      ...(request.active === undefined ? {} : { active: request.active }),
      limit: Math.max(1, Math.min(request.limit ?? DEFAULT_SCHEDULE_PAGE, MAX_SCHEDULE_PAGE)),
      offset: Math.max(0, request.offset ?? 0),
    })
  }

  /** One task by id, or a `found: false` answer for an id that no longer exists. */
  async viewScheduledTask(request: { scheduleId: string }): Promise<{
    found: boolean
    id: string
    task?: DshScheduleEntry
  }> {
    this.assertScheduleSurfaceAllowed('schedule_view')
    const service = this.requireScheduleService()
    const found = await service.view({ id: request.scheduleId })
    if ('code' in found) return { found: false, id: request.scheduleId }
    return { found: true, id: request.scheduleId, task: found }
  }

  /**
   * Update or delete one task.
   *
   * `expectedUpdatedAt` is the lost-update guard: an update or delete whose task
   * changed after that read reports a conflict and changes nothing. `active: false`
   * pauses and `active: true` resumes — a resume needs a future occurrence, which is
   * why the harness may refuse it for an exhausted rule.
   */
  async editScheduledTask(request: {
    scheduleId: string
    action: 'update' | 'delete'
    title?: string
    prompt?: string
    rrule?: string
    afterSeconds?: number
    everySeconds?: number
    target?: 'session' | 'new_once' | 'new'
    sessionId?: string
    cwd?: string
    agentPreset?: string
    active?: boolean
    expectedUpdatedAt?: string | null
  }): Promise<{
    updated?: true
    deleted?: true
    found: boolean
    conflict?: true
    id: string
    task?: DshScheduleEntry
  }> {
    this.assertScheduleSurfaceAllowed('schedule_edit')
    const service = this.requireScheduleService()

    if (request.action === 'delete') {
      if (request.title !== undefined || request.prompt !== undefined || request.rrule !== undefined
        || request.afterSeconds !== undefined || request.everySeconds !== undefined
        || request.target !== undefined || request.sessionId !== undefined
        || request.cwd !== undefined || request.agentPreset !== undefined || request.active !== undefined) {
        throw new Error('schedule_edit action "delete" accepts no change fields; delete removes the task and its saved deliveries')
      }
      const result = await service.edit({
        id: request.scheduleId,
        action: 'delete',
        ...(request.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: request.expectedUpdatedAt }),
      })
      return scheduleEditOutcome(request.scheduleId, result)
    }

    const patch: Record<string, unknown> = {}
    if (request.title !== undefined) {
      const title = request.title.trim()
      if (title === '') throw new Error('schedule_edit title must not be empty')
      if (title.length > MAX_SCHEDULE_TITLE_CHARS) {
        throw new Error(`schedule_edit title is ${title.length} characters; the harness accepts at most ${MAX_SCHEDULE_TITLE_CHARS}`)
      }
      patch.title = title
    }
    if (request.prompt !== undefined) {
      const prompt = request.prompt.trim()
      if (prompt === '') throw new Error('schedule_edit prompt must not be empty')
      patch.prompt = prompt
    }
    if (request.rrule !== undefined || request.afterSeconds !== undefined || request.everySeconds !== undefined) {
      patch.timing = scheduleTimingOf(request)
    }
    if (request.active !== undefined) patch.active = request.active
    if (request.target !== undefined || request.sessionId !== undefined || request.cwd !== undefined || request.agentPreset !== undefined) {
      const targetKind = request.target ?? (request.sessionId === undefined ? undefined : 'session')
      if (targetKind === undefined) {
        throw new Error('schedule_edit: cwd/agentPreset only apply to a "new"/"new_once" target; pass target too')
      }
      if (targetKind === 'session') {
        if (request.sessionId === undefined) throw new Error('schedule_edit target "session" needs sessionId')
        await this.assertSessionVisible(request.sessionId, 'schedule_edit')
        patch.target = { kind: 'session', sessionId: request.sessionId }
      } else {
        if (request.sessionId !== undefined) {
          throw new Error(`schedule_edit target "${targetKind}" creates its own conversation, so it must not name sessionId`)
        }
        const create = {
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        }
        patch.target = { kind: targetKind, ...(Object.keys(create).length === 0 ? {} : { create }) }
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new Error(
        'schedule_edit action "update" needs at least one change: title, prompt, rrule/afterSeconds/everySeconds, '
          + 'target/sessionId/cwd/agentPreset, or active',
      )
    }
    const result = await service.edit({
      id: request.scheduleId,
      action: 'update',
      patch,
      ...(request.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: request.expectedUpdatedAt }),
    })
    return scheduleEditOutcome(request.scheduleId, result)
  }

  // -------------------------------------------------------------------------
  // Forge reads (change requests, local diffs, branches)
  // -------------------------------------------------------------------------

  /**
   * The change requests a session has bound, with their cached snapshots.
   *
   * This is the panel's own list: a binding is created when the agent opened a
   * change request, referenced one, discovered it from a branch, or the user tracked
   * it. `includeChecks` refreshes the checks for each bound request whose snapshot
   * carries a head SHA (one forge call per request, so it is opt-in); `includeDiff`
   * asks for the file list of each request's diff. All of it is read-only.
   */
  async forgeChanges(request: {
    sessionId: string
    includeChecks?: boolean
    includeDiff?: boolean
    maxFiles?: number
  }): Promise<{
    sessionId: string
    changes: readonly ForgeChangeView[]
    truncated?: { checks?: true; diff?: true }
  }> {
    await this.assertSessionVisible(request.sessionId, 'forge_changes')
    const services = this.requireForgeServices()
    const live = this.requireLiveSession(services, request.sessionId, 'forge_changes')
    const bindings = services.forgeSession.changeRequests(live) ?? []
    const maxFiles = Math.max(1, Math.min(request.maxFiles ?? 50, 200))
    const truncated: { checks?: true; diff?: true } = {}
    let anyTruncated = false
    const changes: ForgeChangeView[] = []
    for (const binding of bindings) {
      // `effective` is the binding as it will be reported: the cached one, or the
      // one carrying a freshly refreshed snapshot. A refresh failure keeps the
      // cached snapshot and marks the view stale instead of hiding the binding.
      let effective = binding
      let refreshed = false
      const snapshot = binding.update?.snapshot
      if (request.includeChecks === true && binding.url !== '' && snapshot !== undefined
        && typeof services.panel.changeRequestChecks === 'function') {
        try {
          const fresh = await services.panel.changeRequestChecks(live, binding.url, snapshot.headSha)
          effective = {
            ...binding,
            update: { ...(binding.update ?? { fetchedAt: Date.now() }), snapshot: fresh },
          }
          refreshed = true
        } catch {
          refreshed = false
          anyTruncated = true
        }
      }
      let diff: ForgeDiffSummary | undefined
      if (request.includeDiff === true && effective.url !== '' && typeof services.panel.changeRequestDiff === 'function') {
        try {
          const fresh = await services.panel.changeRequestDiff(live, effective.url)
          diff = forgeDiffSummary(fresh, maxFiles)
          if (fresh.files.length > maxFiles) truncated.diff = true
        } catch {
          truncated.diff = true
        }
      }
      // `checksStale` only makes sense for a binding whose refresh was attempted
      // and failed; a plain read of an unauthenticated binding shows its failure.
      const stale = request.includeChecks === true && !refreshed && snapshot !== undefined && binding.url !== ''
      changes.push(forgeViewOf(effective, diff, stale))
    }
    if (anyTruncated && truncated.checks === undefined) truncated.checks = true
    return {
      sessionId: request.sessionId,
      changes,
      ...(Object.keys(truncated).length === 0 ? {} : { truncated }),
    }
  }

  /**
   * The working-tree diff the forge panel shows for one session.
   *
   * `scope` is the panel's view selector: `uncommitted` (default) is everything not
   * yet committed, `branch` is the session branch against its base, `staged` and
   * `unstaged` split the index. With `path`, the unified patch text of one file is
   * returned instead of the whole listing — that is the only form that can be large,
   * so it is bounded by {@link MAX_FORGE_PATCH_CHARS}.
   */
  async forgeLocalDiff(request: {
    sessionId: string
    scope?: 'branch' | 'uncommitted' | 'unstaged' | 'staged'
    path?: string
    maxFiles?: number
    maxChars?: number
    signal?: AbortSignal
  }): Promise<{
    sessionId: string
    scope: string
    base: string | null
    files: readonly ForgeFileSummary[]
    omitted: number
    text?: string
    textTruncated?: true
  }> {
    await this.assertSessionVisible(request.sessionId, 'forge_local_diff')
    const services = this.requireForgeServices()
    const live = this.requireLiveSession(services, request.sessionId, 'forge_local_diff')
    const scope = { kind: request.scope ?? 'uncommitted' } as const
    if (request.path !== undefined) {
      const text = await services.panel.localText(live, scope, request.path, request.signal)
      const limit = Math.max(1, Math.min(request.maxChars ?? DEFAULT_FORGE_PATCH_CHARS, MAX_FORGE_PATCH_CHARS))
      const bounded = truncateText(text, limit)
      return {
        sessionId: request.sessionId,
        scope: scope.kind,
        base: null,
        files: [],
        omitted: 0,
        text: bounded,
        ...(bounded.length < text.length ? { textTruncated: true as const } : {}),
      }
    }
    const diff = await services.panel.localDiff(live, scope, request.signal)
    const maxFiles = Math.max(1, Math.min(request.maxFiles ?? 50, 200))
    return {
      sessionId: request.sessionId,
      scope: scope.kind,
      base: diff.base,
      files: diff.files.slice(0, maxFiles).map(forgeFileSummary),
      omitted: diff.omitted + Math.max(0, diff.files.length - maxFiles),
    }
  }

  /** The branches this session's checkout has, and which one is current. */
  async forgeBranches(request: { sessionId: string; signal?: AbortSignal }): Promise<{
    sessionId: string
    current: string | null
    branches: readonly string[]
  }> {
    await this.assertSessionVisible(request.sessionId, 'forge_branches')
    const services = this.requireForgeServices()
    const live = this.requireLiveSession(services, request.sessionId, 'forge_branches')
    const branches = await services.panel.branches(live, request.signal)
    return { sessionId: request.sessionId, current: branches.current, branches: branches.branches }
  }

  private async toWorkspaceInfo(
    workspace: ReturnType<DshWorkspaceRegistry['list']>[number],
  ): Promise<WorkspaceInfo> {
    return {
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      sessionCount: workspace.sessionIds.length,
      status: await workspace.status(),
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  /**
   * Explain a model-selection failure in terms the caller can act on.
   *
   * The harness's own sentence ("Select an available model before sending a
   * message.") names neither the values tried nor the ones that exist, which leaves
   * an external harness guessing. This adds the requested pair, whether the route is
   * registered at all, the routes that are, and the call that lists their models.
   */
  private modelFailureMessage(provider: string, model: string, reason: string): string {
    const known = this.readProviders([])
    const knownIds = known?.map((entry) => entry.id) ?? []
    return [
      reason,
      `requested provider "${provider}" model "${model}"`,
      knownIds.includes(provider) ? undefined : `"${provider}" is not a registered provider route`,
      knownIds.length > 0 ? `known routes: ${knownIds.join(', ')}` : 'this profile lists no provider routes',
      'call dsh_info with includeModels: true to list each route\'s models',
    ].filter((part): part is string => part !== undefined).join('; ')
  }

  /**
   * Switch the model route used by one session's subsequent turns.
   *
   * Creation is not the only moment a route matters: a caller may start cheap and
   * escalate for a hard turn, or fall back when a provider rate-limits. The harness
   * keeps the selection durable on the session, so the next `session_prompt` on this
   * session uses it; the reply's per-model usage shows which route spent what.
   *
   * @param request.reasoningEffort - optional effort level for routes that expose one.
   */
  async setSessionModel(request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<{
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }> {
    await this.assertSessionVisible(request.sessionId, 'session_set_model')
    const controller = this.requireSessionController()
    try {
      const selected = await controller.selectModel({
        sessionId: request.sessionId,
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      })
      return {
        sessionId: request.sessionId,
        provider: selected.selected.provider,
        model: selected.selected.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      }
    } catch (error) {
      throw new Error(this.modelFailureMessage(
        request.provider,
        request.model,
        error instanceof Error ? error.message : String(error),
      ))
    }
  }

  /** Create a session bound to a workspace (or a bare directory) and pick its model. */
  async createSession(request: {
    workspaceId?: string
    cwd?: string
    agentPreset?: string
    provider?: string
    model?: string
    /**
     * Also create a Git worktree for the new session and enter it.
     *
     * The session is created first, bound to the workspace/directory the caller
     * named, then the worktree is created from that checkout and becomes the
     * session's live working directory. Its durable header keeps the directory it
     * was created in: a session created with `workspaceId` therefore stays in that
     * workspace group (only sessions created that way are in one), while a
     * cwd-only session stays ungrouped. This is the same sequence the DSH UI's
     * "New worktree" option performs, and it lets several sessions in one
     * workspace group each isolate their work.
     *
     * `name` is the new branch and checkout name (`.agents/worktrees/<name>` under
     * the source checkout); omitted, the harness generates one. `from` is a local
     * commit, branch, or tag; omitted, the source checkout's HEAD.
     */
    worktree?: {
      name?: string
      from?: string
    }
  }): Promise<{
    sessionId: string
    cwd?: string
    agentPreset?: string
    model?: string
    /** Set when the session was created but its requested model was not applied. */
    modelSelectionError?: string
    /** The session's approval policy, when `approval.policy: "allow"` applied it. */
    approvalPolicy?: 'never'
    /** Why `approval.policy: "allow"` could not be applied, if it could not. */
    approvalPolicyError?: string
    /** The worktree created for the session and entered, when one was requested. */
    worktree?: WorktreeInfo
    /** The live working directory after creation, when it could be read. */
    workingDirectory?: string
    /**
     * Why a requested worktree was not created.
     *
     * The session itself exists and works in the directory it was created in: a
     * failed worktree request is reported here rather than failing the whole call,
     * the same policy `modelSelectionError` follows. Retry with `worktree_create`.
     */
    worktreeError?: string
  }> {
    const controller = this.requireSessionController()

    const workspaceId = request.workspaceId
    // Resolved to an absolute path here: the session header requires one, and a
    // relative directory would otherwise be accepted by the call and rejected
    // later by the harness. Canonicalised and checked, because this value becomes
    // the session's `workspaceRoot` — the sandbox's containment boundary for
    // everything the agent then does. A typo, a file, or a path that does not
    // exist would otherwise be accepted here and fail confusingly much later.
    let cwd = request.cwd === undefined ? undefined : await this.requireUsableDirectory(request.cwd)
    if (workspaceId === undefined && cwd === undefined) {
      throw new Error('provide either workspaceId or cwd when creating a session')
    }
    if (workspaceId !== undefined) {
      const workspace = this.requireWorkspaceRegistry().get(workspaceId)
      if (workspace === undefined) throw new Error(`unknown workspaceId: ${workspaceId}`)
      // Kept for the reply only. It must not be forwarded to `create`: the
      // harness rejects `workspaceId` and `cwd` together and resolves the
      // directory from the workspace itself, so passing both — which is what
      // deriving `cwd` here and passing it on did — fails every call that names
      // a workspace, i.e. the primary path.
      cwd = workspace.path
    }

    const agentPreset = optional(request.agentPreset) ?? optional(this.config.session.agentPreset)
    // Validated before the session exists: a half route must not leave a live session
    // behind while the caller is told the call failed.
    const requestedProvider = optional(request.provider)
    const requestedModel = optional(request.model)
    if ((requestedProvider === undefined) !== (requestedModel === undefined)) {
      throw new Error(
        'session_create needs provider and model together: pass both to select a route, or neither to use the '
          + `profile default. Received only ${requestedProvider === undefined
            ? `model "${requestedModel ?? ''}"`
            : `provider "${requestedProvider}"`}.`,
      )
    }
    // A worktree request against a profile that has no worktree service is refused
    // before the session exists. The alternative — create the session and report
    // `worktreeError` — would leave an orphan session and a UI row behind for a
    // request that was impossible from the start.
    if (request.worktree !== undefined) this.requireWorktreeService()

    const created = await controller.create({
      ...(workspaceId === undefined ? { cwd: cwd as string } : { workspaceId }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    this.rememberOwnedSession(created.sessionId)

    // The worktree is created after the session exists — it needs a live agent as
    // its scope — and before the model is selected, so the session is already in
    // its final directory when any route is installed. A failure here does not
    // undo the session: the caller gets a usable session plus the reason, and can
    // retry with `worktree_create`.
    let worktree: WorktreeInfo | undefined
    let worktreeError: string | undefined
    if (request.worktree !== undefined) {
      try {
        const reply = await this.createWorktree({
          sessionId: created.sessionId,
          ...(request.worktree.name === undefined ? {} : { name: request.worktree.name }),
          ...(request.worktree.from === undefined ? {} : { from: request.worktree.from }),
        })
        worktree = worktreeInfoOf(reply)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        worktreeError = `the session was created, but its worktree was not: ${reason}`
        this.log.warn('[dsh-as-mcp] session %s was created without its requested worktree: %s', created.sessionId, reason)
      }
    }

    // A request pair is used whole; otherwise the configured pair is. Never one from
    // each source, which is how a request provider could end up with a config model.
    const provider = requestedProvider ?? optional(this.config.session.provider)
    const model = requestedModel ?? optional(this.config.session.model)
    let selected: string | undefined
    let modelSelectionError: string | undefined
    if (provider !== undefined && model !== undefined) {
      try {
        const result = await controller.selectModel({ sessionId: created.sessionId, provider, model })
        selected = `${result.selected.provider}/${result.selected.model}`
      } catch (error) {
        // The session exists and is usable on its default route, so failing the
        // whole call here would be the worst of both: the caller is told nothing
        // happened while a live session sits in the DSH UI. The essential job —
        // creating the session — succeeded, so it is reported as such, with the
        // model problem stated plainly enough to act on.
        const reason = error instanceof Error ? error.message : String(error)
        modelSelectionError = this.modelFailureMessage(provider, model, reason)
        this.log.warn(
          '[dsh-as-mcp] session %s was created but the requested model %s/%s could not be selected: %s',
          created.sessionId,
          provider,
          model,
          modelSelectionError,
        )
      }
    } else if (provider !== undefined || model !== undefined) {
      // The profile itself sets half a pair. The session is created (the caller did
      // not ask for a route), but the reply says why no route was selected instead of
      // leaving it to a log line the caller cannot see.
      modelSelectionError = [
        `the profile settings name ${provider === undefined ? `a model ("${model}")` : `a provider ("${provider}")`}`,
        'without its counterpart, so no route was selected',
        'pass provider and model together to session_create, or set both in the session settings',
      ].join('; ')
      this.log.warn('[dsh-as-mcp] %s', modelSelectionError)
    }

    const approval = await this.applyApprovalPolicy(created.sessionId)

    return {
      sessionId: created.sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
      ...(selected === undefined ? {} : { model: selected }),
      ...(modelSelectionError === undefined ? {} : { modelSelectionError }),
      ...(approval.approvalPolicy === undefined ? {} : { approvalPolicy: approval.approvalPolicy }),
      ...(approval.approvalPolicyError === undefined ? {} : { approvalPolicyError: approval.approvalPolicyError }),
      ...(worktree === undefined ? {} : { worktree }),
      // After a successful worktree create the checkout IS the working directory;
      // reporting it saves the caller a follow-up read.
      ...(worktree === undefined ? {} : { workingDirectory: worktree.path }),
      ...(worktreeError === undefined ? {} : { worktreeError }),
    }
  }

  /**
   * Create a Git worktree for an existing session and enter it there.
   *
   * The worktree is created from the checkout the session is currently working in,
   * on a brand-new branch, and becomes the session's live working directory. The
   * session's durable header keeps the directory it was created in, so a session
   * created with `workspaceId` keeps that workspace group (a cwd-only session was
   * never in one); the worktree is what its tools, commands, and prompts then
   * operate in.
   *
   * The session must be resolvable to a live agent: the agent is the scope the
   * harness uses to pick the source repository and enforce the session's file
   * policy, so there is no agentless form (and no way for an external caller to
   * sidestep the sandbox by asking for a path it could not otherwise write).
   */
  async createWorktree(request: {
    sessionId: string
    name?: string
    from?: string
    signal?: AbortSignal
  }): Promise<WorktreeReply> {
    await this.assertSessionVisible(request.sessionId, 'worktree_create')
    return await this.withWorktreeLock(request.sessionId, async () => {
      const worktrees = this.requireWorktreeService()
      const agent = await this.agentForSession(request.sessionId)
      // The harness does not check this: it would switch the directory under the
      // open turn and queue the change notice mid-flight. Refusing is the honest
      // answer, and it names the two ways out.
      if (this.agentRegistry()?.get(request.sessionId)?.status === 'running') {
        throw new Error(
          `session ${request.sessionId} has a running turn; wait for it to settle (session_status { waitMs }) `
            + 'or cancel it (session_cancel) before moving the session into a worktree',
        )
      }
      let created: DshWorktreeRecord
      try {
        created = await worktrees.create(agent, {
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.from === undefined ? {} : { from: request.from }),
        }, request.signal)
      } catch (error) {
        throw new Error(
          `could not create a worktree for session ${request.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error instanceof Error ? error : undefined },
        )
      }
      return {
        sessionId: request.sessionId,
        path: created.path,
        branch: created.branch,
        baseCommit: created.baseCommit,
        repositoryRoot: created.repositoryRoot,
        // The harness resolves the revision but does not echo it back; the caller's
        // spelling is the honest answer, and null means the source HEAD.
        from: request.from ?? null,
      }
    })
  }

  /**
   * Restore a worktree that was removed outside the session.
   *
   * The session may still be working in that directory (or was moved away); the
   * harness recreates the checkout at the recorded path from the recorded branch,
   * recreating the branch at `baseCommit` when it was deleted too. Uncommitted
   * changes that were lost with the directory cannot be recovered.
   */
  async restoreWorktree(request: {
    sessionId: string
    path: string
    branch: string
    baseCommit: string
    repositoryRoot: string
    signal?: AbortSignal
  }): Promise<RestoreWorktreeReply> {
    await this.assertSessionVisible(request.sessionId, 'worktree_restore')
    return await this.withWorktreeLock(request.sessionId, async () => {
      const worktrees = this.requireWorktreeService()
      const agent = await this.agentForSession(request.sessionId)
      if (this.agentRegistry()?.get(request.sessionId)?.status === 'running') {
        throw new Error(
          `session ${request.sessionId} has a running turn; wait for it to settle (session_status { waitMs }) `
            + 'or cancel it (session_cancel) before restoring its worktree',
        )
      }
      let restored: DshRestoredWorktree
      try {
        restored = await worktrees.restore(agent, {
          path: request.path,
          branch: request.branch,
          baseCommit: request.baseCommit,
          repositoryRoot: request.repositoryRoot,
        }, request.signal)
      } catch (error) {
        throw new Error(
          `could not restore the worktree of session ${request.sessionId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          { cause: error instanceof Error ? error : undefined },
        )
      }
      return { sessionId: request.sessionId, path: restored.path, branchRecreated: restored.branchRecreated }
    })
  }

  /**
   * Run one worktree operation after the previous one on the same session settles.
   *
   * The harness's worktree service has no lock of its own: concurrent calls on one
   * session race Git's locks and the working-directory commit, and a failed creation
   * retains whatever it already wrote (its own error says so). This chain is per
   * session, so different sessions still create worktrees concurrently.
   */
  private async withWorktreeLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.worktreeQueues.get(sessionId) ?? Promise.resolve()
    // `then(action, action)`: a failed predecessor still lets this operation run —
    // this is a queue, not a circuit breaker.
    const operation = previous.then(action, action)
    const settled = operation.then(() => undefined, () => undefined)
    this.worktreeQueues.set(sessionId, settled)
    try {
      return await operation
    } finally {
      if (this.worktreeQueues.get(sessionId) === settled) this.worktreeQueues.delete(sessionId)
    }
  }

  /**
   * Resolve the live agent that scopes a worktree operation.
   *
   * An already-live agent is preferred: `resolveAgent` on a cold session is not a
   * read. It opens the log, mounts the session's preset and takes the
   * single-writer handle, so it can fail with `session/writer-held` or
   * `session/agent-busy` while another client holds the session (the DSH UI's own
   * forge panel is exactly such a client). Falling back to it is still correct for
   * a session this endpoint created and then parked.
   */
  private async agentForSession(sessionId: string): Promise<DshAgentHandle> {
    const live = this.agentRegistry()?.get(sessionId)
    if (live !== undefined) return live as DshAgentHandle
    const controller = this.requireSessionController()
    if (typeof controller.resolveAgent !== 'function') {
      throw new DshCapabilityError(
        'agents',
        'this DSH profile cannot resolve a session to an agent (sessionController.resolveAgent is missing), '
          + 'and a worktree is created under a session\u2019s own file policy, so there is no scope to run it in.',
      )
    }
    const found = await controller.resolveAgent(sessionId)
    if ('error' in found) {
      throw new Error(
        `session "${sessionId}" could not be scoped to an agent: `
          + `${found.error instanceof Error ? found.error.message : String(found.error)}`,
      )
    }
    return found.agent
  }

  /**
   * Canonicalise a filter path, tolerating one that does not exist.
   *
   * Session summaries store the directory the harness resolved, so comparing a
   * caller's `/tmp/x` with the stored `/private/tmp/x` would silently match
   * nothing on macOS. A path that cannot be resolved is compared as given (the
   * filter is a query, not a security boundary).
   */
  private async canonicalFilterPath(path: string): Promise<string> {
    try {
      return await realpath(resolveAbsolute(path))
    } catch {
      return path
    }
  }

  /**
   * Session summaries, newest first.
   *
   * `includeTitle` opts into one durable-log read per session to fold its latest
   * title — cheap for a handful of sessions and pointless for a page of 200, which
   * is why it is off by default. A title that cannot be read is omitted rather
   * than failing the listing.
   *
   * `includeWorktree` opts into one projection read per session, reporting the
   * live working directory and any worktree record the forge panel created. That
   * is how a caller tells two sessions of the same workspace apart when each is
   * working in its own checkout — also off by default, for the same cost reason.
   */
  async listSessions(
    limit: number,
    options: {
      includeTitle?: boolean
      includeWorktree?: boolean
      /** Only sessions whose workspace directory is this one (canonicalised). */
      cwd?: string
      /** Only sessions that are currently running (`true`) or idle (`false`). */
      running?: boolean
      /**
       * Only root sessions (`root`) or only subagent sessions (`subagent`).
       *
       * With `parentSessionId` on the rows this is the other half of a tree view:
       * "which of these did I start" and "which are my agents' children".
       */
      origin?: 'root' | 'subagent'
    } = {},
  ): Promise<{ sessions: SessionInfo[]; total: number }> {
    const controller = this.requireSessionController()
    const listed = await controller.list({}, new AbortController().signal)
    // The filter runs before the limit so "the first 20 of my sessions" means what
    // it says; a limit applied first would return whatever happened to be recent.
    const cwd = options.cwd === undefined ? undefined : await this.canonicalFilterPath(options.cwd)
    const allowed = this.ownedTree(listed.items)
    const filtered = listed.items.filter((item) => {
      if (allowed !== undefined && !allowed.has(item.sessionId)) return false
      if (options.running !== undefined && item.running !== options.running) return false
      if (options.origin !== undefined) {
        const isSubagent = item.origin === 'subagent'
        if (options.origin === 'subagent' ? !isSubagent : isSubagent) return false
      }
      if (cwd !== undefined && item.cwd !== cwd) return false
      return true
    })
    const items = filtered.slice(0, limit)
    const titles = options.includeTitle === true ? await this.readTitles(items.map((item) => item.sessionId)) : new Map()
    // The listing already carries summary projection hints on 0.2.2+, so the
    // common case costs nothing extra. Only a row from an older profile (no
    // `projections` hint) pays one exact per-session read.
    const views = new Map<string, SessionViews>()
    if (options.includeWorktree === true) {
      for (const item of items) {
        views.set(
          item.sessionId,
          item.projections === undefined
            ? await this.readSessionViews(item.sessionId)
            : viewsOfProjectionValues(item.projections.values),
        )
      }
    }
    // Archive and pin state is registry-global and cheap to read, so the flags are
    // reported whenever the registry exposes its sets — a caller listing sessions
    // should not have to guess why one disappeared from the DSH UI's view.
    const registry = this.workspaceRegistry()
    const archived = registry?.archivedSessionIds
    const pinned = registry?.pinnedSessionIds
    // `total` counts what the filter matched, not what was returned: without it a
    // caller cannot tell "these are all my sessions" from "the first page of them".
    return {
      total: filtered.length,
      sessions: items.map((item) => ({
        sessionId: item.sessionId,
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        running: item.running,
        blank: item.blank,
        updatedAt: item.updatedAt,
        ...(titles.get(item.sessionId) === undefined ? {} : { title: titles.get(item.sessionId) as string }),
        ...(views.get(item.sessionId) === undefined ? {} : views.get(item.sessionId) as SessionViews),
        // Parentage is what turns a flat list into an agent tree: a caller can
        // see which sessions are subagents of the one it started, without reading
        // each transcript.
        ...(item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId }),
        ...(item.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        // Only reported when the registry exposes its sets: older hosts have no
        // archive feature at all, and claiming `false` there would be a guess.
        ...(archived === undefined && pinned === undefined
          ? {}
          : {
            archived: archived?.includes(item.sessionId) ?? false,
            pinned: pinned?.includes(item.sessionId) ?? false,
          }),
      })),
    }
  }

  /** Latest title per session id, skipping the ones that cannot be read. */
  private async readTitles(sessionIds: readonly string[]): Promise<Map<string, string>> {
    const query = this.sessionQuery()
    const read = query?.readTitleSnapshot
    const titles = new Map<string, string>()
    if (typeof read !== 'function') return titles
    for (const sessionId of sessionIds) {
      try {
        const observation = await read.call(query, sessionId)
        const title = observation?.title?.title
        if (typeof title === 'string' && title !== '') titles.set(sessionId, title)
      } catch (error) {
        this.log.debug(
          '[dsh-as-mcp] could not read the title of session %s: %s',
          sessionId,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    return titles
  }

  /**
   * A bounded, projected view of the newest durable events of one session.
   *
   * This is the read half of the `dsh://session/{id}/events` push feed: the
   * notification says "something changed", this says what. It intentionally
   * projects rather than returning raw events — the feed is a progress signal, and
   * a whole assistant message or tool result belongs in `session_messages`.
   *
   * @param request.sessionId - session whose newest events are wanted.
   * @param request.maxEvents - ceiling on returned events (default 64, max 200).
   */
  async sessionEventTail(request: {
    sessionId: string
    maxEvents?: number
  }): Promise<SessionEventFeed> {
    await this.assertSessionVisible(request.sessionId, 'session events feed')
    const events = await this.readEvents(request.sessionId)
    const limit = Math.max(1, Math.min(request.maxEvents ?? 64, 200))
    return {
      sessionId: request.sessionId,
      asOfSeq: events.at(-1)?.seq ?? 0,
      events: events.slice(-limit).map((event) => projectSessionEvent(event)),
    }
  }

  /**
   * The projection values a feed or status read reports for one session.
   *
   * Only an allowlisted set is returned: the raw projection map also carries the
   * inbox, tool catalog and attachment limits, which are not progress signals and
   * are not this endpoint's to mirror. `worktree` is derived from the harness's
   * `forgeWorktree` projection; the rest are passed through as the harness reports
   * them. An unreadable projection returns `{}` rather than failing the read.
   */
  async sessionProjectionValues(request: {
    sessionId: string
  }): Promise<Record<string, unknown>> {
    await this.assertSessionVisible(request.sessionId, 'session projections feed')
    const values = await this.readProjectionValues(request.sessionId)
    if (values === undefined) return {}
    const picked: Record<string, unknown> = {}
    // `workingDirectory` and the forge record are the two the status/list surface
    // already reports; the plan/goal/todo projections are what a supervising client
    // wants to see change during a long session.
    for (const key of ['workingDirectory', 'goal', 'plan', 'todos', 'agentPreset'] as const) {
      if (values[key] !== undefined) picked[key] = values[key]
    }
    if (values['title'] !== undefined) picked['title'] = values['title']
    const worktree = worktreeInfoOf(values['forgeWorktree'])
    if (worktree !== undefined) picked['worktree'] = worktree
    return picked
  }

  /**
   * One session's live state, optionally held open until it changes.
   *
   * `waitMs` turns a poll into a long-poll: the call returns as soon as anything
   * observable changes (a new event, a turn opening or closing, the agent going
   * idle) or when the bound elapses, whichever comes first. That is the shape an
   * upstream supervisor wants: it never has to guess a poll interval, and a change
   * is reported at once instead of on the next tick. A session that stopped
   * producing events while running is what `stalled` and `idleMs` are for.
   */
  async sessionStatus(request: {
    sessionId: string
    waitMs?: number
    signal?: AbortSignal
  }): Promise<SessionStatus> {
    await this.assertSessionVisible(request.sessionId, 'session_status')
    const budget = Math.max(0, Math.min(request.waitMs ?? 0, STATUS_MAX_WAIT_MS))
    const startedAt = Date.now()
    let current = await this.readSessionStatus(request.sessionId)
    if (budget === 0) return current
    const signature = statusSignature(current)
    for (;;) {
      if (request.signal?.aborted === true) {
        return { ...current, changed: false, waitedMs: Date.now() - startedAt }
      }
      const remaining = budget - (Date.now() - startedAt)
      if (remaining <= 0) return { ...current, changed: false, waitedMs: Date.now() - startedAt }
      await waitForSessionActivity(
        this.ctx,
        request.sessionId,
        Math.min(remaining, TURN_POLL_INTERVAL_MS),
        request.signal,
      )
      current = await this.readSessionStatus(request.sessionId)
      if (statusSignature(current) !== signature) {
        return { ...current, changed: true, waitedMs: Date.now() - startedAt }
      }
    }
  }

  /** Read one status snapshot: the durable log plus the harness's own agent state. */
  private async readSessionStatus(sessionId: string): Promise<SessionStatus> {
    let events: readonly DshSessionEvent[] = []
    let logReadable = true
    try {
      events = await this.readEvents(sessionId)
    } catch {
      logReadable = false
    }
    let openTurn: number | null = null
    let openStep: number | null = null
    let lastTurn: SessionStatus['lastTurn'] = null
    for (const event of events) {
      if (event.type === 'turn/start') {
        openTurn = turnOf(event)
        openStep = null
        continue
      }
      if (event.type === 'step/start') {
        const step = (event.data as { step?: unknown } | undefined)?.step
        if (typeof step === 'number') openStep = step
        continue
      }
      if (event.type === 'step/end') {
        openStep = null
        continue
      }
      if (event.type === 'turn/end') {
        openTurn = null
        openStep = null
        lastTurn = {
          turn: turnOf(event) ?? 0,
          endedAt: isoOfEventTime(event.time),
          reason: (event.data as { reason?: unknown } | undefined)?.reason ?? null,
        }
      }
    }
    const newest = events.at(-1)
    const idleMs = newest === undefined ? null : Math.max(0, Date.now() - newest.time)
    const running = await this.liveRunning(sessionId)
    // Read after the log, from the projection snapshot the log computed: the two
    // describe different things (durable activity vs the directory the session
    // currently works in), and a profile that cannot report projections simply
    // omits both fields instead of failing a status read.
    const views = await this.readSessionViews(sessionId)
    return {
      sessionId,
      running,
      openTurn,
      openStep,
      lastEventSeq: newest?.seq ?? null,
      lastEventAt: newest === undefined ? null : isoOfEventTime(newest.time),
      idleMs,
      lastTurn,
      failure: lastTurn === null ? null : failureOfReason(lastTurn.reason) ?? null,
      stalled: running && idleMs !== null && idleMs >= STALL_MS,
      logReadable,
      waitedMs: 0,
      ...views,
    }
  }

  /**
   * Read the projection values reported beside a session's live state.
   *
   * Two rungs, cheapest first: `sessionController.projections` is cold-safe and
   * does not activate the session, so it is the preferred exact read; the
   * `sessionQuery.observeSession` lease is the fallback for a profile without that
   * controller method, and is disposed immediately because not releasing it pins
   * the prepared-session cache. Both fields are additive diagnostics: a profile
   * without either reader reports neither rather than failing the read that
   * actually mattered.
   */
  private async readSessionViews(sessionId: string): Promise<SessionViews> {
    const values = await this.readProjectionValues(sessionId)
    return values === undefined ? {} : viewsOfProjectionValues(values)
  }

  /**
   * The raw projection values of one session, from the cheapest available reader.
   *
   * `sessionController.projections` is cold-safe and does not activate the
   * session, so it is preferred; the `sessionQuery.observeSession` lease is the
   * fallback for a profile without that controller method, and is disposed
   * immediately because not releasing it pins the prepared-session cache. A
   * profile with neither reader, or a session whose projections cannot be
   * computed, answers `undefined` — every caller treats that as "not reported"
   * rather than failing the read that actually mattered.
   */
  private async readProjectionValues(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const controller = this.sessionController()
    const projections = controller?.projections
    if (typeof projections === 'function') {
      try {
        const value = await projections.call(
          controller as DshSessionController,
          { sessionId },
          new AbortController().signal,
        )
        return value?.values
      } catch (error) {
        this.log.debug(
          '[dsh-as-mcp] could not read the projections of session %s: %s',
          sessionId,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    const query = this.sessionQuery()
    const read = query?.observeSession
    if (typeof read !== 'function') return undefined
    let observation
    try {
      observation = await read.call(query, sessionId, { projectionMode: 'all' })
    } catch (error) {
      this.log.debug(
        '[dsh-as-mcp] could not observe session %s for its projections: %s',
        sessionId,
        error instanceof Error ? error.message : String(error),
      )
      return undefined
    }
    try {
      return observation.projections?.values
    } finally {
      observation[Symbol.dispose]?.()
    }
  }

  /** Whether a session has a turn open, from the cheapest source the profile has. */
  private async liveRunning(sessionId: string): Promise<boolean> {
    const agent = this.agentRegistry()?.get(sessionId)
    if (agent !== undefined) return agent.status === 'running'
    try {
      const listed = await this.requireSessionController().list({}, new AbortController().signal)
      return listed.items.some((item) => item.sessionId === sessionId && item.running)
    } catch {
      return false
    }
  }

  /**
   * Submit one user message and, by default, wait for its turn to settle.
   *
   * Turns on one session are serialized, so two concurrent MCP callers cannot
   * interleave prompts and then disagree about which reply belongs to which
   * request.
   *
   * Every reply carries usage, and this is the point of the feature: the caller
   * that spent the tokens is the caller that needs the tally, and it needs it
   * without a second round trip or a session-end hook the harness does not have.
   * The turn's own tokens ride `turn.usage`; the running session total and its
   * money ride `session`, whether or not the turn settled. When the usage read
   * itself fails, the reply says `usageUnavailable` with a reason — absence is
   * never left ambiguous.
   */
  async promptSession(request: {
    sessionId: string
    prompt: string
    /** Images to attach; read through the same filesystem seam as `file_read_image`. */
    images?: readonly PromptImageRequest[]
    /** How much of each tool call to return. Defaults to `summary`. */
    toolCalls?: ToolCallDetail
    /** Ceiling on each argument string in `full` mode. Defaults to 4000 characters. */
    maxArgumentChars?: number
    /**
     * Character cap on the agent's final reply. Absent means full text — the
     * historical default — because the reply is the answer the caller asked for.
     */
    maxReplyChars?: number
    /**
     * Retry-safe key for this message.
     *
     * The caller that sends a prompt and then times out cannot tell whether the
     * message was admitted. Retrying with the same key returns the existing turn
     * instead of asking the agent to do the work twice: the harness records our
     * request id on the committed user message, so a second call can find it.
     * Reusing a key with different content is refused rather than silently
     * ignored.
     */
    idempotencyKey?: string
    mode: 'queue' | 'steer'
    wait: boolean
    timeoutMs?: number
    signal?: AbortSignal
    /**
     * Called as the wait makes progress, for MCP progress notifications.
     *
     * Throttling and transport are the caller's business; this only reports what
     * the log says. A throwing callback is ignored, because a liveness ping must
     * never be able to fail the turn it is reporting on.
     */
    onProgress?: (progress: TurnProgress) => void
  }): Promise<{
    accepted: true
    turn?: TurnResult
    session?: SessionUsageEnvelope
    /** True when this call reused an earlier admission instead of sending again. */
    replayed?: true
    /** Present only when usage reporting is on and the read failed. */
    usageUnavailable?: true
    /** Why the usage read failed, when it did. */
    reason?: string
  }> {
    await this.assertSessionVisible(request.sessionId, 'session_prompt')
    return await this.enqueueTurn(request.sessionId, async () => {
      const controller = this.requireSessionController()
      // The cancellation generation this call's turn starts under. A cancel that
      // arrives after this point belongs to this call; one that arrived while the
      // call was still queued behind another turn does not.
      const cancelGeneration = this.cancelGenerations.get(request.sessionId) ?? 0
      // The harness records this id as `source.rpcId` on the committed user
      // message, which is how the wait below identifies *our* turn — and how an
      // idempotent retry finds the message an earlier call already admitted.
      const requestId = idempotencyRequestId(request.idempotencyKey)

      // A prompt is text plus any attached images. Both are optional alone but not
      // together: the harness rejects an empty message, and refusing it here says
      // why instead of surfacing its internal validation.
      const content: DshPromptPart[] = []
      if (request.prompt.trim() !== '') content.push({ type: 'text', text: request.prompt })
      for (const image of await this.readPromptImages(request.images ?? [])) content.push(image)
      if (content.length === 0) {
        throw new Error('a prompt needs non-empty text or at least one image')
      }

      // Idempotent retry: if a message with this key is already in the log, reuse
      // it. The turn may be settled or still running; either way the caller gets
      // the same answer it would have gotten, and the agent is not asked twice.
      // Only a caller-supplied key can repeat, so the common path avoids the read.
      let earlier = request.idempotencyKey === undefined
        ? undefined
        : findOwnPrompt(await this.readEvents(request.sessionId), requestId)
      if (earlier === undefined && request.idempotencyKey !== undefined) {
        const admitted = this.admittedPrompts.get(requestId)
        if (admitted !== undefined && admitted.sessionId === request.sessionId) {
          earlier = { text: admitted.text, images: admitted.images }
        }
      }
      if (earlier !== undefined) {
        const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n')
        const images = content.filter((part) => part.type === 'image').length
        if (earlier.text !== text || earlier.images !== images) {
          throw new Error(
            `idempotencyKey was reused for different content on this session (the earlier message was `
            + `${earlier.images} image(s) plus ${earlier.text.length} characters of text). Use a new key for a `
            + 'new message, or repeat the original content to retrieve its result.',
          )
        }
        this.log.debug(
          '[dsh-as-mcp] reusing the already-admitted prompt %s on session %s',
          requestId,
          request.sessionId,
        )
        return await this.finishPrompt(request, requestId, true, cancelGeneration)
      }

      await controller.prompt(
        {
          requestId,
          sessionId: request.sessionId,
          mode: request.mode,
          content,
        },
        request.signal ?? new AbortController().signal,
      )
      if (request.idempotencyKey !== undefined) {
        const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n')
        const images = content.filter((part) => part.type === 'image').length
        this.admittedPrompts.set(requestId, { sessionId: request.sessionId, text, images, at: Date.now() })
        // Bound the ledger: a long-lived process must not accumulate every key it
        // has ever seen. The log still answers older retries.
        if (this.admittedPrompts.size > 200) {
          const cutoff = Date.now() - 24 * 60 * 60 * 1_000
          for (const [key, entry] of this.admittedPrompts) {
            if (entry.at < cutoff || this.admittedPrompts.size > 200) this.admittedPrompts.delete(key)
            if (this.admittedPrompts.size <= 200) break
          }
        }
      }
      return await this.finishPrompt(request, requestId, false, cancelGeneration)
    })
  }

  /**
   * Wait out one already-admitted prompt and build its reply.
   *
   * Split out so an idempotent retry follows exactly the same path as the original
   * call: same wait loop, same progress reporting, same usage attachment — the only
   * difference is the `replayed` flag and that no prompt was sent.
   */
  private async finishPrompt(
    request: {
      sessionId: string
      mode: 'queue' | 'steer'
      wait: boolean
      timeoutMs?: number
      signal?: AbortSignal
      toolCalls?: ToolCallDetail
      maxArgumentChars?: number
      maxReplyChars?: number
      onProgress?: (progress: TurnProgress) => void
    },
    requestId: string,
    replayed: boolean,
    cancelGenerationAtStart: number,
  ): Promise<{
    accepted: true
    turn?: TurnResult
    session?: SessionUsageEnvelope
    replayed?: true
    usageUnavailable?: true
    reason?: string
  }> {
    const flag = replayed ? { replayed: true as const } : {}
    if (!request.wait) {
        // The caller asked not to wait, but a subscribed modern client can still be
        // told when the turn settles. Arming before the usage read keeps the window
        // between admission and the first log read as small as possible.
        this.watchSettlement(request, requestId, cancelGenerationAtStart)
        // No turn to report on a queued message, but the session's spend so far
        // is still a useful answer and costs one durable read.
        const read = this.config.tools.usage
          ? await this.readUsage(request.sessionId, { partial: true })
          : undefined
        if (read === undefined) return { accepted: true as const, ...flag }
        return read.ok
          ? { accepted: true as const, ...flag, session: read.envelope }
          : { accepted: true as const, ...flag, usageUnavailable: true as const, reason: read.reason }
      }

      const timeoutMs = request.timeoutMs ?? this.config.session.promptTimeoutMs
      const deadline = Date.now() + timeoutMs

      const startedAt = Date.now()
      // Set while a committed prompt's turn is open but its agent is idle; a turn
      // in that state is not slow, it is gone, and the caller should hear it.
      let vanishedSince: number | undefined
      for (;;) {
        let events: readonly DshSessionEvent[]
        try {
          events = await this.readEvents(request.sessionId)
        } catch (error) {
          // The wait outlives the log only if it is not told: report the condition
          // instead of surfacing a bare ENOENT after the caller's timeout.
          const reason = error instanceof Error ? error.message : String(error)
          this.log.warn('[dsh-as-mcp] session %s became unreadable while waiting: %s', request.sessionId, reason)
          return await this.settledReply(
            request.sessionId,
            emptyTurnSummary(),
            {
              timedOut: false,
              partial: true,
              failure: {
                kind: 'unreadable',
                message: `the session log became unreadable while waiting for the turn: ${reason}`,
              },
              ...flag,
              maxReplyChars: request.maxReplyChars,
            },
          )
        }
        const location = locateTurn(events, requestId, request.mode)
        reportProgress(request.onProgress, events, location, startedAt, location.settled)

        if (location.settled) {
          const summary = summarizeTurn(events, location)
          return await this.settledReply(
            request.sessionId,
            shapeToolCalls(summary, request.toolCalls ?? 'summary', request.maxArgumentChars),
            { timedOut: false, ...flag, maxReplyChars: request.maxReplyChars },
          )
        }

        if (request.signal?.aborted === true) {
          return await this.settledReply(
            request.sessionId,
            shapeToolCalls(summarizeTurn(events, location), request.toolCalls ?? 'summary', request.maxArgumentChars),
            { timedOut: false, aborted: true, partial: true, ...flag, maxReplyChars: request.maxReplyChars },
          )
        }

        // A cancel can stop the turn in the window before this prompt's
        // `user/message` is committed. The log then never shows a turn to settle
        // for us, so without this the wait would report `timedOut` minutes later
        // for a turn the caller had already cancelled. The generation is checked
        // after `settled` so an ordinary completion still wins a near-simultaneous
        // cancel.
        if ((this.cancelGenerations.get(request.sessionId) ?? 0) !== cancelGenerationAtStart) {
          return await this.settledReply(
            request.sessionId,
            shapeToolCalls(summarizeTurn(events, location), request.toolCalls ?? 'summary', request.maxArgumentChars),
            { timedOut: false, aborted: true, partial: true, ...flag, maxReplyChars: request.maxReplyChars },
          )
        }

        // A turn can stop without a `turn/end`: the agent is disposed, or the loop
        // that owned it dropped it. Waiting for the timeout would report a turn
        // that no longer exists as merely slow, so an open turn whose agent is
        // idle for longer than the grace period is reported as vanished.
        const liveAgent = this.agentRegistry()?.get(request.sessionId)
        if (location.owningTurn !== null && liveAgent !== undefined && liveAgent.status !== 'running') {
          vanishedSince ??= Date.now()
          if (Date.now() - vanishedSince >= VANISH_GRACE_MS) {
            return await this.settledReply(
              request.sessionId,
              shapeToolCalls(summarizeTurn(events, location), request.toolCalls ?? 'summary', request.maxArgumentChars),
              {
                timedOut: false,
                partial: true,
                failure: {
                  kind: 'vanished',
                  message: `turn ${location.owningTurn} stopped without a turn/end event: `
                    + `the session's agent has been idle for ${Math.round((Date.now() - vanishedSince) / 1_000)}s, `
                    + 'so the turn will never settle',
                },
                ...flag,
                maxReplyChars: request.maxReplyChars,
              },
            )
          }
        } else {
          vanishedSince = undefined
        }

        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          return await this.settledReply(
            request.sessionId,
            shapeToolCalls(summarizeTurn(events, location), request.toolCalls ?? 'summary', request.maxArgumentChars),
            { timedOut: true, partial: true, ...flag, maxReplyChars: request.maxReplyChars },
          )
        }

        // Wake on the next append for this session; the cap is a safety net, not
        // the cadence, so an idle wait costs one read per second at most.
        await waitForSessionActivity(
          this.ctx,
          request.sessionId,
          Math.min(TURN_POLL_INTERVAL_MS, remaining),
          request.signal,
        )
    }
  }

  /**
   * Watch one admitted fire-and-forget turn so its settlement can be pushed.
   *
   * `wait: false` returns as soon as the message is admitted, so a client has
   * nothing to observe — the reason `session_status` polling is documented. A
   * modern client that opened a `subscriptions/listen` stream naming this
   * session's turn resource is told instead: the watcher runs the same wait a
   * `wait: true` call would (no reply is built for anyone), then publishes one
   * `notifications/resources/updated`.
   *
   * Three deliberate bounds:
   * - armed only while a subscription stream is open ({@link TurnPushes.hasSubscribers}),
   *   so a fire-and-forget caller with no listener costs nothing;
   * - one watch per request id, so an idempotent retry does not double-publish;
   * - the same `timeoutMs`/`promptTimeoutMs` bound as a waiting call. A wait that
   *   timed out did not observe an ending, so it publishes nothing rather than
   *   claiming one; the client can poll or ask again.
   */
  private watchSettlement(
    request: {
      sessionId: string
      mode: 'queue' | 'steer'
      timeoutMs?: number
    },
    requestId: string,
    cancelGenerationAtStart: number,
  ): void {
    const pushes = this.pushes
    if (pushes === undefined || !pushes.hasSubscribers()) return
    if (this.settlementWatches.has(requestId)) return
    const controller = new AbortController()
    this.settlementWatches.set(requestId, controller)
    this.log.debug(
      '[dsh-as-mcp] watching session %s turn %s for a settlement push',
      request.sessionId,
      requestId,
    )
    void this.finishPrompt(
      {
        sessionId: request.sessionId,
        mode: request.mode,
        wait: true,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        toolCalls: 'none',
        signal: controller.signal,
      },
      requestId,
      false,
      cancelGenerationAtStart,
    ).then((settled) => {
      // An aborted controller means the endpoint is going away, not that the turn
      // ended; `timedOut` means this watch ran out of bound and never saw an end.
      if (controller.signal.aborted || settled.turn?.timedOut === true) return
      pushes.turnSettled(request.sessionId)
    }).catch((error: unknown) => {
      // A lost notification is not a failed turn: the client can still poll.
      this.log.warn(
        '[dsh-as-mcp] settlement watch for session %s failed: %s',
        request.sessionId,
        error instanceof Error ? error.message : String(error),
      )
    }).finally(() => {
      this.settlementWatches.delete(requestId)
    })
  }

  /**
   * Stop every settlement watch.
   *
   * Called when the endpoint is torn down (plugin unload, or the HTTP handler
   * closing): the watchers read the durable log, so leaving them running after
   * the transport is gone would spend reads for a notification nobody can get.
   */
  disposeSettlementWatches(): void {
    for (const controller of this.settlementWatches.values()) controller.abort()
    this.settlementWatches.clear()
  }

  /**
   * Attach usage to one prompt reply.
   *
   * Usage is read from a fresh cut rather than folded from the events the wait
   * loop happened to hold, because a fresh cut also carries the inherited-prefix
   * count and the harness's own projection, which is what makes the numbers
   * verifiable. A failed read is not allowed to fail the prompt: the work was
   * done and the reply is the answer, so the reply carries `usageUnavailable`
   * and the reason instead (logged at warn), and `session_usage` can be retried.
   */
  private async settledReply(
    sessionId: string,
    summary: Omit<TurnResult, 'timedOut' | 'usage'>,
    flags: {
      timedOut: boolean
      aborted?: boolean
      partial?: boolean
      replayed?: true
      /** A failure the wait itself observed; overrides the turn's own ending. */
      failure?: TurnFailure
      /** Character cap for the agent's reply, when the caller asked for one. */
      maxReplyChars?: number
    },
  ): Promise<{
    accepted: true
    turn: TurnResult
    session?: SessionUsageEnvelope
    usageUnavailable?: true
    reason?: string
  }> {
    const read = this.config.tools.usage
      ? await this.readUsage(sessionId, { partial: flags.partial === true })
      : undefined
    const usage = read?.ok === true ? usageOfTurn(read.report, summary.turn) : undefined
    const replyLimit = flags.maxReplyChars
    const replyTruncated = replyLimit !== undefined && summary.reply.length > replyLimit
    // An ending the wait observed itself wins: it knows something the log cannot
    // say (the log stopped being readable, or a turn stopped without an ending).
    const failure = flags.failure ?? failureOfReason(summary.turnEndReason)
    return {
      accepted: true,
      ...(flags.replayed === true ? { replayed: true as const } : {}),
      turn: {
        ...summary,
        reply: replyTruncated ? truncateText(summary.reply, replyLimit) : summary.reply,
        replyChars: summary.reply.length,
        ...(replyTruncated ? { replyTruncated: true as const } : {}),
        timedOut: flags.timedOut,
        ...(flags.aborted === true ? { aborted: true } : {}),
        ...(failure === undefined ? {} : { failure }),
        ...(usage === undefined ? {} : { usage }),
      },
      ...(read?.ok === true ? { session: read.envelope } : {}),
      ...(read?.ok === false ? { usageUnavailable: true as const, reason: read.reason } : {}),
    }
  }

  /**
   * The cumulative usage block for one session, or `undefined` when it cannot be
   * read at all.
   *
   * The report is kept beside the envelope for callers that need per-turn detail
   * (the prompt reply's own turn), while the envelope is the part a caller sees.
   */
  private async readUsage(
    sessionId: string,
    options: { partial?: boolean } = {},
  ): Promise<UsageRead> {
    try {
      const cut = await this.readUsageCut(sessionId)
      // A read taken while a turn is still running describes numbers that will
      // grow. The caller that asked mid-turn must know that; the settle path says
      // `partial` itself (timeout/cancel), so this only fills in the gap.
      const report = buildUsageReport(cut, { partial: options.partial ?? hasOpenTurn(cut.events) })
      const cost = await readSessionCost(this.ctx, sessionId)
      return {
        ok: true,
        envelope: { sessionId, usage: summarizeUsage(report), cost },
        report,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Logged at warn, not debug: a caller is about to be told "no usage", and
      // the operator should be able to see why without a repro.
      this.log.warn('[dsh-as-mcp] could not read usage for session %s: %s', sessionId, reason)
      return { ok: false, reason }
    }
  }

  /** Ask the live agent to cancel its current turn. */
  async cancelSession(sessionId: string): Promise<{ accepted: true }> {
    await this.assertSessionVisible(sessionId, 'session_cancel')
    // Bump before asking, so a wait that cannot anchor on a committed prompt sees
    // the cancel on its next wake even when the turn has already stopped and the
    // cancel call itself has nothing left to do.
    this.cancelGenerations.set(sessionId, (this.cancelGenerations.get(sessionId) ?? 0) + 1)
    return this.requireSessionController().cancel({ sessionId })
  }

  /**
   * The messages waiting in a session's inbox, with the ids queue mutations use.
   *
   * Queued messages are a *live* projection (`inbox["next-turn"]`), not durable
   * log events: an accepted-but-not-yet-run message has no event of its own, which
   * is why `session_messages` cannot show it and why this reads the projection.
   * Only a session this process holds can answer; a cold one reports a note rather
   * than an empty queue that would be indistinguishable from "nothing waiting".
   */
  async readQueue(sessionId: string): Promise<{
    queued: { id: string; text: string; source?: string; images: number }[]
    note?: string
  }> {
    await this.assertSessionVisible(sessionId, 'session_queue')
    const query = this.sessionQuery()
    if (query === undefined || typeof query.observeSession !== 'function') {
      return {
        queued: [],
        note: 'this DSH profile mounts no sessionQuery.observeSession(), so the pending queue cannot be read',
      }
    }
    const observation = await query.observeSession(sessionId, { projectionMode: 'all' })
    try {
      const values = observation.projections?.values as Record<string, unknown> | undefined
      const inbox = values?.['inbox'] as { 'next-turn'?: unknown } | undefined
      const rows = Array.isArray(inbox?.['next-turn']) ? (inbox['next-turn'] as unknown[]) : []
      const queued = rows.flatMap((row) => {
        const record = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>
        const id = typeof record['id'] === 'string' ? record['id'] : undefined
        if (id === undefined || id === '') return []
        const blocks = Array.isArray(record['content']) ? (record['content'] as unknown[]) : []
        const text = blocks
          .map((block) => {
            const part = (typeof block === 'object' && block !== null ? block : {}) as Record<string, unknown>
            return part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''
          })
          .join('')
        const images = blocks.filter((block) => {
          const part = (typeof block === 'object' && block !== null ? block : {}) as Record<string, unknown>
          return part['type'] === 'image'
        }).length
        const source = (record['source'] as { kind?: unknown } | undefined)?.kind
        return [{
          id,
          text,
          ...(typeof source === 'string' ? { source } : {}),
          images,
        }]
      })
      return { queued }
    } finally {
      // Release the prepared-observation lease, exactly as the usage read does.
      ;(observation as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.()
    }
  }

  /**
   * Edit, withdraw or steer one *pending* queued message.
   *
   * A caller that queued work with `wait: false` may need to retract it before it
   * runs — the difference between one more turn and none. The harness addresses a
   * pending message by its message id (from `session_messages`) and this is the
   * only surface that mutates the queue; cancellation cancels the running turn,
   * not the next one.
   */
  async updateQueue(request: {
    sessionId: string
    messageId: string
    action: 'remove' | 'edit' | 'steer'
    content?: string
  }): Promise<{ accepted: true; action: 'remove' | 'edit' | 'steer' }> {
    await this.assertSessionVisible(request.sessionId, 'session_queue')
    if (request.action === 'edit' && (request.content ?? '').trim() === '') {
      throw new Error('editing a queued message needs non-empty content')
    }
    const controller = this.requireSessionController()
    const update = (controller as {
      updateQueue?: (request: unknown) => Promise<{ accepted: true }>
    }).updateQueue
    if (typeof update !== 'function') {
      throw new Error(
        'this DSH profile provides no sessionController.updateQueue(), so a queued message cannot be edited or withdrawn',
      )
    }
    const action = request.action === 'edit'
      ? { kind: 'edit' as const, content: [{ type: 'text' as const, text: request.content ?? '' }] }
      : { kind: request.action }
    await update.call(controller, {
      sessionId: request.sessionId,
      itemId: request.messageId,
      action,
    })
    return { accepted: true, action: request.action }
  }

  /**
   * Search visible session content for a literal query.
   *
   * The harness bounds one search at 20 items and reports `hasMore`, so this
   * passes both through rather than pretending the list is complete. Sessions are
   * matched on their message content, not titles: a title search would miss the
   * case a caller usually has — "which conversation mentioned this token?" — and
   * the harness does not offer one.
   */
  async searchSessions(request: { query: string; limit?: number }): Promise<{
    items: readonly {
      sessionId: string
      snippet: string
      /** The workspace the match ran in, when the session listing is readable. */
      cwd?: string
      updatedAt?: number
      running?: boolean
      /** Present for a subagent session, so a search result shows its place in the tree. */
      parentSessionId?: string
      origin?: 'subagent'
    }[]
    hasMore: boolean
    /** Matches dropped because session.scope is "owned" and they were not ours. */
    hidden?: number
  }> {
    const query = request.query.trim()
    if (query === '') throw new Error('a search query must not be empty')
    const controller = this.requireSessionController()
    const search = (controller as { search?: unknown }).search
    if (typeof search !== 'function') {
      throw new Error(
        'this DSH profile provides no sessionController.search(), so sessions cannot be searched. '
          + 'The @deepseek-ai/dsh-api-session-controller package provides it, and it needs sessionQuery.',
      )
    }
    let result: { items: readonly { sessionId: string; snippet: string }[]; hasMore: boolean }
    try {
      result = await (search as (
        request: { query: string },
        signal: AbortSignal,
      ) => Promise<{ items: readonly { sessionId: string; snippet: string }[]; hasMore: boolean }>).call(
        controller,
        { query },
        new AbortController().signal,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Shipped compositions configure the session-query index with `openAt:
      // "never"`, which turns full-text search off while leaving every exact read
      // working. The harness message names the code but not the fix, so add it.
      if (/SESSION_QUERY_SEARCH_DISABLED|search is disabled/i.test(message)) {
        throw new Error(
          'session search is disabled in this deployment: the session-query index is configured with '
            + 'openAt "never". Set the `session-query-sqlite` row\'s openAt to "startup" or "first-search" '
            + 'in the profile patch (search is opt-in in shipped compositions), or use session_list and '
            + 'session_messages instead. '
            + `(${message})`,
        )
      }
      throw error
    }
    // A caller's own cap is applied on top of the harness bound; when it actually
    // cut something, `hasMore` says so even if the harness said false.
    const limit = request.limit === undefined ? undefined : Math.max(1, request.limit)
    const items = limit === undefined ? result.items : result.items.slice(0, limit)

    // A snippet alone does not tell a caller which workspace or how recent the
    // match is, and one listing is enough to answer both. A listing failure is
    // not a search failure: the matches are still valid without this context.
    let summaries: readonly DshSessionSummary[] | undefined
    try {
      summaries = await this.sessionSummaries()
    } catch {
      summaries = undefined
    }
    const byId = new Map((summaries ?? []).map((summary) => [summary.sessionId, summary]))
    // `session.scope: "owned"` filters matches rather than failing the search: the
    // caller still learns what it may see, and `hidden` says matches were removed.
    const allowed = this.ownedTree(summaries)
    const visible = items.filter((item) => allowed === undefined || allowed.has(item.sessionId))
    const hidden = items.length - visible.length
    return {
      items: visible.map((item) => {
        const summary = byId.get(item.sessionId)
        return {
          sessionId: item.sessionId,
          snippet: item.snippet,
          ...(summary?.cwd === undefined ? {} : { cwd: summary.cwd }),
          ...(summary?.updatedAt === undefined ? {} : { updatedAt: summary.updatedAt }),
          ...(summary?.running === undefined ? {} : { running: summary.running }),
          ...(summary?.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId }),
          ...(summary?.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        }
      }),
      hasMore: limit !== undefined && result.items.length > limit ? true : result.hasMore,
      ...(hidden === 0 ? {} : { hidden }),
    }
  }

  /**
   * Whether session search actually works in this deployment, not merely whether
   * the controller exposes it.
   *
   * `sessionController.search` can exist while the session-query index is
   * configured with `openAt: "never"`, which turns the capability off without
   * removing the method. A probe settles it: a random token matches nothing, so a
   * success means the index opened and answered. It is opt-in at the tool level
   * because the first search may open (and reconcile) the index.
   */
  async probeSessionSearch(): Promise<{ available: boolean; matches?: number; reason?: string }> {
    try {
      const result = await this.searchSessions({
        query: `dshasmcpprobe${randomUUID().replace(/-/g, '')}`,
        limit: 1,
      })
      return { available: true, matches: result.items.length }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Branch one live session into a child at an exact event boundary.
   *
   * The child inherits the source's event prefix, so the conversation it continues
   * from costs nothing to re-establish: no re-priming turn, no replay of the
   * source's tokens. That is what makes "try the same task twice from this point"
   * affordable, and it is why usage reporting separates the inherited prefix from
   * the child's own spend.
   *
   * The controller's fork is cold-readable: the source may be a live session or one
   * restored from the corpus, and an omitted boundary selects the latest completed
   * turn. The store's own `fork` is deliberately not used — it copies the prefix
   * but leaves the child unknown to the controller's persistence path, so its first
   * prompt fails with `SessionPersistenceNotFoundError`.
   *
   * @param request.sessionId - live source session.
   * @param request.atSeq - inclusive event seq to fork through; omitted means the
   *   source's current last event.
   * @param request.childSessionId - optional explicit child id.
   */
  async forkSession(request: {
    sessionId: string
    atSeq?: number
    /** Fork through the end of this turn instead of naming a raw event seq. */
    atTurn?: number
  }): Promise<{
    sessionId: string
    parentSessionId: string
    inheritedEventCount: number
    /** The event seq the fork actually cut at, when the caller named a turn. */
    atSeq?: number
    atTurn?: number
    cwd?: string
    approvalPolicy?: 'never'
    approvalPolicyError?: string
  }> {
    await this.assertSessionVisible(request.sessionId, 'session_fork')
    if (request.atSeq !== undefined && request.atTurn !== undefined) {
      throw new Error('pass atSeq or atTurn, not both: a turn boundary and a raw seq are two ways to say one cut')
    }
    let atSeq = request.atSeq
    if (request.atTurn !== undefined) {
      // A turn number is the unit a caller bills and reasons in, so let it name the
      // cut: fork through the last event attributed to that turn.
      const events = await this.readEvents(request.sessionId)
      const turns = new Set<number>()
      let boundary: number | undefined
      for (const event of events) {
        const turn = (event.data as { turn?: unknown } | undefined)?.turn
        if (typeof turn !== 'number') continue
        turns.add(turn)
        if (turn === request.atTurn) boundary = event.seq
      }
      if (boundary === undefined) {
        throw new Error(
          `turn ${request.atTurn} is not in session ${request.sessionId}'s log; `
            + `the turns it records are: ${turns.size === 0 ? 'none' : [...turns].sort((a, b) => a - b).join(', ')}.`,
        )
      }
      atSeq = boundary
    }
    const controller = this.requireSessionController()
    const fork = (controller as { fork?: (request: { sessionId: string; atSeq?: number }) => Promise<{ sessionId: string }> }).fork
    if (typeof fork !== 'function') {
      throw new Error(
        'this harness exposes no sessionController.fork(); only session_create is available for new sessions',
      )
    }
    // The controller's fork, not the store's: the store can copy the prefix, but a
    // session created that way is unknown to the controller's persistence path and
    // its first prompt fails with `SessionPersistenceNotFoundError`. The
    // controller's fork persists the child, so it can be prompted like any other.
    const child = await fork.call(controller, {
      sessionId: request.sessionId,
      ...(atSeq === undefined ? {} : { atSeq }),
    })
    this.rememberOwnedSession(child.sessionId)
    // The child is driven by this endpoint too, so it gets the same policy ask.
    const approval = await this.applyApprovalPolicy(child.sessionId)

    // Report the fork's own cut, so the caller can tell how much history came for
    // free. A read failure is not worth failing the fork: the session exists.
    let inheritedEventCount = 0
    let cwd: string | undefined
    try {
      const cut = await this.readUsageCut(child.sessionId)
      inheritedEventCount = cut.inheritedEventCount
      cwd = cut.cwd
    } catch (error) {
      this.log.debug(
        '[dsh-as-mcp] could not read the fork cut of %s: %s',
        child.sessionId,
        error instanceof Error ? error.message : String(error),
      )
    }
    return {
      sessionId: child.sessionId,
      parentSessionId: request.sessionId,
      inheritedEventCount,
      ...(atSeq === undefined || request.atTurn === undefined ? {} : { atSeq, atTurn: request.atTurn }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(approval.approvalPolicy === undefined ? {} : { approvalPolicy: approval.approvalPolicy }),
      ...(approval.approvalPolicyError === undefined ? {} : { approvalPolicyError: approval.approvalPolicyError }),
    }
  }

  /**
   * Set an explicit user title on one session.
   *
   * A title a caller sets is owned by the user in the harness's terms, which also
   * stops automatic title generation for that session — so the name an external
   * harness gives a task stays the name a human sees in the DSH UI. The controller
   * resolves the session first, so a persisted session can be renamed too — unless
   * another DSH process currently holds its write handle, in which case the harness
   * refuses and its message is passed through.
   */
  async renameSession(request: { sessionId: string; title: string }): Promise<{
    sessionId: string
    title: string
    seq: number
  }> {
    await this.assertSessionVisible(request.sessionId, 'session_rename')
    const controller = this.requireSessionController()
    const rename = (controller as {
      rename?: (input: { sessionId: string; title: string }) => Promise<{ title: string; seq: number }>
    }).rename
    if (typeof rename !== 'function') {
      throw new Error('this harness exposes no sessionController.rename(); the session title cannot be set')
    }
    const accepted = await rename.call(controller, { sessionId: request.sessionId, title: request.title })
    return { sessionId: request.sessionId, title: accepted.title, seq: accepted.seq }
  }

  /**
   * The caller-facing transcript of one session.
   *
   * A caller that is polling for new work — the other half of a long
   * `session_prompt` — should pass `sinceSeq` with the last `seq` it saw rather
   * than re-reading the whole transcript every time; the filter is applied before
   * the tail limit, so a burst of new messages is not cut off by old ones.
   *
   * @param sessionId - the session to read.
   * @param limit - how many of the newest matching messages to return.
   * @param options.sinceSeq - only messages with a larger `seq`.
   * @param options.role - only one side of the conversation.
   */
  async readTranscript(
    sessionId: string,
    limit: number,
    options: {
      sinceSeq?: number
      /**
       * Page backwards: only messages with a smaller seq than this. The tail of
       * that sub-window is returned, so a caller pages by passing the oldest seq
       * it already has, without a server-side cursor.
       */
      beforeSeq?: number
      role?: 'user' | 'assistant'
      /**
       * Fold each assistant message's `tool-call` blocks into `toolCalls`
       * (`name`, call id, argument JSON length). Off by default: a transcript read
       * that only needs prose should not grow by every invocation in the session.
       */
      includeToolCalls?: boolean
      /**
       * Also include `tool/result` events as `role: "tool"` rows, capped like
       * messages. `'errors'` keeps only the results the harness marked as failures,
       * which is the quickest way to find why a turn went wrong.
       */
      includeToolResults?: boolean | 'errors'
      /** Only rows the log attributes to this turn; the prompt row has no turn and is filtered out. */
      turn?: number
      /** Only rows attributed to turns at or after this one, for a phase of the transcript. */
      fromTurn?: number
      /** Only rows attributed to turns at or before this one. */
      toTurn?: number
      /** Per-message character cap; absent means full text (the historical default). */
      maxCharsPerMessage?: number
    } = {},
  ): Promise<{ messages: TranscriptMessage[]; total: number }> {
    await this.assertSessionVisible(sessionId, 'session_messages')
    const events = await this.readEvents(sessionId)
    // One pass for results, so each requested tool call can say how large its
    // outcome was without a per-call lookup in the message loop.
    const toolResults = options.includeToolCalls === true ? toolResultsOfEvents(events) : new Map()
    const messages: TranscriptMessage[] = []
    for (const event of events) {
      let role: 'user' | 'assistant' | 'tool' | undefined = event.type === 'user/message'
        ? 'user'
        : event.type === 'assistant/message' ? 'assistant' : undefined
      if (role === undefined) {
        // A tool result is part of the timeline a poller wants to reconstruct, but
        // its text can be as large as a file; it is opt-in and capped like any other
        // message instead of being folded into the assistant row.
        if (event.type === 'tool/result' && options.includeToolResults !== undefined && options.includeToolResults !== false) role = 'tool' as const
        else continue
      }
      // The message id is what queue mutations address (`SessionUpdateQueue`), so
      // a caller that queued work can withdraw or redirect it later.
      const messageId = role === 'user'
        ? (event.data as { id?: unknown } | undefined)?.id
        : (event.data as { message?: { id?: unknown } } | undefined)?.message?.id
      const requestId = role === 'user'
        ? (event.data as { source?: { rpcId?: unknown } } | undefined)?.source?.rpcId
        : undefined
      if (options.role !== undefined && options.role !== role) continue
      if (options.sinceSeq !== undefined && event.seq <= options.sinceSeq) continue
      if (options.beforeSeq !== undefined && event.seq >= options.beforeSeq) continue
      const data = event.data as { turn?: unknown; step?: unknown } | undefined
      const turn = typeof data?.turn === 'number' ? data.turn : undefined
      const step = typeof data?.step === 'number' ? data.step : undefined
      if (options.turn !== undefined && turn !== options.turn) continue
      if (options.fromTurn !== undefined && (turn === undefined || turn < options.fromTurn)) continue
      if (options.toTurn !== undefined && (turn === undefined || turn > options.toTurn)) continue
      const rawBlocks = role === 'user'
        ? (event.data as { content?: unknown } | undefined)?.content
        : (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
      const callId = role === 'tool'
        ? (event.data as { message?: { toolCallId?: unknown } } | undefined)?.message?.toolCallId
        : undefined
      const toolError = role === 'tool'
        ? (event.data as { message?: { isError?: unknown } } | undefined)?.message?.isError === true
        : false
      if (role === 'tool' && options.includeToolResults === 'errors' && !toolError) continue
      const text = textOfBlocks(rawBlocks)
      const toolCalls = options.includeToolCalls === true && role === 'assistant'
        ? toolCallsOfBlocks(rawBlocks, toolResults)
        : []
      // A model message that only requests tools has no text. It is skipped by
      // default (a prose transcript), but when the caller asked for tool calls it
      // *is* the message — dropping it was why a polling caller saw none.
      if (text.trim() === '' && toolCalls.length === 0 && role !== 'tool') continue
      const cap = options.maxCharsPerMessage
      const truncated = cap !== undefined && text.length > cap
      messages.push({
        role,
        ...(typeof messageId === 'string' && messageId !== '' ? { id: messageId } : {}),
        ...(typeof requestId === 'string' && requestId !== '' ? { requestId } : {}),
        ...(typeof callId === 'string' && callId !== '' ? { callId } : {}),
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        ...(toolError ? { error: true as const } : {}),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
        text: truncated ? truncateText(text, cap) : text,
        time: event.time,
        seq: event.seq,
        chars: text.length,
        ...(truncated ? { truncated: true } : {}),
      })
    }
    // `total` counts what the filters matched, not what the tail returned: the
    // tail semantic is deliberate (a poll wants the newest), but a caller must be
    // able to tell that older messages exist beyond the window.
    return { messages: messages.slice(-limit), total: messages.length }
  }

  /**
   * The recorded textual result of one tool call, by call id.
   *
   * `session_messages { includeToolCalls }` reports how large a result was and
   * whether it failed; a caller debugging the failure wants the text itself, and
   * re-reading the whole transcript to find it is the expensive way. The id comes
   * from that transcript, so this is a targeted follow-up, not a second search.
   */
  async readToolResult(request: {
    sessionId: string
    /** Exact call id from `session_messages { includeToolCalls }`. */
    callId?: string
    /**
     * Or: the most recent completed call of this tool name. A caller watching a
     * session often knows "the last bash result is what I need" without tracking
     * ids; the reply names the resolved call id either way.
     */
    toolName?: string
    maxChars: number
    /** Which end to keep when the result is longer than `maxChars`; default `start`. */
    from?: 'start' | 'end'
  }): Promise<{
    sessionId: string
    callId: string
    name?: string
    chars: number
    text: string
    /** Echoed when the caller asked for the tail rather than the head. */
    from?: 'end'
    truncated?: true
    error?: true
  }> {
    if ((request.callId === undefined) === (request.toolName === undefined)) {
      throw new Error('pass either callId or toolName, not both and not neither')
    }
    await this.assertSessionVisible(request.sessionId, 'session_tool_result')
    const events = await this.readEvents(request.sessionId)
    // The call's name lives on the assistant message that requested it; the result
    // only carries the id. One pass collects both, in log order, so a name lookup
    // naturally ends on the most recent call.
    const nameById = new Map<string, string>()
    const order: string[] = []
    const results = new Map<string, { chars: number; text: string; error: boolean }>()
    for (const event of events) {
      if (event.type === 'assistant/message') {
        const blocks = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
        for (const call of toolCallsOfBlocks(blocks)) {
          if (call.id === undefined) continue
          nameById.set(call.id, call.name)
          order.push(call.id)
        }
        continue
      }
      if (event.type !== 'tool/result') continue
      const message = (event.data as { message?: Record<string, unknown> } | undefined)?.message
      const callId = message?.['toolCallId']
      if (typeof callId !== 'string' || callId === '') continue
      const text = textOfBlocks(message?.['content'])
      results.set(callId, { chars: text.length, text, error: message?.['isError'] === true })
    }

    let callId = request.callId
    if (callId === undefined) {
      // Most recent id in log order whose name matches and which already answered.
      for (let index = order.length - 1; index >= 0; index -= 1) {
        const candidate = order[index] as string
        if (nameById.get(candidate) !== request.toolName) continue
        if (!results.has(candidate)) continue
        callId = candidate
        break
      }
      if (callId === undefined) {
        const known = [...new Set([...nameById.values()])]
        throw new Error(
          `no recorded result of a tool named "${request.toolName}" in session ${request.sessionId}. `
            + `Tools with recorded calls: ${known.length === 0 ? 'none' : known.join(', ')}.`,
        )
      }
    }

    const found = results.get(callId)
    if (found === undefined) {
      throw new Error(
        `no recorded result for tool call "${callId}" in session ${request.sessionId}: the call id is unknown, or `
          + 'the tool has not answered yet. Take the id from session_messages { includeToolCalls: true }.',
      )
    }
    const name = nameById.get(callId)
    const from = request.from ?? 'start'
    const capped = found.text.length <= request.maxChars
      ? found.text
      : from === 'end' ? tailText(found.text, request.maxChars) : truncateText(found.text, request.maxChars)
    return {
      sessionId: request.sessionId,
      callId,
      ...(name === undefined ? {} : { name }),
      chars: found.chars,
      text: capped,
      ...(request.from === 'end' ? { from: 'end' as const } : {}),
      ...(capped.length < found.text.length ? { truncated: true as const } : {}),
      ...(found.error ? { error: true as const } : {}),
    }
  }

  /**
   * The durable session log.
   *
   * `sessionQuery` is the purpose-built whole-log reader. Two controller fallbacks
   * cover compositions that mount the controller without it: ≤0.1.7's
   * `inspect(sessionId)` returns the events directly, and 0.2.2 removed that
   * method in favour of `events(request, signal)`, whose message-aligned page is
   * flattened here (a page is enough for "what is open now", which is what the
   * callers of this method need). A composition with neither gets an explicit
   * capability error instead of a `TypeError` for a method that no longer exists.
   */
  private async readEvents(sessionId: string): Promise<readonly DshSessionEvent[]> {
    const query = this.sessionQuery()
    if (query !== undefined) {
      const snapshot = await query.readSession(sessionId)
      return snapshot.events
    }
    const controller = this.requireSessionController()
    const inspect = controller.inspect
    if (typeof inspect === 'function') {
      const inspected = await inspect.call(controller, sessionId)
      return inspected.events
    }
    const events = controller.events
    if (typeof events === 'function') {
      const page = await events.call(
        controller,
        { address: { kind: 'session', sessionId } },
        new AbortController().signal,
      )
      return (page.records ?? [])
        .filter((record) => record.type === 'event' && record.event !== undefined)
        .map((record) => record.event as DshSessionEvent)
    }
    throw new DshCapabilityError(
      'sessionQuery',
      'this DSH profile provides no session log reader: sessionQuery is absent and this harness no longer '
        + 'exposes sessionController.inspect() (removed in DSH 0.2.2). The @deepseek-ai/dsh-web-app bundle '
        + 'provides sessionQuery.',
    )
  }

  // ---------------------------------------------------------------------------
  // Usage
  // ---------------------------------------------------------------------------

  /**
   * Read one session's usage inputs from the best available source.
   *
   * Three rungs, in order of what they can answer:
   *
   * 1. `sessionQuery.observeSession` — the live-or-persisted read that also
   *    returns the harness's own `tokenUsage` projection, which
   *    {@link buildUsageReport} uses to verify the fold. The returned lease is
   *    disposed here, in a `finally`, because not releasing it pins the
   *    prepared-session cache.
   * 2. `sessionQuery.readSession` — the same events for a harness without
   *    `observeSession`, and the same inherited-prefix count, but no projection.
   * 3. `sessionController.inspect` — the older controller path, for a
   *    composition that mounts the controller without the query service on
   *    versions before DSH 0.2.2 (which removed `inspect`; its `events` page is
   *    deliberately not used here, because a bounded page would under-count).
   *
   * The log is authoritative; the projection is a cross-check. That ordering is
   * deliberate: the fold decomposes per turn and per model, and a projection that
   * disagreed with the events it was computed from would be the surprising case.
   *
   * A rung that *fails* degrades to the next one, exactly like a rung that is
   * absent: these are three ways of reading the same durable log, and a stricter
   * or broken reader on the preferred rung is not a reason to report no usage at
   * all. Only when every rung fails is the last error surfaced, so the caller
   * still learns what actually went wrong.
   */
  private async readUsageCut(sessionId: string): Promise<UsageCut> {
    const query = this.sessionQuery()
    const failures: unknown[] = []

    if (query !== undefined && typeof query.observeSession === 'function') {
      try {
        const observation = await query.observeSession(sessionId, { projectionMode: 'all' })
        try {
          const projection = observation.projections?.values?.['tokenUsage']
          return {
            sessionId,
            events: observation.events,
            inheritedEventCount: observation.inheritedEventCount ?? 0,
            ...(observation.header.cwd === undefined ? {} : { cwd: observation.header.cwd }),
            ...(projection === undefined ? {} : { projection }),
          }
        } finally {
          // `SessionObservation` is a `Disposable` lease; releasing it is what
          // returns a prepared observation to its cache instead of pinning it.
          observation[Symbol.dispose]?.()
        }
      } catch (error) {
        // Degrade, do not propagate. `observeSession` is the preferred rung, not
        // the only one: on a harness whose observation reader is broken or
        // stricter than its plain log reader (a pruned or partially restored
        // session is the real case), the older readers still answer. The failure
        // is remembered so that if every rung fails the caller sees one of the
        // real errors rather than only the last one's context-free message.
        failures.push(error)
        this.log.debug(
          '[dsh-as-mcp] could not observe session %s for usage, falling back to its log: %s',
          sessionId,
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    if (query !== undefined) {
      try {
        const snapshot = await query.readSession(sessionId)
        return {
          sessionId,
          events: snapshot.events,
          inheritedEventCount: snapshot.inheritedEventCount ?? 0,
          ...(snapshot.session.cwd === undefined ? {} : { cwd: snapshot.session.cwd }),
        }
      } catch (error) {
        failures.push(error)
      }
    }

    const controller = this.sessionController()
    const inspect = controller?.inspect
    if (controller !== undefined && typeof inspect === 'function') {
      try {
        const inspected = await inspect.call(controller, sessionId)
        return {
          sessionId,
          events: inspected.events,
          inheritedEventCount: inspected.inheritedEventCount ?? 0,
          ...(inspected.meta.cwd === undefined ? {} : { cwd: inspected.meta.cwd }),
        }
      } catch (error) {
        failures.push(error)
      }
    }

    if (failures.length > 0) throw failures[failures.length - 1]
    throw new DshCapabilityError(
      'sessionQuery',
      'this DSH profile provides no session log reader, so token usage cannot be read for any session. '
        + 'sessionQuery is absent and sessionController.inspect() was removed in DSH 0.2.2; its replacement, '
        + 'sessionController.events(), serves one bounded history page, which would silently under-count '
        + 'tokens. The @deepseek-ai/dsh-web-app bundle provides sessionQuery.',
    )
  }

  /** Every session this instance knows about, or `undefined` without a controller. */
  private async sessionSummaries(): Promise<readonly DshSessionSummary[] | undefined> {
    const controller = this.sessionController()
    if (controller === undefined) return undefined
    const listed = await controller.list({}, new AbortController().signal)
    return listed.items
  }

  /**
   * Usage for one session, its subagents, or every session this endpoint knows.
   *
   * This is the explicit receipt a caller asks for after its last prompt — DSH
   * has no "session ended" event, and none is needed when the caller can ask.
   * Every row is read independently, so one unreadable (pruned, corrupt) session
   * degrades to an `error` row instead of failing the whole report. The same is
   * true of the session *listing* used to find subagents: a host that cannot
   * enumerate sessions yields a note, not a failed report.
   *
   * Work is bounded: one session listing per call (not one per row), a hard cap
   * on rows, and at most {@link MAX_SUBAGENT_SESSIONS} children per target. A
   * report is a diagnostic for a caller that just finished a task, not a
   * substitute for a billing export, and it must not become an unbounded scan of
   * every durable log on the machine.
   */
  async sessionUsage(request: {
    sessionId?: string
    /** Several ids in one receipt; mutually exclusive with `sessionId` and `all`. */
    sessionIds?: readonly string[]
    /**
     * Total every session that ran in this workspace directory.
     *
     * Mutually exclusive with the id selectors: it is a scan, so it needs the
     * session listing and says so when that service is absent.
     */
    cwd?: string
    all?: boolean
    includeSubagents?: boolean
    includeTurns?: boolean
    /** Read money from cost-meter; false skips the ledger on a large scan. */
    includeCost?: boolean
    /** Fold each row from this seq onward, for a segment of a long session. */
    sinceSeq?: number
    /** Fold only the turns in this inclusive range (billing by task phase). */
    fromTurn?: number
    toTurn?: number
    limit: number
  }): Promise<SessionUsageReport> {
    const includeSubagents = request.includeSubagents ?? true
    const includeTurns = request.includeTurns ?? false
    const includeCost = request.includeCost ?? true
    if (request.fromTurn !== undefined && request.toTurn !== undefined && request.fromTurn > request.toTurn) {
      throw new Error(
        `fromTurn (${request.fromTurn}) is greater than toTurn (${request.toTurn}); a turn range is inclusive and `
          + 'needs an empty or ascending interval',
      )
    }
    const notes: string[] = []
    const rows: SessionUsageRow[] = []
    let hiddenSessions = 0
    let scope: SessionUsageReport['scope']
    let truncatedSubagents = false
    let truncatedRows = false

    // One listing for the whole call: the subagent walk and the unscoped scopes
    // all need it, and re-listing per session turned a 20-session report into 20
    // full corpus reads. A failure here is data for a note, not the report's
    // fate — a session-scoped receipt can still be produced from ids alone.
    let summaries: readonly DshSessionSummary[] | undefined
    let summariesError: string | undefined
    try {
      summaries = await this.sessionSummaries()
    } catch (error) {
      summariesError = error instanceof Error ? error.message : String(error)
    }
    const childrenOf = summaries === undefined ? undefined : this.subagentIndex(summaries)
    // The visible set is resolved once per call: owned sessions plus their
    // subagent descendants. `undefined` means scope all.
    const allowed = this.ownedTree(summaries)

    /** Append a row once; the last rows beyond the cap set `truncatedRows`. */
    const addRow = async (
      sessionId: string,
      origin: 'self' | 'subagent',
      parentSessionId?: string,
    ): Promise<void> => {
      if (allowed !== undefined && !allowed.has(sessionId)) {
        hiddenSessions += 1
        return
      }
      if (rows.some((row) => row.sessionId === sessionId)) return
      if (rows.length >= MAX_USAGE_ROWS) {
        truncatedRows = true
        return
      }
      rows.push(await this.usageRow(
        sessionId,
        origin,
        includeTurns,
        parentSessionId,
        includeCost,
        request.sinceSeq,
        request.fromTurn,
        request.toTurn,
      ))
    }

    if (request.sessionIds !== undefined && request.sessionIds.length > 0) {
      if (request.sessionId !== undefined || request.all === true) {
        throw new Error('pass sessionIds, sessionId, or all — not more than one of them')
      }
      scope = 'sessionIds'
      // Duplicates would double-count a row's tokens in the totals, and a caller
      // assembling ids from logs routinely repeats one.
      for (const id of request.sessionIds) await this.assertSessionVisible(id, 'session_usage')
      const ids = [...new Set(request.sessionIds)]
      if (ids.length > MAX_USAGE_ROWS) {
        truncatedRows = true
        notes.push(
          `Only the first ${MAX_USAGE_ROWS} of ${ids.length} session ids were read; the totals cover those.`,
        )
      }
      for (const sessionId of ids.slice(0, MAX_USAGE_ROWS)) {
        await addRow(sessionId, 'self')
        if (!includeSubagents) continue
        const children = childrenOf === undefined
          ? undefined
          : this.subagentsOf(childrenOf, sessionId)
        if (children === undefined) {
          notes.push(
            'This DSH profile could not list sessions, so subagent sessions could not be enumerated; '
              + 'the totals cover the ids themselves.',
          )
          continue
        }
        truncatedSubagents = truncatedSubagents || children.truncated
        for (const child of children.items) {
          await addRow(child.sessionId, 'subagent', child.parentSessionId)
        }
      }
    } else if (request.cwd !== undefined) {
      if (request.sessionId !== undefined || request.sessionIds !== undefined || request.all === true) {
        throw new Error('pass cwd, sessionId, sessionIds, or all — not more than one of them')
      }
      if (summaries === undefined) {
        throw new DshCapabilityError(
          'sessionController',
          'totalling a workspace needs the session listing, which this DSH profile cannot provide: '
            + (summariesError ?? 'no sessionController service')
            + '. Pass sessionId or sessionIds to read known sessions instead.',
        )
      }
      scope = 'workspace'
      const canonical = await this.canonicalFilterPath(request.cwd)
      // Subagent rows are included as their own rows (they ran in the same
      // directory), and `includeSubagents: false` removes them like every other
      // scope does.
      const matched = summaries
        .filter((entry) => entry.cwd === canonical && (includeSubagents || entry.origin !== 'subagent'))
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
      for (const entry of matched.slice(0, request.limit)) {
        await addRow(
          entry.sessionId,
          entry.origin === 'subagent' ? 'subagent' : 'self',
          entry.parentSessionId,
        )
      }
      if (matched.length > request.limit) {
        notes.push(
          `Only the ${request.limit} most recently updated session(s) in ${canonical} were scanned; raise limit to cover more.`,
        )
      }
      if (matched.length === 0) {
        notes.push(`No session this DSH knows ran in ${canonical}.`)
      }
    } else if (request.sessionId !== undefined) {
      scope = 'session'
      await this.assertSessionVisible(request.sessionId, 'session_usage')
      await addRow(request.sessionId, 'self')
      // Children are enumerated even when they are excluded, so the report can
      // say that they exist and were left out instead of silently reporting a
      // total that a reader would take as the whole task's cost.
      const children = childrenOf === undefined
        ? undefined
        : this.subagentsOf(childrenOf, request.sessionId)
      if (children === undefined) {
        if (includeSubagents) {
          notes.push(
            'This DSH profile could not list sessions, so subagent sessions could not be enumerated; '
              + `the totals cover only ${request.sessionId} itself.`
              + (summariesError === undefined ? '' : ` (${summariesError})`),
          )
        }
      } else if (includeSubagents) {
        truncatedSubagents = children.truncated
        for (const child of children.items) {
          await addRow(child.sessionId, 'subagent', child.parentSessionId)
        }
      } else if (children.items.length > 0) {
        notes.push(
          `${children.items.length}${children.truncated ? '+' : ''} subagent session(s) were excluded because `
            + 'includeSubagents is false; their tokens were billed to the same account.',
        )
      }
    } else {
      if (summaries === undefined && request.all === true) {
        // Only the unscoped scan actually needs the listing. A session-scoped
        // receipt reads by id and already degraded above.
        throw new DshCapabilityError(
          'sessionController',
          summariesError !== undefined
            ? `this DSH instance could not list sessions, so all: true cannot be served: ${summariesError}. `
              + 'Pass a sessionId to read one session\'s usage instead.'
            : 'this DSH profile provides no sessionController service, so sessions cannot be listed. '
              + 'Pass a sessionId to read one session\'s usage instead.',
        )
      }
      if (summaries === undefined) {
        // pluginSessions needs only the ids this process created, which it keeps
        // itself; say that subagents could not be walked rather than failing a
        // receipt the caller can still use.
        notes.push(
          'This DSH profile could not list sessions, so only the sessions this endpoint created '
            + 'are reported and subagent sessions could not be enumerated.'
            + (summariesError === undefined ? '' : ` (${summariesError})`),
        )
      }
      if (request.all === true) {
        scope = 'allSessions'
        // Sorted here rather than trusted from the host: the truncation note
        // claims "most recent", and `controller.list()`'s order is the host's
        // business, not a contract this report should rest on.
        const listed = summaries ?? []
        const candidates = listed
          .filter((summary) => includeSubagents || summary.origin !== 'subagent')
          .slice()
          .sort((left, right) => right.updatedAt - left.updatedAt)
        for (const summary of candidates.slice(0, request.limit)) {
          await addRow(
            summary.sessionId,
            summary.origin === 'subagent' ? 'subagent' : 'self',
            summary.parentSessionId,
          )
        }
        if (candidates.length > request.limit) {
          notes.push(`Only the ${request.limit} most recently updated session(s) were scanned; raise limit to cover more.`)
        }
        if (!includeSubagents && listed.length > candidates.length) {
          notes.push('Subagent sessions were excluded because includeSubagents is false.')
        }
      } else {
        scope = 'pluginSessions'
        // Only sessions this process created through the endpoint. A session
        // created by an earlier run of DSH is still readable — the caller knows
        // its id — but it is not this process's to enumerate.
        const known = new Map((summaries ?? []).map((summary) => [summary.sessionId, summary]))
        const created = [...this.ownedSessions].slice(-request.limit)
        if (created.length === 0) {
          // `all: true` is a dead end when the listing itself is unavailable, so the
          // advice must not offer it: measured on a profile whose
          // sessionController row is disabled, following that note fails.
          notes.push(
            summaries === undefined
              ? 'No session was created through this endpoint in the current DSH process, '
                + 'and this profile cannot list sessions either; pass a known sessionId to read its usage.'
              : 'No session was created through this endpoint in the current DSH process. '
                + 'Pass sessionId for one session, or all: true to scan every session this DSH knows.',
          )
        }
        for (const sessionId of created) {
          const summary = known.get(sessionId)
          await addRow(
            sessionId,
            summary?.origin === 'subagent' ? 'subagent' : 'self',
            summary?.parentSessionId,
          )
          if (childrenOf === undefined) {
            if (includeSubagents) {
              notes.push(
                'This DSH profile could not list sessions, so subagent sessions could not be enumerated.',
              )
            }
            continue
          }
          const children = this.subagentsOf(childrenOf, sessionId)
          if (includeSubagents) {
            truncatedSubagents = truncatedSubagents || children.truncated
            for (const child of children.items) {
              await addRow(child.sessionId, 'subagent', child.parentSessionId)
            }
          } else if (children.items.length > 0) {
            notes.push(
              `${children.items.length}${children.truncated ? '+' : ''} subagent session(s) under `
                + `${sessionId} were excluded because includeSubagents is false.`,
            )
          }
        }
        if (this.ownedSessions.size > request.limit) {
          notes.push(`Only the ${request.limit} most recent session(s) created by this endpoint were included; raise limit to cover more.`)
        }
      }
    }

    const read = rows.flatMap((row) => (row.usage === undefined ? [] : [row.usage]))
    const combined = combineUsage(read)
    const ignoredSamples = read.reduce((sum, usage) => sum + (usage.ignoredSamples ?? 0), 0)
    const totals = {
      ...combined.totals,
      turns: read.reduce((sum, usage) => sum + usage.turns, 0),
      steps: read.reduce((sum, usage) => sum + usage.steps, 0),
      samples: combined.samples,
    }
    const costs = rows.map((row) => row.cost ?? {
      available: false,
      reason: 'this session could not be read, so its money is unknown',
    })
    const combinedCost = combineCosts(costs)
    // A total that skipped rows is not the whole bill; say so on the money too,
    // where a caller is most likely to quote the number.
    const cost: CostReport = truncatedRows && combinedCost.available
      ? {
        ...combinedCost,
        partial: true,
        reason: 'some sessions were not scanned (row cap), so this total is incomplete',
      }
      : combinedCost
    const openRows = rows.filter((row) => row.usage?.partial === true)
    if (openRows.length > 0) {
      notes.push(
        `${openRows.length} of ${rows.length} session(s) had an unfinished turn when read; `
          + 'their totals and this report will still grow.',
      )
    }
    const errored = rows.filter((row) => row.error !== undefined)
    if (errored.length > 0) {
      notes.push(`${errored.length} of ${rows.length} session(s) could not be read; the totals exclude them.`)
    }
    if (truncatedRows) {
      notes.push(`Only the first ${MAX_USAGE_ROWS} session row(s) were read; raise limit is not enough here — narrow the request.`)
    }
    if (truncatedSubagents) {
      notes.push(`Only the first ${MAX_SUBAGENT_SESSIONS} subagent session(s) were folded in.`)
    }
    if (ignoredSamples > 0) {
      notes.push(
        `${ignoredSamples} usage record(s) could not be read, so the token totals under-report what the provider charged.`,
      )
    }
    // Only claimed when the walk actually ran: without a session listing there is
    // nothing to have found.
    if (scope === 'session' && includeSubagents && childrenOf !== undefined && rows.length === 1) {
      notes.push('No subagent session was found under this session.')
    }
    if (hiddenSessions > 0) {
      notes.push(
        `${hiddenSessions} session(s) were left out because session.scope is "owned": only sessions this `
          + 'endpoint created or forked are included.',
      )
    }
    notes.push(
      'Token totals are conversation usage folded from the durable session log, one record per model call. '
      + 'They exclude summarizing-compaction calls (reported in compaction where present) and the '
      + 'session-title call, which the log does not record; money amounts come from dsh-cost-meter and '
      + 'cover every in-session LLM call, so tokens and money do not reconcile exactly.',
    )

    return {
      generatedAt: new Date().toISOString(),
      scope,
      sessions: rows,
      totals,
      ...(openRows.length > 0 ? { partial: true as const } : {}),
      byModel: combined.byModel,
      // Reported from what the rows actually contain, not from the flag: a
      // caller reading `true` may assume the number covers subagent spend, and a
      // caller reading `false` must know the number may understate the task.
      subagentsIncluded: rows.some((row) => row.origin === 'subagent'),
      ...(truncatedSubagents ? { truncatedSubagents: true } : {}),
      ...(truncatedRows ? { truncatedRows: true } : {}),
      ...(ignoredSamples > 0 ? { ignoredSamples } : {}),
      cost,
      notes,
    }
  }

  /** One report row, with a read failure captured rather than thrown. */
  private async usageRow(
    sessionId: string,
    origin: 'self' | 'subagent',
    includeTurns: boolean,
    parentSessionId?: string,
    includeCost = true,
    sinceSeq?: number,
    fromTurn?: number,
    toTurn?: number,
  ): Promise<SessionUsageRow> {
    try {
      const cut = await this.readUsageCut(sessionId)
      const range = fromTurn === undefined && toTurn === undefined
        ? undefined
        : {
          ...(fromTurn === undefined ? {} : { from: fromTurn }),
          ...(toTurn === undefined ? {} : { to: toTurn }),
        }
      const report = buildUsageReport(cut, {
        includeTurns,
        ...(sinceSeq === undefined ? {} : { sinceSeq }),
        ...(range === undefined ? {} : { turnRange: range }),
        ...(hasOpenTurn(cut.events) ? { partial: true } : {}),
      })
      const cost = includeCost
        ? await readSessionCost(this.ctx, sessionId)
        : { available: false, reason: COST_DISABLED }
      return {
        sessionId,
        origin,
        ...(cut.cwd === undefined ? {} : { cwd: cut.cwd }),
        ...(parentSessionId === undefined || origin !== 'subagent' ? {} : { parentSessionId }),
        usage: report,
        cost,
      }
    } catch (error) {
      return {
        sessionId,
        origin,
        ...(parentSessionId === undefined || origin !== 'subagent' ? {} : { parentSessionId }),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Sessions grouped by their subagent parent.
   *
   * Keyed **only** on summaries that are actually subagent children. A parent
   * link alone is not enough: the harness also records `header.parentSession` for
   * an ordinary fork, and a fork is a full session of its own. Treating it as a
   * child would report a sibling as part of this session's spend and would drop
   * its usage from the totals when `includeSubagents` is false.
   */
  private subagentIndex(summaries: readonly DshSessionSummary[]): Map<string, string[]> {
    const childrenOf = new Map<string, string[]>()
    for (const summary of summaries) {
      if (summary.origin !== 'subagent') continue
      const parent = summary.parentSessionId
      if (parent === undefined) continue
      const siblings = childrenOf.get(parent)
      if (siblings === undefined) childrenOf.set(parent, [summary.sessionId])
      else siblings.push(summary.sessionId)
    }
    return childrenOf
  }

  /**
   * Every subagent session below one session, breadth first.
   *
   * A child of a child is included, and a session is visited once, so a
   * malformed cycle cannot loop. The walk is pure over the index, so one call can
   * reuse a single session listing for every target.
   */
  private subagentsOf(
    childrenOf: ReadonlyMap<string, readonly string[]>,
    sessionId: string,
  ): { items: { sessionId: string; parentSessionId: string }[]; truncated: boolean } {
    const items: { sessionId: string; parentSessionId: string }[] = []
    const seen = new Set<string>([sessionId])
    let frontier = [sessionId]
    while (frontier.length > 0) {
      const next: string[] = []
      for (const parent of frontier) {
        for (const child of childrenOf.get(parent) ?? []) {
          if (seen.has(child)) continue
          seen.add(child)
          if (items.length >= MAX_SUBAGENT_SESSIONS) return { items, truncated: true }
          items.push({ sessionId: child, parentSessionId: parent })
          next.push(child)
        }
      }
      frontier = next
    }
    return { items, truncated: false }
  }

  /** Serialize driver-initiated turns per session. */
  private enqueueTurn<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.turnQueues.get(sessionId) ?? Promise.resolve()
    const run = prior.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.turnQueues.set(sessionId, tail)
    void tail.then(() => {
      if (this.turnQueues.get(sessionId) === tail) this.turnQueues.delete(sessionId)
    })
    return run
  }

  // ---------------------------------------------------------------------------
  // The harness's own tools
  // ---------------------------------------------------------------------------

  /**
   * The harness tools this caller may invoke, as the given session's agent sees
   * them.
   *
   * Two filters compose, and both are needed. The allow-list is this plugin's:
   * it decides what the endpoint exposes at all, and it is applied to the listing
   * as well as to execution so a caller cannot discover what it may not call. The
   * scope is the harness's: `schemas(agent)` already hides tools the session's own
   * policy restricts away, so a caller under a narrower preset sees a narrower
   * toolbox without this plugin reimplementing that model.
   *
   * A session is mandatory because the second filter *is* the agent: without one
   * there is no scope to resolve, and the harness answers with an empty toolbox
   * rather than the deployment default.
   */
  async listAgentTools(request: { sessionId: string }): Promise<{
    tools: { name: string; description: string; parameters: Record<string, unknown> }[]
    sessionId: string
    /** Set when the session could not be resolved to an agent. */
    scopeError?: string
  }> {
    const registry = this.requireToolRegistry()
    const { agent, scopeError } = await this.resolveScope(request.sessionId)
    const visible = registry.schemas(agent) ?? []
    const permitted = this.permittedAgentTools()
    const tools = visible
      .filter((schema) => permitted.has(schema.name))
      .map((schema) => ({
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return {
      tools,
      sessionId: request.sessionId,
      ...(scopeError === undefined ? {} : { scopeError }),
    }
  }

  /**
   * Run one harness tool through the production pipeline.
   *
   * The allow-list is re-checked here rather than trusted from the listing: a
   * caller can name any tool it likes, and `execute` would happily run one that
   * was never advertised.
   *
   * Running as the session's agent is not a convenience — it is what supplies the
   * policy. The harness applies the owning agent's sandbox, guards and approval,
   * and records the call in that session's transcript.
   */
  async callAgentTool(request: {
    name: string
    args?: unknown
    sessionId: string
    signal?: AbortSignal
    timeoutMs: number
    /**
     * Ceiling on the result text returned to the caller. Defaults to 20,000
     * characters.
     *
     * An agent tool can return a whole file (`read`) or a whole command output
     * (`bash`); echoing that verbatim is how one call floods the caller's context.
     */
    maxResultChars?: number
  }): Promise<{
    name: string
    ok: boolean
    value?: unknown
    /** Text blocks the tool produced, flattened, capped at `maxResultChars`. */
    text: string
    /** Size of the tool's text output before the cap. */
    resultBytes: number
    /** True when `text` was cut to the cap and `value` was omitted. */
    truncated?: boolean
    error?: string
  }> {
    const registry = this.requireToolRegistry()
    const permitted = this.permittedAgentTools()
    if (!permitted.has(request.name)) {
      throw new Error(
        `tool "${request.name}" is not exposed by this endpoint. `
        + 'Only the names in dsh_tool_list may be called; an operator can add one '
        + 'with the agentTools.allow setting.',
      )
    }

    const { agent, scopeError } = await this.resolveScope(request.sessionId)
    // Running without a scope is not a lesser version of the call. Tools are
    // registered inside an agent scope, so an unscoped `execute` answers
    // `unknown tool` — an error that names neither the session nor the reason.
    // The scope failure is the actionable one; report it instead.
    if (agent === undefined) {
      throw new Error(scopeError ?? `session "${request.sessionId}" could not be scoped to an agent`)
    }
    // Cancellation has to come from somewhere: `signal` is required by the
    // harness, and a hung tool would otherwise hold the call open forever.
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    request.signal?.addEventListener('abort', relay, { once: true })
    // `timedOut` distinguishes our deadline from a client cancellation: the
    // harness reports both as "tool call aborted", which is not actionable on its
    // own — the caller that passed timeoutMs needs to see that it fired.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, request.timeoutMs)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()

    try {
      const result = await this.executeAgentTool(registry, {
        name: request.name,
        arguments: request.args ?? {},
        agent,
        signal: controller.signal,
      })
      const text = flattenToolContent(result.content)
      const resultBytes = byteLength(text)
      const limit = Math.max(100, request.maxResultChars ?? 20_000)
      const truncated = text.length > limit
      // `value` is dropped when the text is cut: keeping a structured duplicate of
      // output the caller cannot fully see would bound nothing.
      if (result.isError) {
        return {
          name: request.name,
          ok: false,
          text: truncated ? text.slice(0, limit) : text,
          resultBytes,
          ...(truncated ? { truncated: true as const } : {}),
          error: timedOut
            ? `tool call aborted after ${request.timeoutMs}ms because timeoutMs elapsed; `
              + 'the call may still be running in the session'
            : truncateText(result.error.message, 2_000),
        }
      }
      return {
        name: request.name,
        ok: true,
        ...(truncated ? {} : { value: result.value }),
        text: truncated ? text.slice(0, limit) : text,
        resultBytes,
        ...(truncated ? { truncated: true as const } : {}),
      }
    } catch (error) {
      if (!timedOut) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `tool call aborted after ${request.timeoutMs}ms because timeoutMs elapsed; `
          + `the call may still be running in the session (${message})`,
      )
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', relay)
    }
  }

  /**
   * Run one tool call on whichever `ctx.tools.execute` contract the host implements.
   *
   * DSH 0.2.2 replaced the single-call input/output with a batch
   * (`packages/core/tools/src/pipeline.ts`): a caller sends raw calls —
   * `{calls: [{type: 'tool-call', id, name, arguments: <JSON string>}], signal, agent}`
   * — and receives `{results: [{callId, result}]}`. Through 0.1.x the same member
   * took one `ToolExecutionInput` and answered one `ToolExecutionResult`.
   *
   * The two shapes are told apart by `tools.resolve`, which shipped in the same
   * release as the batch executor. Without that marker the legacy path runs, so
   * both versions reach this method's single return type. This is the difference
   * that made `dsh_tool_call` fail outright on 0.2.2 ("Tool batch execution
   * failed") while its listing kept working: only the execution shape changed.
   */
  private async executeAgentTool(
    registry: DshToolRegistry,
    call: {
      name: string
      arguments: unknown
      agent: DshAgentHandle
      signal: AbortSignal
    },
  ): Promise<DshToolExecutionResult> {
    const callId = `dsh-as-mcp-${randomUUID()}`
    if (typeof registry.resolve !== 'function') {
      return await registry.execute({
        callId,
        name: call.name,
        arguments: call.arguments,
        agent: call.agent,
        signal: call.signal,
      } satisfies DshToolExecutionInput) as DshToolExecutionResult
    }
    const output = await registry.execute({
      calls: [{
        type: 'tool-call',
        id: callId,
        name: call.name,
        // The executor parses model-facing JSON and preserves invalid JSON as
        // text; structured arguments therefore have to be serialized here.
        arguments: JSON.stringify(call.arguments ?? {}),
      }],
      signal: call.signal,
      agent: call.agent,
    } satisfies DshToolBatchInput)
    return toolBatchResultOf(output)
  }

  /** The tool names this configuration exposes. */
  private permittedAgentTools(): Set<string> {
    const { allow, deny } = this.config.agentTools
    const names = allow.length > 0 ? allow : DEFAULT_AGENT_TOOLS.allow
    const denied = new Set(deny)
    return new Set(names.filter((name) => !denied.has(name)))
  }

  /**
   * Resolve the session whose agent scopes a tool call.
   *
   * The agent is the policy: it is what makes the harness apply a sandbox, run
   * guards, and file the call under a session transcript. There is no unscoped
   * fallback — see the guard in the body for why one cannot exist.
   *
   * The two callers differ in what they do with a scope failure, and both are
   * deliberate: {@link listAgentTools} reports it alongside the empty result,
   * because a listing is still a useful answer to "what can this session call";
   * {@link callAgentTool} throws it, because executing without the agent would
   * answer `unknown tool` and bury the reason.
   */
  private async resolveScope(sessionId: string): Promise<{
    agent?: DshAgentHandle
    scopeError?: string
  }> {
    if (typeof sessionId !== 'string' || sessionId === '') {
      // There is no agentless toolbox to fall back to, so a missing session is an
      // error rather than an empty result. Tools are registered into the scope of
      // the context that registers them (`ToolRuntime.register` →
      // `layers.effect(ctx, …)`), and every tool package ships inside an agent
      // preset, so the global layer is empty by construction: an unscoped
      // `schemas()` really does report zero tools, and an unscoped `execute`
      // answers `unknown tool`. Measured, not assumed.
      throw new Error(
        'sessionId is required: DSH registers its tools inside an agent scope, so there is no '
        + 'deployment-wide toolbox to act on. Pass the session that should own this call — create '
        + 'one with session_create — or use file_read/file_write/file_list/shell_run, which resolve '
        + 'the deployment policy directly and need no session.',
      )
    }
    const controller = this.requireSessionController()
    if (typeof controller.resolveAgent !== 'function') {
      return { scopeError: 'this DSH profile cannot resolve a session to an agent, so there is no scope to run under' }
    }
    const found = await controller.resolveAgent(sessionId)
    if ('error' in found) {
      return {
        scopeError: `session "${sessionId}" could not be scoped to an agent: ${String(found.error)}`,
      }
    }
    return { agent: found.agent }
  }

  private requireToolRegistry(): DshToolRegistry {
    const registry = this.toolRegistry()
    if (registry === undefined) {
      throw new DshCapabilityError(
        'tools',
        'this DSH profile provides no tools service, so its agent tools cannot be called.',
      )
    }
    return registry
  }

  private toolRegistry(): DshToolRegistry | undefined {
    return serviceOf<DshToolRegistry>(this.ctx, 'tools')
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  /** Read one UTF-8 file through the harness filesystem seam. */
  async readFile(request: {
    path: string
    cwd?: string
    maxBytes: number
    /** Byte offset to start at, for paging through a file larger than one call. */
    offset?: number
    /**
     * Also hash the whole file (SHA-256), so a read→edit→write cycle can carry the
     * compare-and-swap value without a second call.
     */
    sha256?: boolean
    /**
     * Ceiling for the whole-file hash, when it differs from this call's window cap
     * (the tool passes limits.maxReadBytes so a small window can still hash a file
     * within the configured ceiling).
     */
    sha256Limit?: number
  }): Promise<{
    path: string
    text: string
    truncated: boolean
    /** Byte offset this read started at. */
    offset: number
    /** Bytes returned (UTF-8 decode may be shorter in characters). */
    bytes: number
    /** Offset to pass on the next call when `truncated` is true. */
    nextOffset?: number
    /** File size when the seam reports it. */
    size?: number
    /** SHA-256 of the whole file, when `sha256: true` was asked. */
    sha256?: string
  }> {
    const fs = this.requireFileSystem()
    const target = await fs.resolve(request.path, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    })
    const info = await fs.stat(target)
    if (info?.type === 'directory') throw new Error(`${target.displayPath} is a directory; use file_list`)

    const offset = request.offset ?? 0
    // One byte past the cap, so a window exactly at the limit reads whole and one
    // byte more proves truncation. `readByteRange` is the read that can do this:
    // `readBytes` REJECTS with `FS_TOO_LARGE` when the file exceeds its cap rather
    // than truncating, so using it here made `truncated` unreachable and turned
    // every file over the cap into an error.
    const bytes = await fs.readByteRange(target, { offset, length: request.maxBytes + 1 })
    const truncated = bytes.byteLength > request.maxBytes
    const slice = truncated ? bytes.subarray(0, request.maxBytes) : bytes
    // The hash is of the WHOLE file, not the returned window: the caller uses it as
    // a compare-and-swap value for the next write, and a window hash would let a
    // stale write through. Hashing therefore reads the whole file, which is why it
    // is opt-in and refuses a file above the configured read ceiling.
    let fileSha256: string | undefined
    if (request.sha256 === true) {
      const hashCeiling = request.sha256Limit ?? request.maxBytes
      if (info?.size !== undefined && info.size > hashCeiling) {
        throw new Error(
          `cannot hash "${fs.processPath(target)}": it is ${info.size} bytes, above the `
            + `${hashCeiling}-byte read ceiling. Raise limits.maxReadBytes or hash it with shell_run.`,
        )
      }
      const whole = await fs.readText(target)
      fileSha256 = sha256OfText(whole)
    }
    return {
      path: fs.processPath(target),
      text: new TextDecoder('utf-8', { fatal: false }).decode(slice),
      truncated,
      offset,
      bytes: slice.byteLength,
      ...(truncated ? { nextOffset: offset + slice.byteLength } : {}),
      ...(info?.size === undefined ? {} : { size: info.size }),
      ...(fileSha256 === undefined ? {} : { sha256: fileSha256 }),
    }
  }

  /**
   * Read one image as an MCP image payload.
   *
   * The bytes go through the same filesystem seam as `file_read`, so the same
   * sandbox and path rules decide what is reachable; only the encoding differs,
   * because an image is not text and base64 in a JSON string would be unreadable
   * to the caller. The format is detected from the bytes, never from the file
   * extension: a `.png` that contains something else must not be labelled PNG.
   */
  async readImage(request: { path: string; cwd?: string }): Promise<{
    path: string
    mimeType: string
    /** Base64 payload, ready for an MCP `image` content block. */
    base64: string
    bytes: number
    /** Size on disk when the seam reports it. */
    size?: number
  }> {
    return await this.loadImage(request.path, request.cwd, 'display')
  }

  /**
   * Read one image file into base64, capped and sniffed.
   *
   * @param purpose - `display` for an MCP image block (BMP allowed), `prompt` for
   *   an image a session must consume (only the formats `ImageMediaType` names).
   */
  private async loadImage(
    path: string,
    cwd: string | undefined,
    purpose: 'display' | 'prompt',
  ): Promise<{
    path: string
    mimeType: string
    base64: string
    bytes: number
    size?: number
  }> {
    const fs = this.requireFileSystem()
    const target = await fs.resolve(path, { ...(cwd === undefined ? {} : { cwd }) })
    const displayPath = fs.processPath(target)
    const info = await fs.stat(target)
    if (info === undefined) throw new Error(`cannot read ${displayPath}: it does not exist`)
    if (info.type === 'directory') throw new Error(`${displayPath} is a directory; use file_list`)

    const tooLarge = (size: number): Error => new Error(
      `image is ${size} bytes, larger than the ${MAX_IMAGE_BYTES}-byte cap; inspect it with shell_run instead`,
    )
    if (info.size !== undefined && info.size > MAX_IMAGE_BYTES) throw tooLarge(info.size)
    // One byte past the cap, the same trick `file_read` uses: a file exactly at
    // the cap is carried whole, and the extra byte proves a larger one exists
    // even when `stat` reported no size.
    const window = info.size === undefined
      ? MAX_IMAGE_BYTES + 1
      : Math.min(info.size + 1, MAX_IMAGE_BYTES + 1)
    const bytes = await fs.readByteRange(target, { offset: 0, length: window })
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw tooLarge(bytes.byteLength)
    const mimeType = detectImageMime(bytes)
    if (mimeType === undefined) {
      throw new Error(
        `${displayPath} is not an image this tool can carry (supported: png, jpeg, gif, webp, bmp). `
        + 'Use file_read for text.',
      )
    }
    if (purpose === 'prompt' && !PROMPT_IMAGE_TYPES.includes(mimeType)) {
      throw new Error(
        `${displayPath} is ${mimeType}, which a prompt cannot carry (supported: png, jpeg, webp, gif)`,
      )
    }
    return {
      path: displayPath,
      mimeType,
      base64: Buffer.from(bytes).toString('base64'),
      bytes: bytes.byteLength,
      ...(info.size === undefined ? {} : { size: info.size }),
    }
  }

  /** Load prompt attachments, enforcing the count cap before any read. */
  private async readPromptImages(images: readonly PromptImageRequest[]): Promise<DshPromptPart[]> {
    if (images.length === 0) return []
    if (images.length > MAX_PROMPT_IMAGES) {
      throw new Error(
        `a prompt may carry at most ${MAX_PROMPT_IMAGES} images; this one has ${images.length}`,
      )
    }
    const parts: DshPromptPart[] = []
    for (const image of images) {
      const loaded = await this.loadImage(image.path, image.cwd, 'prompt')
      parts.push({
        type: 'image',
        mediaType: loaded.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
        data: loaded.base64,
        name: basename(loaded.path),
      })
    }
    return parts
  }

  /** Write one UTF-8 file, creating parent directories when asked. */
  async writeFile(request: {
    path: string
    content: string
    cwd?: string
    createDirectories: boolean
    /**
     * Compare-and-swap guard: the write proceeds only when the file's current
     * content hashes to this value. A caller that read the file and then wrote it
     * back would otherwise silently clobber a concurrent edit.
     */
    expectedSha256?: string
  }): Promise<{ path: string; operation: 'create' | 'update'; sha256: string }> {
    const fs = this.requireFileSystem()
    // Deliberately no `node:fs` mkdir here, even when `createDirectories` is set.
    // Creating the parent ourselves would run *before* `fs.resolve`, and therefore
    // before the sandbox backend's `checkedTarget`: under the fail-safe `read-only`
    // default it would create directories the policy forbids, and under
    // `workspace-write` a symlinked ancestor would land them outside the root
    // before the write itself was refused. It is also unnecessary — the seam's
    // atomic write already does `mkdir(dirname(target), { recursive: true })`
    // inside the fence (`fs-local/src/fsio.ts:578-580`).
    const target = await fs.resolve(request.path, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    })
    if (!request.createDirectories) {
      // The seam's write always creates missing parents, so `false` has to be
      // enforced *before* the write: probe the parent through the seam so the
      // same path rules apply, and refuse when it is not there.
      const parent = await fs.resolve(dirname(fs.processPath(target)))
      if ((await fs.stat(parent)) === undefined) {
        throw new Error(
          `cannot write "${fs.processPath(target)}": its parent directory does not exist `
          + 'and createDirectories is false.',
        )
      }
    }
    if (request.expectedSha256 !== undefined) {
      const current = await readCurrentText(fs, target)
      const actual = current === undefined ? undefined : sha256OfText(current)
      if (current === undefined) {
        throw new Error(
          `cannot write "${fs.processPath(target)}": expectedSha256 was given but the file does not exist `
            + '(omit it to create a new file).',
        )
      }
      if (actual !== request.expectedSha256.toLowerCase()) {
        throw new Error(
          `refusing to overwrite "${fs.processPath(target)}": its current sha256 is ${actual}, not the `
            + `expected ${request.expectedSha256}. The file changed since you read it; read it again, or omit `
            + 'expectedSha256 to overwrite unconditionally.',
        )
      }
    }
    const outcome = await fs.writeText(target, request.content)
    return { path: fs.processPath(target), operation: outcome.operation, sha256: sha256OfText(request.content) }
  }

  /**
   * Edit one file by replacing literal text.
   *
   * The point is cost, not convenience: without this, every edit is a full
   * `file_read` followed by a full `file_write` in a calling agent's context —
   * for a 2,000-line file that is two round trips of the whole file to change one
   * line. The replacement is deliberately literal and counted:
   *
   * - `oldText` must appear exactly once unless `replaceAll` is set. A pattern
   *   that matches twice is ambiguous, and silently replacing the first one would
   *   corrupt the file in a way the caller cannot see from the result.
   * - Nothing is written when the count is wrong, so a failed edit leaves the
   *   file untouched (the write itself is atomic).
   *
   * @param request.maxBytes - ceiling for the file this will rewrite; the caller
   *   passes the configured read limit so an edit cannot become an unbounded read.
   */
  async editFile(request: {
    path: string
    cwd?: string
    oldText: string
    newText: string
    replaceAll: boolean
    maxBytes: number
    /** Compare-and-swap guard over the whole file, checked before any write. */
    expectedSha256?: string
  }): Promise<{
    path: string
    replacements: number
    bytesBefore: number
    bytesAfter: number
    sha256: string
  }> {
    if (request.oldText === '') throw new Error('oldText must not be empty')
    if (request.oldText === request.newText) {
      throw new Error('oldText and newText are identical; there is nothing to change')
    }
    const fs = this.requireFileSystem()
    const target = await fs.resolve(request.path, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    })
    const displayPath = fs.processPath(target)
    const info = await fs.stat(target)
    if (info === undefined) {
      throw new Error(`cannot edit ${displayPath}: it does not exist. Use file_write to create it.`)
    }
    if (info.type === 'directory') throw new Error(`${displayPath} is a directory; use file_list`)
    if (info.size !== undefined && info.size > request.maxBytes) {
      throw new Error(
        `cannot edit ${displayPath}: it is ${info.size} bytes, above the ${request.maxBytes}-byte edit `
        + 'limit. Use shell_run for a file this large, or raise limits.maxReadBytes.',
      )
    }

    let before: string
    try {
      before = await fs.readText(target)
    } catch (error) {
      throw new Error(
        `cannot read ${displayPath} for an edit: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (request.expectedSha256 !== undefined) {
      const actual = sha256OfText(before)
      if (actual !== request.expectedSha256.toLowerCase()) {
        throw new Error(
          `refusing to edit ${displayPath}: its current sha256 is ${actual}, not the expected `
            + `${request.expectedSha256}. The file changed since you read it; read it again, or omit `
            + 'expectedSha256 to edit unconditionally.',
        )
      }
    }

    let replacements = 0
    for (let at = before.indexOf(request.oldText); at >= 0; at = before.indexOf(request.oldText, at + request.oldText.length)) {
      replacements += 1
    }
    if (replacements === 0) {
      throw new Error(
        `oldText was not found in ${displayPath}. The match is literal: it must include the exact `
        + 'whitespace and indentation of the current file.',
      )
    }
    if (replacements > 1 && !request.replaceAll) {
      throw new Error(
        `oldText matches ${replacements} times in ${displayPath}. Include more surrounding text to make it `
        + 'unique, or pass replaceAll: true to replace every occurrence. Nothing was written.',
      )
    }

    const after = request.replaceAll
      ? before.split(request.oldText).join(request.newText)
      : before.slice(0, before.indexOf(request.oldText))
        + request.newText
        + before.slice(before.indexOf(request.oldText) + request.oldText.length)
    await fs.writeText(target, after)
    return {
      path: displayPath,
      replacements: request.replaceAll ? replacements : 1,
      bytesBefore: info.size ?? new TextEncoder().encode(before).byteLength,
      bytesAfter: new TextEncoder().encode(after).byteLength,
      sha256: sha256OfText(after),
    }
  }

  /**
   * List a directory through the harness filesystem seam.
   *
   * `recursive` walks into subdirectories, bounded two ways: `maxDepth` and a hard
   * entry cap ({@link MAX_LIST_ENTRIES}), with `truncated` when the cap stopped
   * the walk. Directories are visited once by the seam's own `targetKey`, so a
   * symlink cycle cannot loop — the seam resolves links, so two paths to the same
   * directory are one visit.
   */
  async listDirectory(request: {
    path: string
    cwd?: string
    recursive?: boolean
    maxDepth?: number
    /** Also hash each file's content (up to sha256Limit), for bulk change detection. */
    sha256?: boolean
    sha256Limit?: number
  }): Promise<{
    path: string
    entries: DirectoryEntry[]
    /** Present only when the entry cap stopped the walk. */
    truncated?: boolean
  }> {
    const fs = this.requireFileSystem()
    const target = await fs.resolve(request.path, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    })
    const root = fs.processPath(target)

    if (request.recursive !== true) {
      const entries = await fs.listDir(target)
      const listed = await Promise.all(entries.map(async (entry) => ({
        name: entry.name,
        type: entry.type,
        ...(entry.size === undefined ? {} : { size: entry.size }),
        ...(request.sha256 === true && entry.type === 'file'
          ? await hashEntry(fs, entry.target, request.sha256Limit)
          : {}),
      })))
      return {
        path: root,
        entries: listed.sort((left, right) => left.name.localeCompare(right.name)),
      }
    }

    const maxDepth = request.maxDepth ?? Number.POSITIVE_INFINITY
    const visited = new Set<string>([target.targetKey])
    const collected: DirectoryEntry[] = []
    let truncated = false
    const queue: { target: DshFsTarget; prefix: string; depth: number }[] = [{ target, prefix: '', depth: 0 }]

    while (queue.length > 0 && !truncated) {
      const current = queue.shift() as { target: DshFsTarget; prefix: string; depth: number }
      let children: Awaited<ReturnType<DshFileSystem['listDir']>>
      try {
        children = await fs.listDir(current.target)
      } catch (error) {
        // An unreadable directory must not fail the whole listing: report the
        // directory itself, so the caller sees that something is there and that
        // its contents could not be read.
        this.log.debug(
          '[dsh-as-mcp] could not list %s while walking recursively: %s',
          current.prefix === '' ? root : current.prefix,
          error instanceof Error ? error.message : String(error),
        )
        if (current.prefix !== '') {
          collected.push({ name: current.prefix, type: 'other', path: current.prefix, depth: current.depth })
        }
        continue
      }
      for (const entry of children) {
        if (collected.length >= MAX_LIST_ENTRIES) {
          truncated = true
          break
        }
        const path = current.prefix === '' ? entry.name : `${current.prefix}/${entry.name}`
        const depth = current.depth + 1
        collected.push({
          name: entry.name,
          type: entry.type,
          ...(entry.size === undefined ? {} : { size: entry.size }),
          ...(request.sha256 === true && entry.type === 'file'
            ? await hashEntry(fs, entry.target, request.sha256Limit)
            : {}),
          path,
          depth,
        })
        if (entry.type !== 'directory' || depth >= maxDepth) continue
        const key = entry.target.targetKey
        if (visited.has(key)) continue
        visited.add(key)
        queue.push({ target: entry.target, prefix: path, depth })
      }
    }

    return {
      path: root,
      entries: collected.sort((left, right) => (left.path ?? left.name).localeCompare(right.path ?? right.name)),
      ...(truncated ? { truncated: true } : {}),
    }
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  /** Run one shell command through the harness shell seam. */
  async runShell(request: {
    command: string
    cwd?: string
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<{
    exitCode: number | null
    signal: string | null
    timedOut: boolean
    aborted: boolean
    stdout: string
    stderr: string
    stdoutTruncated: boolean
    stderrTruncated: boolean
  }> {
    const shell = this.requireShell()
    const spec = shell.resolve({
      command: request.command,
      ...(request.cwd === undefined ? {} : { workdir: request.cwd }),
      timeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    // `run` on 0.1.5-rc.1 returns the settled result; from 0.1.7-rc.2 `execute`
    // resolves to a live process handle whose `result()` is the foreground
    // projection. Awaiting that `result()` is not optional: reading the handle's
    // own `stdout` yields undefined, which is exactly how `shell_run` broke on
    // 0.2.1 until this was separated.
    const launch = (shell.run ?? shell.execute) as
      | ((this: DshShellExecutor, spec: unknown) => Promise<unknown>)
      | undefined
    if (launch === undefined) {
      throw new Error('the shell service exposes neither run() nor execute(); cannot run a command')
    }
    const result = await settleShellResult(await launch.call(shell, spec) as DshShellRunResult | DshShellExecution)
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      stdoutTruncated: result.stdout.truncated,
      stderrTruncated: result.stderr.truncated,
    }
  }

  // ---------------------------------------------------------------------------
  // Background shell jobs
  // ---------------------------------------------------------------------------

  /**
   * Start a command in the background and return a job id.
   *
   * The point is a build, test run, or dev server that outlives one MCP call:
   * `shell_run` blocks until the command finishes, which for a long command means
   * the caller holds a request open and cannot do anything else. The job keeps
   * the process handle in this driver, so `shell_output` and `shell_kill` work
   * across calls.
   *
   * On 0.1.7+ the handle comes from `execute()` with `onExpiry: 'none'` — no
   * deadline at all, because the caller polls. `timeoutMs`, when given, is
   * enforced by killing the process, so a runaway command still ends.
   *
   * @param request.command - shell command to start.
   * @param request.cwd - working directory (defaults to the deployment's).
   * @param request.timeoutMs - optional watchdog; the command is killed after it.
   */
  async startShellJob(request: {
    command: string
    cwd?: string
    timeoutMs?: number
  }): Promise<ShellJobSummary> {
    const shell = this.requireShell()
    this.pruneShellJobs(true)

    const spec = shell.resolve({
      command: request.command,
      ...(request.cwd === undefined ? {} : { workdir: request.cwd }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      onExpiry: request.timeoutMs === undefined ? 'none' : 'kill',
    })

    let handle: DshShellProcess
    if (typeof shell.start === 'function') {
      // 0.1.5-rc.1: `start` is synchronous and returns the process handle.
      handle = shell.start(spec)
    } else if (typeof shell.execute === 'function') {
      handle = await shell.execute(spec)
    } else {
      throw new Error(
        'the shell service exposes neither start() nor execute(); this harness cannot run background commands',
      )
    }

    this.shellJobSeq += 1
    const jobId = `shell-${Date.now().toString(36)}-${this.shellJobSeq}`
    const job: ShellJobState = {
      jobId,
      command: request.command,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      startedAt: Date.now(),
      handle,
      buffer: '',
      tail: '',
      tailTruncated: false,
      truncated: false,
    }
    if (request.timeoutMs !== undefined) {
      job.timer = setTimeout(() => {
        this.log.warn(
          '[dsh-as-mcp] background job %s exceeded its %d ms watchdog; killing it',
          jobId,
          request.timeoutMs,
        )
        try {
          handle.kill()
        } catch (error) {
          this.log.warn('[dsh-as-mcp] could not kill background job %s: %s', jobId, error)
        }
      }, request.timeoutMs)
      // A watchdog must not keep the host process alive on its own.
      job.timer.unref?.()
    }
    this.shellJobs.set(jobId, job)

    void handle.done?.then(
      () => this.settleShellJob(job),
      () => this.settleShellJob(job),
    )
    // A handle that settled before we attached the listener still needs settling.
    if (handle.status !== 'running') this.settleShellJob(job)

    return this.summarizeShellJob(job)
  }

  /**
   * Background jobs, newest first.
   *
   * `running` filters by state: a long-lived session accumulates finished jobs,
   * and a caller that only wants the live ones should not have to filter the page
   * itself. Absent means every job this driver still holds.
   */
  listShellJobs(options: { running?: boolean } = {}): ShellJobSummary[] {
    return [...this.shellJobs.values()]
      .filter((job) => options.running === undefined || (job.handle.status === 'running') === options.running)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((job) => this.summarizeShellJob(job))
  }

  /**
   * One background job as a non-consuming feed snapshot.
   *
   * `shell_output` is consuming by design: the caller that polls owns the bytes.
   * A push feed cannot consume them, or it would steal output from that caller, so
   * this returns the retained tail instead. `drainShellJob` still runs here — it
   * is what moves bytes from the process into the buffers — but the delivery
   * buffer is left untouched.
   *
   * @param jobId - job id from `shell_start` or `shell_list`.
   * @returns the summary plus the retained tail, or `undefined` for an unknown job.
   */
  peekShellJob(jobId: string): ShellJobPeek | undefined {
    const job = this.shellJobs.get(jobId)
    if (job === undefined) return undefined
    this.drainShellJob(job)
    return {
      ...this.summarizeShellJob(job),
      tail: job.tail,
      tailTruncated: job.tailTruncated,
    }
  }

  /**
   * New output from one job, bounded per call.
   *
   * Reads from the process are consuming, and the driver keeps the undelivered
   * remainder in a bounded buffer: a caller that polls rarely still receives the
   * text, and a caller that never polls cannot make the plugin hold an unbounded
   * amount of it (`truncated` says when the cap dropped bytes).
   */
  readShellOutput(request: { jobId: string; maxBytes?: number }): ShellOutputPage {
    const job = this.shellJobs.get(request.jobId)
    if (job === undefined) {
      throw new Error(`unknown background job "${request.jobId}"; call shell_list to see the live ones`)
    }
    this.drainShellJob(job)

    const maxBytes = Math.max(1, request.maxBytes ?? DEFAULT_SHELL_OUTPUT_BYTES)
    const buffer = Buffer.from(job.buffer, 'utf8')
    const delivered = buffer.subarray(0, maxBytes).toString('utf8')
    job.buffer = buffer.subarray(Buffer.byteLength(delivered, 'utf8')).toString('utf8')

    return {
      jobId: job.jobId,
      status: job.handle.status,
      exitCode: job.handle.exitCode,
      signal: job.handle.signal,
      done: job.handle.status !== 'running',
      output: delivered,
      pendingBytes: Buffer.byteLength(job.buffer, 'utf8'),
      truncated: job.truncated,
      lossy: job.lossy === true,
      ...(job.stdoutSpillPath === undefined ? {} : { stdoutSpillPath: job.stdoutSpillPath }),
      ...(job.stderrSpillPath === undefined ? {} : { stderrSpillPath: job.stderrSpillPath }),
    }
  }

  /** Ask one job to stop, and wait briefly for it to settle. */
  async killShellJob(request: { jobId: string; waitMs?: number }): Promise<{
    jobId: string
    killed: boolean
    status: 'running' | 'completed' | 'killed'
  }> {
    const job = this.shellJobs.get(request.jobId)
    if (job === undefined) {
      throw new Error(`unknown background job "${request.jobId}"; call shell_list to see the live ones`)
    }
    let killed = false
    try {
      killed = job.handle.kill()
    } catch (error) {
      this.log.warn('[dsh-as-mcp] could not kill background job %s: %s', job.jobId, error)
    }
    const waitMs = Math.max(0, request.waitMs ?? 2_000)
    if (job.handle.done !== undefined && job.handle.status === 'running') {
      await Promise.race([
        job.handle.done,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs)
          timer.unref?.()
        }),
      ])
    }
    this.settleShellJob(job)
    return { jobId: job.jobId, killed, status: job.handle.status }
  }

  /** Collect everything the process has written since the last drain. */
  private drainShellJob(job: ShellJobState): void {
    let read: ReturnType<DshShellProcess['readOutput']>
    try {
      read = job.handle.readOutput()
    } catch (error) {
      this.log.debug(
        '[dsh-as-mcp] could not read output of background job %s: %s',
        job.jobId,
        error instanceof Error ? error.message : String(error),
      )
      return
    }
    if (read.delta !== '') {
      job.buffer += read.delta
      job.tail += read.delta
      const tailBytes = Buffer.byteLength(job.tail, 'utf8')
      if (tailBytes > MAX_SHELL_TAIL_BYTES) {
        const rawTail = Buffer.from(job.tail, 'utf8')
        job.tail = rawTail.subarray(rawTail.byteLength - MAX_SHELL_TAIL_BYTES).toString('utf8')
        job.tailTruncated = true
      }
    }
    if (read.lossy) {
      // The distinction matters to a caller: `truncated` means something was not
      // delivered, `lossy` means *this service* already dropped bytes (the spill
      // paths hold the full stream). Setting only `truncated` left `lossy`
      // permanently false on the page, which is what a probe against a 200 KiB
      // writer showed.
      job.truncated = true
      job.lossy = true
    }
    if (read.stdoutSpillPath !== undefined) job.stdoutSpillPath = read.stdoutSpillPath
    if (read.stderrSpillPath !== undefined) job.stderrSpillPath = read.stderrSpillPath

    const bytes = Buffer.byteLength(job.buffer, 'utf8')
    if (bytes > MAX_SHELL_BUFFER_BYTES) {
      // Trim from the front by bytes, not characters: a multi-byte character cut
      // in half decodes as U+FFFD, which is the same trade-off `file_read` paging
      // documents, and the alternative is unbounded memory for an unread job.
      const raw = Buffer.from(job.buffer, 'utf8')
      job.buffer = raw.subarray(raw.byteLength - MAX_SHELL_BUFFER_BYTES).toString('utf8')
      job.truncated = true
    }
  }

  private settleShellJob(job: ShellJobState): void {
    if (job.finishedAt !== undefined) return
    if (job.handle.status === 'running') return
    job.finishedAt = Date.now()
    if (job.timer !== undefined) {
      clearTimeout(job.timer)
      job.timer = undefined
    }
    // The final output is still buffered for one last `shell_output`; settling
    // only stops the job from counting against the running limit.
  }

  private summarizeShellJob(job: ShellJobState): ShellJobSummary {
    return {
      jobId: job.jobId,
      command: job.command,
      ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
      status: job.handle.status,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      exitCode: job.handle.exitCode,
      signal: job.handle.signal,
      pendingBytes: Buffer.byteLength(job.buffer, 'utf8'),
    }
  }

  /**
   * Keep the job table bounded.
   *
   * A finished job is kept until the table fills, so its last output can still be
   * collected; when the table is full and something must go, the oldest finished
   * job goes first. Starting a job while {@link MAX_SHELL_JOBS} are still running
   * is refused rather than silently killing someone else's process.
   */
  private pruneShellJobs(starting: boolean): void {
    if (this.shellJobs.size < MAX_SHELL_JOBS) return
    for (const job of [...this.shellJobs.values()].sort((left, right) => left.startedAt - right.startedAt)) {
      if (job.finishedAt !== undefined) {
        if (job.timer !== undefined) clearTimeout(job.timer)
        this.shellJobs.delete(job.jobId)
        return
      }
    }
    if (!starting) return
    throw new Error(
      `${MAX_SHELL_JOBS} background jobs are already running. Wait for one to finish or call shell_kill; `
      + 'this plugin does not silently stop a job you started.',
    )
  }
}

/**
 * Identify an image by its magic bytes.
 *
 * Sniffing the content rather than trusting the extension is deliberate: a file
 * named `.png` that holds a JPEG would otherwise be labelled wrongly and the
 * client would fail to decode it. `undefined` means "not an image we carry".
 */
function detectImageMime(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...expected: number[]): boolean =>
    bytes.length >= offset + expected.length && expected.every((byte, index) => bytes[offset + index] === byte)
  const ascii = (offset: number, length: number): string =>
    bytes.length >= offset + length
      ? Buffer.from(bytes.subarray(offset, offset + length)).toString('latin1')
      : ''

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 4) === 'GIF8') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  return undefined
}

/**
 * Bound one promise in wall-clock time.
 *
 * Used for catalog discovery: an adapter that answers remotely must not make a
 * diagnostic hang. The timeout rejects with a message naming the work, which the
 * caller records as an unavailable catalog entry.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not answer within ${timeoutMs} ms`))
    }, timeoutMs)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Turn whatever the shell service returned into a foreground result.
 *
 * Two shapes exist: 0.1.5's `run()` resolves the result directly, and 0.1.7+ `execute()`
 * resolves a live handle whose `result()` is the foreground projection. The
 * handle is also the background process, so this helper is the only place that
 * distinguishes them.
 */
async function settleShellResult(launched: DshShellRunResult | DshShellExecution): Promise<DshShellRunResult> {
  const handle = launched as DshShellExecution
  if (typeof handle.result === 'function') {
    const settled = await handle.result()
    if (settled === undefined) {
      throw new Error('the shell execution exposed result() but resolved no foreground result')
    }
    return settled
  }
  // 0.1.5's `run()` resolves the result itself.
  return launched as DshShellRunResult
}

/**
 * Flatten a tool result's content blocks to text.
 *
 * A result is an array of blocks of several kinds; only the text is worth
 * returning through a JSON-RPC payload that already carries `value`, and an
 * image or resource block is summarized rather than dropped silently.
 */
function flattenToolContent(content: readonly unknown[]): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else if (typeof record.type === 'string') parts.push(`[${record.type}]`)
  }
  return parts.join('\n')
}

/**
 * Locate a request's prompt in the durable log.
 *
 * A prompt that has not been committed yet reports `promptIndex: -1`, and one
 * whose turn has not closed reports `settled: false`. That is what makes a
 * queued prompt wait for *its own* turn: a `turn/end` that appears after our
 * user message very often closes a turn that was already running when we
 * prompted — someone typing in the DSH UI, say — and must not be mistaken for
 * ours.
 *
 * Which turn owns the message depends on the delivery mode:
 *
 * - `steer` delivers into the turn that is already open, so the owner is that
 *   turn.
 * - `queue` (the default) prefers the next turn to begin after the message, and
 *   falls back to the open turn when none does. The fallback is the common case,
 *   not an edge one: against a real session log the order is `turn/start` and
 *   *then* `user/message`, because DSH opens the turn before committing the
 *   prompt, so an idle session's queued message has no later `turn/start` at all.
 *   The open turn is used only when it had not already produced output before our
 *   message — otherwise it is answering someone else and a later turn must come.
 */
export function locateTurn(
  events: readonly DshSessionEvent[],
  requestId: string,
  mode: 'queue' | 'steer' = 'queue',
): TurnLocation {
  let promptIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: string; rpcId?: string } } | undefined)?.source
    if (source?.kind === 'user' && source.rpcId === requestId) {
      promptIndex = index
      break
    }
  }

  if (promptIndex < 0) {
    return { promptIndex: -1, from: 0, to: 0, owningTurn: null, settled: false }
  }

  // The turn already open when our message landed: the last `turn/start` before
  // it, unless a `turn/end` already closed that turn.
  let openTurn: number | null = null
  let openTurnIndex = -1
  for (let index = promptIndex - 1; index >= 0; index -= 1) {
    const type = events[index]?.type
    if (type === 'turn/end') break
    if (type === 'turn/start') {
      openTurn = turnOf(events[index])
      openTurnIndex = index
      break
    }
  }

  // The next turn to begin after our message. Activity on a turn *other* than
  // the one already open is a turn that began after us, so it counts even if a
  // `turn/start` was not observed; activity on the open turn belongs to it.
  let nextTurn: number | null = null
  let nextTurnIndex = -1
  for (let index = promptIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'turn/start') {
      nextTurn = turnOf(event)
      nextTurnIndex = index
      break
    }
    if (event?.type === 'assistant/message' || event?.type === 'tool/call') {
      const candidate = turnOf(event)
      if (candidate !== null && candidate !== openTurn) {
        nextTurn = candidate
        nextTurnIndex = index
        break
      }
    }
  }

  // Whether the open turn had already produced output before our message. If it
  // had, our message arrived while that turn was mid-answer, so it cannot be the
  // one that answers us and a later `turn/start` must exist. If it had not, the
  // open turn is one our own message just started — DSH opens the turn before
  // persisting the `user/message`, so this is the ordinary idle-session shape.
  const openTurnHadOutput =
    openTurnIndex >= 0
    && events
      .slice(openTurnIndex + 1, promptIndex)
      .some((entry) => entry?.type === 'assistant/message' || entry?.type === 'tool/call')

  // The next turn is a *preference*, not a requirement. Requiring one made
  // `owningTurn` null for the idle-session shape, which made `settled`
  // permanently false, which made every waiting `session_prompt` sit until its
  // timeout and then report `timedOut: true` on a turn that had in fact
  // completed. When no later turn begins, the open turn is the owner — unless it
  // was already answering someone else.
  const owningTurn =
    mode === 'steer'
      ? (openTurn ?? nextTurn)
      : (nextTurn ?? (openTurnHadOutput ? null : openTurn))

  // Anchoring the slice on the previous turn boundary is only right for a
  // steered message, which joins the open turn. A queued message sits *inside*
  // the span of the turn that was already running, so its own content begins at
  // the message itself — an earlier reply in that same turn predates us and is
  // not ours to report.
  let from: number
  if (mode === 'steer' && openTurnIndex >= 0) {
    from = openTurnIndex + 1
  } else if (nextTurn !== null && nextTurn === owningTurn && nextTurnIndex >= 0) {
    from = nextTurnIndex
  } else if (owningTurn !== null && owningTurn === openTurn) {
    from = promptIndex
  } else {
    from = 0
    for (let index = promptIndex - 1; index >= 0; index -= 1) {
      const type = events[index]?.type
      if (type === 'turn/end' || type === 'turn/start') {
        from = index + 1
        break
      }
    }
  }

  let endIndex = -1
  if (owningTurn !== null) {
    for (let index = promptIndex + 1; index < events.length; index += 1) {
      const event = events[index]
      if (event?.type === 'turn/end' && turnOf(event) === owningTurn) {
        endIndex = index
        break
      }
    }
  }

  return {
    promptIndex,
    from,
    to: endIndex >= 0 ? endIndex + 1 : events.length,
    owningTurn,
    settled: endIndex >= 0,
  }
}

/**
 * Report wait progress, swallowing a callback failure.
 *
 * Counting tool calls means walking this turn's slice, not the whole log: the
 * slice is one turn's activity, and a progress ping must stay cheaper than the
 * work it reports on.
 */
function reportProgress(
  onProgress: ((progress: TurnProgress) => void) | undefined,
  events: readonly DshSessionEvent[],
  location: TurnLocation,
  startedAt: number,
  settled: boolean,
): void {
  if (onProgress === undefined) return
  // A ping before our prompt is even committed can only say "turn ?", which is
  // noise rather than liveness; the caller learns something once the log shows
  // the turn, and the timeout bound is what covers a prompt that never commits.
  if (!settled && location.promptIndex < 0) return
  let toolCalls = 0
  if (location.promptIndex >= 0) {
    for (const event of events.slice(location.from, location.to)) {
      if (event.type === 'tool/call') toolCalls += 1
    }
  }
  const newest = events.at(-1)
  const idleMs = newest === undefined ? 0 : Math.max(0, Date.now() - newest.time)
  try {
    onProgress({ turn: location.owningTurn, toolCalls, elapsedMs: Date.now() - startedAt, idleMs, settled })
  } catch {
    // A progress ping is advisory; never let it fail the prompt.
  }
}

/** Project one located turn onto the caller-facing result. */
/** `provider/model` from one assistant message's source, when it names a route. */
function routeOf(source: { provider?: unknown; model?: unknown } | undefined): string | undefined {
  if (typeof source?.provider !== 'string' || source.provider === '') return undefined
  if (typeof source.model !== 'string' || source.model === '') return undefined
  return `${source.provider}/${source.model}`
}

/**
 * Whether the log ends inside a turn.
 *
 * A `turn/start` with no matching `turn/end` means the agent is still working, so
 * any usage folded from this log is a snapshot rather than a total. Tracked with a
 * counter instead of a boolean so a malformed log with two starts cannot report
 * "closed" after one end.
 */
function hasOpenTurn(events: readonly DshSessionEvent[]): boolean {
  let open = 0
  for (const event of events) {
    if (event.type === 'turn/start') open += 1
    else if (event.type === 'turn/end') open = Math.max(0, open - 1)
  }
  return open > 0
}

/**
 * Derive the durable request id used for one prompt.
 *
 * With no key it is random, which is the original behaviour. With a key it is
 * derived, so a retry lands on the same id and can be matched against the log. The
 * harness stores this string as `source.rpcId` on the user message, so a derived id
 * must be a plain identifier: anything outside the allowed set is rejected instead
 * of being smuggled into the session log.
 */
function idempotencyRequestId(key: string | undefined): string {
  if (key === undefined) return `dsh-as-mcp-${randomUUID()}`
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
    throw new Error(
      'idempotencyKey may contain only letters, digits, dot, underscore, colon and hyphen (1-200 characters)',
    )
  }
  return `dsh-as-mcp-idem-${key}`
}

/** Find our own previously admitted user message in a session log. */
function findOwnPrompt(
  events: readonly DshSessionEvent[],
  requestId: string,
): { text: string; images: number } | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data as { content?: unknown; source?: { rpcId?: unknown } } | undefined
    if (data?.source?.rpcId !== requestId) continue
    const blocks = Array.isArray(data.content) ? data.content : []
    const images = blocks.filter((block) => (block as { type?: unknown } | undefined)?.type === 'image').length
    return { text: textOfBlocks(data.content), images }
  }
  return undefined
}

/**
 * Apply the caller's requested detail level to one turn's tool calls.
 *
 * The full list is built first because argument *sizes* are wanted in every mode;
 * only the strings are dropped or cut here.
 */
/** Lowercase hex SHA-256 of a UTF-8 string, for compare-and-swap file writes. */
function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Content hash for one directory entry, or the reason it could not be produced.
 *
 * A listing that silently hashed only what it could read would look complete while
 * hiding the files a change-detector most needs to see, so an unavailable hash says
 * why instead of being omitted.
 */
async function hashEntry(
  fs: DshFileSystem,
  target: DshFsTarget,
  limit: number | undefined,
): Promise<{ sha256?: string; sha256Unavailable?: string }> {
  const info = await fs.stat(target)
  if (limit !== undefined && info?.size !== undefined && info.size > limit) {
    return { sha256Unavailable: `above the ${limit}-byte hash ceiling` }
  }
  try {
    return { sha256: sha256OfText(await fs.readText(target)) }
  } catch (error) {
    return { sha256Unavailable: error instanceof Error ? error.message : String(error) }
  }
}

/** Current UTF-8 text of a file, or `undefined` when it is not a readable file. */
async function readCurrentText(
  fs: DshFileSystem,
  target: DshFsTarget,
): Promise<string | undefined> {
  const info = await fs.stat(target)
  if (info === undefined || info.type !== 'file') return undefined
  try {
    return await fs.readText(target)
  } catch {
    return undefined
  }
}

function shapeToolCalls(
  summary: Omit<TurnResult, 'timedOut'>,
  detail: ToolCallDetail,
  maxArgumentChars: number | undefined,
): Omit<TurnResult, 'timedOut'> {
  if (detail === 'none') return { ...summary, toolCalls: [] }
  const limit = Math.max(100, maxArgumentChars ?? 4_000)
  return {
    ...summary,
    toolCalls: summary.toolCalls.map((call) => {
      const { arguments: raw, ...rest } = call
      if (detail === 'summary') {
        // `argumentsBytes` already reports the size; nothing else is needed.
        return rest
      }
      const text = raw ?? ''
      if (text.length <= limit) return { ...rest, arguments: text }
      return { ...rest, arguments: text.slice(0, limit), truncated: true }
    }),
  }
}

/** Cut text to a character budget, leaving no partial surrogate pair. */
/**
 * The end of a string, at most `limit` UTF-16 units, without splitting a surrogate
 * pair. Used when a caller asks for the tail of a long tool result (a stack trace
 * ends with the error, not with the first line).
 */
function tailText(text: string, limit: number): string {
  if (text.length <= limit) return text
  let start = text.length - limit
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return text.slice(start)
}

/**
 * Normalise a caller's command line to the `/name args` form the registry parses.
 *
 * Callers write both `"compact"` and `"/compact"`; the registry only accepts the
 * slash form, and a leading slash the caller already typed must not be doubled.
 */
function normalizeCommandLine(input: string): string {
  const trimmed = input.trim()
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** Project one diff file onto the bounded listing row. */
function forgeFileSummary(file: DshForgeDiffFile): ForgeFileSummary {
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    binary: file.binary,
    oversized: file.oversized,
    untracked: file.untracked,
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.hunks.length,
  }
}

/** Project one change-request diff onto the bounded listing. */
function forgeDiffSummary(
  diff: DshForgeChangeRequestDiff,
  maxFiles: number,
): ForgeDiffSummary {
  return {
    headSha: diff.headSha,
    files: diff.files.slice(0, maxFiles).map(forgeFileSummary),
    localAhead: diff.localAhead,
    ...(diff.files.length > maxFiles ? { truncated: true as const } : {}),
  }
}

/**
 * Project one session binding plus its optional fresh reads.
 *
 * A binding without a snapshot is still reported: its `failure` is exactly what the
 * panel shows (for example "not authenticated"), and dropping it would make an
 * unauthenticated binding look like no binding at all.
 */
function forgeViewOf(
  binding: DshSessionChangeRequest,
  diff?: ForgeDiffSummary,
  checksStale?: boolean,
): ForgeChangeView {
  const snapshot = binding.update?.snapshot
  const common = {
    url: binding.url,
    origin: binding.origin,
    ...(binding.ref === null
      ? {}
      : { number: binding.ref.number, repository: binding.ref.repository }),
    ...(binding.update === null ? {} : { fetchedAt: binding.update.fetchedAt }),
    ...(binding.update?.failure === undefined
      ? {}
      : { failure: { code: binding.update.failure.code, message: binding.update.failure.message } }),
    ...(diff === undefined ? {} : { diff }),
    ...(checksStale === true ? { checksStale: true as const } : {}),
  }
  if (snapshot === undefined) return common
  return {
    ...common,
    title: snapshot.title,
    state: snapshot.state,
    draft: snapshot.draft,
    author: snapshot.author,
    headBranch: snapshot.headBranch,
    headSha: snapshot.headSha,
    baseBranch: snapshot.baseBranch,
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    mergeability: snapshot.mergeability,
    mergeReady: snapshot.mergeReady,
    mergeMethods: snapshot.mergeMethods,
    reviewDecision: snapshot.reviewDecision,
    checksRollup: snapshot.checksRollup,
    ...(snapshot.checksTruncated === undefined ? {} : { checksTruncated: snapshot.checksTruncated }),
    unresolvedThreads: snapshot.unresolvedThreads,
    updatedAt: snapshot.updatedAt,
    closedAt: snapshot.closedAt,
    checks: snapshot.checks.map((check) => ({
      name: check.name,
      state: check.state,
      url: check.url,
      workflow: check.workflow,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    })),
  }
}

/**
 * Build the service timing from at most one caller-supplied form.
 *
 * Accepting several at once would silently prefer one; admitting exactly one keeps
 * the reply explainable. `afterSeconds` is the "once, in N seconds" case and
 * `everySeconds` the fixed-interval case; neither is expressible as an RRULE the
 * caller would enjoy writing by hand.
 */
function scheduleTimingOf(request: {
  rrule?: string
  afterSeconds?: number
  everySeconds?: number
}): DshScheduleTiming {
  const given = [
    request.rrule === undefined ? undefined : 'rrule',
    request.afterSeconds === undefined ? undefined : 'afterSeconds',
    request.everySeconds === undefined ? undefined : 'everySeconds',
  ].filter((entry): entry is string => entry !== undefined)
  if (given.length === 0) {
    throw new Error(
      'a schedule needs one timing form: rrule (a DTSTART line and an RRULE line), afterSeconds (once, N seconds '
        + 'from now), or everySeconds (a fixed interval)',
    )
  }
  if (given.length > 1) {
    throw new Error(`a schedule takes exactly one timing form; received ${given.join(', ')}`)
  }
  if (request.rrule !== undefined) {
    const rrule = request.rrule.trim()
    if (!rrule.includes('RRULE:')) {
      throw new Error(
        'schedule rrule must contain an RRULE line, e.g. "DTSTART;TZID=Asia/Singapore:20260901T080000'
          + '\nRRULE:FREQ=DAILY;COUNT=3"',
      )
    }
    return { kind: 'rrule', rrule }
  }
  if (request.afterSeconds !== undefined) {
    if (!Number.isFinite(request.afterSeconds) || request.afterSeconds < 1) {
      throw new Error('afterSeconds must be a positive number of seconds')
    }
    return { kind: 'after', after_seconds: request.afterSeconds }
  }
  const everySeconds = request.everySeconds as number
  if (!Number.isFinite(everySeconds) || everySeconds < 1) {
    throw new Error('everySeconds must be a positive number of seconds')
  }
  return { kind: 'every', every_seconds: everySeconds }
}

/** Project one `ScheduleEditResult` onto the shape the tool reports. */
function scheduleEditOutcome(
  id: string,
  result: DshScheduleEditResult,
): { updated?: true; deleted?: true; found: boolean; conflict?: true; id: string; task?: DshScheduleEntry } {
  if ('code' in result) {
    if (result.code === 'schedule_conflict') return { found: true, conflict: true, id }
    return { found: false, id }
  }
  if ('deleted' in result) return { found: false, deleted: true, id }
  return { found: true, updated: true, id, task: result }
}

/** Project the harness's `GoalView` onto the fields this endpoint reports. */
function projectGoal(goal: DshGoalView): SessionGoalView {
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    activation: goal.activation,
    maxGoalRounds: goal.maxGoalRounds,
    roundsStarted: goal.roundsStarted,
    ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  }
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text
  let cut = limit
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return text.slice(0, cut)
}

/** UTF-8 byte length without allocating a Buffer for ordinary ASCII. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** The reply shape for a wait that observed a failure instead of a turn. */
function emptyTurnSummary(): Omit<TurnResult, 'timedOut' | 'usage'> {
  return {
    reply: '',
    replyChars: 0,
    models: [],
    toolCalls: [],
    turn: null,
    turnEndReason: null,
    aborted: false,
  }
}

/** What a status long-poll treats as a change; timings and tokens are reports, not state. */
function statusSignature(status: SessionStatus): string {
  return [
    status.running,
    status.openTurn,
    status.openStep,
    status.lastEventSeq,
    status.failure?.kind ?? '',
    // Entering (or leaving) a worktree changes what the next turn works on, so a
    // held `session_status { waitMs }` must report it as a change.
    status.workingDirectory ?? '',
    status.worktree?.path ?? '',
  ].join('|')
}

/**
 * Unwrap the single result of a 0.2.2+ tool batch.
 *
 * This plugin sends a batch of exactly one call, so exactly one result is
 * expected. Anything else is a contract violation and is reported as one rather
 * than silently answering "no result" for a call that may have run.
 */
function toolBatchResultOf(output: unknown): DshToolExecutionResult {
  const results = (output as { readonly results?: unknown } | undefined)?.results
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('the harness tool executor answered without a result for the call')
  }
  const result = (results[0] as { readonly result?: unknown } | undefined)?.result
  if (typeof result !== 'object' || result === null
    || typeof (result as { readonly isError?: unknown }).isError !== 'boolean') {
    throw new Error('the harness tool executor answered with an unrecognized result shape')
  }
  return result as DshToolExecutionResult
}

/**
 * Pick the two session views this plugin reports out of a projection value map.
 *
 * `workingDirectory` is a base-bundle projection (a string or null);
 * `forgeWorktree` only exists when the forge bundle registers it, hence the
 * tolerant record parse. An absent key means "not reported", never "not in a
 * worktree", so an unknown profile shape degrades silently instead of claiming a
 * directory.
 */
function viewsOfProjectionValues(values: Readonly<Record<string, unknown>> | undefined): SessionViews {
  if (values === undefined) return {}
  const directory = values['workingDirectory']
  const worktree = worktreeInfoOf(values['forgeWorktree'])
  return {
    ...(directory === null || typeof directory === 'string' ? { workingDirectory: directory } : {}),
    ...(worktree === undefined ? {} : { worktree }),
  }
}

/** Characters of message content a feed event carries; the transcript has the rest. */
const FEED_SUMMARY_CHARS = 240

/** First text blocks of a message-shaped payload, joined and truncated. */
function feedTextOf(data: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (data === undefined) return undefined
  const message = (data['message'] ?? data) as Readonly<Record<string, unknown>> | undefined
  const content = message?.['content']
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const entry = block as { readonly type?: unknown; readonly text?: unknown }
    if (entry.type === 'text' && typeof entry.text === 'string' && entry.text !== '') texts.push(entry.text)
  }
  if (texts.length === 0) return undefined
  return truncateText(texts.join(' '), FEED_SUMMARY_CHARS)
}

/**
 * Project one durable event onto the bounded shape the events feed reports.
 *
 * The projection is deliberately lossy: a feed event says what happened and how
 * it ended, not what the whole message or tool result contained. Content stays in
 * `session_messages`/`session_tool_result`, which have their own bounds.
 */
function projectSessionEvent(event: DshSessionEvent): SessionEventFeedEvent {
  const data = (typeof event.data === 'object' && event.data !== null ? event.data : undefined) as
    | Readonly<Record<string, unknown>>
    | undefined
  const turn = typeof data?.['turn'] === 'number' ? data['turn'] as number : undefined
  const step = typeof data?.['step'] === 'number' ? data['step'] as number : undefined
  const base: SessionEventFeedEvent = {
    seq: event.seq,
    type: event.type,
    at: isoOfEventTime(event.time) ?? new Date(0).toISOString(),
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  }
  switch (event.type) {
    case 'user/message':
    case 'assistant/message': {
      const summary = feedTextOf(data)
      return summary === undefined ? base : { ...base, summary }
    }
    case 'tool/call': {
      const name = data?.['name']
      return typeof name === 'string' ? { ...base, summary: `called ${name}` } : base
    }
    case 'tool/result': {
      const message = data?.['message'] as Readonly<Record<string, unknown>> | undefined
      const isError = message?.['isError'] === true || data?.['isError'] === true
      return isError ? { ...base, error: true } : base
    }
    case 'turn/end': {
      const reason = data?.['reason'] as { readonly kind?: unknown } | undefined
      const kind = typeof reason?.kind === 'string' ? reason.kind : undefined
      if (kind === undefined) return base
      return {
        ...base,
        summary: `turn ended: ${kind}`,
        ...(kind === 'completed' ? {} : { error: true }),
      }
    }
    default:
      return base
  }
}

/** Projection values this plugin reports beside a session's live state. */
interface SessionViews {
  readonly workingDirectory?: string | null
  readonly worktree?: WorktreeInfo | null
}

/**
 * Validate the harness's `forgeWorktree` projection value.
 *
 * That projection is written by the DSH UI's forge panel (it records the worktree
 * *the panel created* for a session) and is absent from profiles whose UI never
 * offers the option, so this is deliberately a tolerant parse: anything that is
 * not a complete record means "no worktree record", never an error.
 */
function worktreeInfoOf(value: unknown): WorktreeInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const { path, branch, baseCommit, repositoryRoot } = record
  if (typeof path !== 'string' || typeof branch !== 'string'
    || typeof baseCommit !== 'string' || typeof repositoryRoot !== 'string') {
    return undefined
  }
  return {
    path,
    branch,
    baseCommit,
    repositoryRoot,
    from: typeof record.from === 'string' ? record.from : null,
  }
}

function summarizeTurn(
  events: readonly DshSessionEvent[],
  location: TurnLocation,
): Omit<TurnResult, 'timedOut'> {
  if (location.promptIndex < 0) {
    return { reply: '', replyChars: 0, models: [], toolCalls: [], turn: null, turnEndReason: null, aborted: false }
  }

  const replies: string[] = []
  const toolCalls: ToolCallInfo[] = []
  const models: string[] = []
  let turn = location.owningTurn
  let turnEndReason: unknown = null
  let turnStartedAt: number | undefined
  let turnEndedAt: number | undefined

  for (const event of events.slice(location.from, location.to)) {
    if (event.type === 'assistant/message') {
      if (turn === null) turn = turnOf(event)
      const data = event.data as {
        message?: { content?: unknown; source?: { provider?: unknown; model?: unknown } }
      } | undefined
      const route = routeOf(data?.message?.source)
      if (route !== undefined && !models.includes(route)) models.push(route)
      const text = textOfBlocks(data?.message?.content)
      if (text.trim() !== '') replies.push(text)
    } else if (event.type === 'tool/call') {
      if (turn === null) turn = turnOf(event)
      const data = event.data as { name?: string; arguments?: string; callId?: string } | undefined
      const raw = typeof data?.arguments === 'string' ? data.arguments : ''
      toolCalls.push({
        name: typeof data?.name === 'string' ? data.name : 'unknown',
        argumentsBytes: byteLength(raw),
        arguments: raw,
        ...(typeof data?.callId === 'string' ? { callId: data.callId } : {}),
      })
    } else if (event.type === 'turn/start') {
      if (turnStartedAt === undefined && (turn === null || turnOf(event) === turn)) {
        turnStartedAt = event.time
      }
    } else if (event.type === 'turn/end') {
      turnEndReason = (event.data as { reason?: unknown } | undefined)?.reason ?? null
      turnEndedAt = event.time
    }
  }

  // The idle-session shape commits `turn/start` BEFORE the user message (and the
  // slice starts at the message), so the start event is outside it. Walk back to it,
  // stopping at a turn boundary: the turn that owns our message began there.
  if (turnStartedAt === undefined && turn !== null) {
    for (let index = location.from - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'turn/end') break
      if (event?.type === 'turn/start') {
        if (turnOf(event) === turn) turnStartedAt = event.time
        break
      }
    }
  }

  const reply = replies.join('\n\n')
  return {
    reply,
    replyChars: reply.length,
    models,
    toolCalls,
    turn,
    turnEndReason,
    aborted: isAbortedReason(turnEndReason),
    // Only when both ends were seen inside this window: a turn cut by the window
    // boundary has no honest duration, and a missing field says that.
    ...(turnStartedAt === undefined || turnEndedAt === undefined
      ? {}
      : { durationMs: Math.max(0, turnEndedAt - turnStartedAt) }),
  }
}
