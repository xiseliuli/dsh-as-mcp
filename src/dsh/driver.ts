import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, dirname, resolve as resolveAbsolute } from 'node:path'

import type { Config } from '../config.js'
import { optional } from '../config.js'
import { DEFAULT_AGENT_TOOLS } from '../defaults.js'
import { combineCosts, readSessionCost, type CostReport } from './cost.js'
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
} from './types.js'

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
  readonly scope: 'session' | 'sessionIds' | 'pluginSessions' | 'allSessions'
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
  /** True on the final update, when the turn has settled or the wait gave up. */
  readonly settled: boolean
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
  readonly role: 'user' | 'assistant'
  /** The message text, cut to the caller's per-message cap when one was given. */
  readonly text: string
  readonly time: number
  readonly seq: number
  /** Length of the text before any cap. */
  readonly chars: number
  /** True when `text` was cut to the requested per-message cap. */
  readonly truncated?: boolean
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

/** Whether a durable `turn/end` reason records a cancellation. */
function isAbortedReason(reason: unknown): boolean {
  if (reason === null || typeof reason !== 'object') return false
  return (reason as { kind?: unknown }).kind === 'aborted'
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
  /** Sessions this plugin created, so an opt-in approver can be scoped to them. */
  private readonly ownedSessions = new Set<string>()
  /** Per-session promise chain: one driver-initiated turn runs at a time. */
  private readonly turnQueues = new Map<string, Promise<unknown>>()
  /** Background shell jobs by id, in start order. */
  private readonly shellJobs = new Map<string, ShellJobState>()
  private shellJobSeq = 0

  constructor(
    private readonly ctx: unknown,
    private readonly configSource: () => Config,
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
    return this.ownedSessions.has(sessionId)
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
      // controller's own `inspect` fallback). Reported separately from
      // `sessionQuery` because "sessions work but their usage cannot be read" is
      // a real profile shape a caller should be able to see.
      tokenUsage: query !== undefined || this.sessionController() !== undefined,
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
      sessionRename: typeof (this.sessionController() as { rename?: unknown } | undefined)?.rename === 'function',
      sessionModel: typeof (this.sessionController() as { selectModel?: unknown } | undefined)?.selectModel === 'function',
      // Forking is a controller operation, not a store one.
      sessionFork: typeof (this.sessionController() as { fork?: unknown } | undefined)?.fork === 'function',
      // Background jobs need a launcher: `start` on 0.1.5, `execute` from 0.1.7.
      shellBackground: (() => {
        const shell = this.shellExecutor()
        return typeof shell?.start === 'function' || typeof shell?.execute === 'function'
      })(),
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
    const created = await controller.create({
      ...(workspaceId === undefined ? { cwd: cwd as string } : { workspaceId }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    this.ownedSessions.add(created.sessionId)

    const provider = optional(request.provider) ?? optional(this.config.session.provider)
    const model = optional(request.model) ?? optional(this.config.session.model)
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
      this.log.warn('[dsh-as-mcp] provider and model must be set together; ignoring partial selection')
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
    }
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

  /** Live session summaries, most recently updated first. */
  /**
   * Session summaries, newest first.
   *
   * `includeTitle` opts into one durable-log read per session to fold its latest
   * title — cheap for a handful of sessions and pointless for a page of 200, which
   * is why it is off by default. A title that cannot be read is omitted rather
   * than failing the listing.
   */
  async listSessions(
    limit: number,
    options: {
      includeTitle?: boolean
      /** Only sessions whose workspace directory is this one (canonicalised). */
      cwd?: string
      /** Only sessions that are currently running (`true`) or idle (`false`). */
      running?: boolean
    } = {},
  ): Promise<SessionInfo[]> {
    const controller = this.requireSessionController()
    const listed = await controller.list({}, new AbortController().signal)
    // The filter runs before the limit so "the first 20 of my sessions" means what
    // it says; a limit applied first would return whatever happened to be recent.
    const cwd = options.cwd === undefined ? undefined : await this.canonicalFilterPath(options.cwd)
    const filtered = listed.items.filter((item) => {
      if (options.running !== undefined && item.running !== options.running) return false
      if (cwd !== undefined && item.cwd !== cwd) return false
      return true
    })
    const items = filtered.slice(0, limit)
    const titles = options.includeTitle === true ? await this.readTitles(items.map((item) => item.sessionId)) : new Map()
    return items.map((item) => ({
      sessionId: item.sessionId,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      running: item.running,
      blank: item.blank,
      updatedAt: item.updatedAt,
      ...(titles.get(item.sessionId) === undefined ? {} : { title: titles.get(item.sessionId) as string }),
    }))
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
    return await this.enqueueTurn(request.sessionId, async () => {
      const controller = this.requireSessionController()
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
      const earlier = request.idempotencyKey === undefined
        ? undefined
        : findOwnPrompt(await this.readEvents(request.sessionId), requestId)
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
        return await this.finishPrompt(request, requestId, true)
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
      return await this.finishPrompt(request, requestId, false)
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
      for (;;) {
        const events = await this.readEvents(request.sessionId)
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
  cancelSession(sessionId: string): { accepted: true } {
    return this.requireSessionController().cancel({ sessionId })
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
  }): Promise<{
    sessionId: string
    parentSessionId: string
    inheritedEventCount: number
    cwd?: string
    approvalPolicy?: 'never'
    approvalPolicyError?: string
  }> {
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
      ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }),
    })
    this.ownedSessions.add(child.sessionId)
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
      role?: 'user' | 'assistant'
      /** Per-message character cap; absent means full text (the historical default). */
      maxCharsPerMessage?: number
    } = {},
  ): Promise<TranscriptMessage[]> {
    const events = await this.readEvents(sessionId)
    const messages: TranscriptMessage[] = []
    for (const event of events) {
      const role = event.type === 'user/message'
        ? 'user' as const
        : event.type === 'assistant/message' ? 'assistant' as const : undefined
      if (role === undefined) continue
      if (options.role !== undefined && options.role !== role) continue
      if (options.sinceSeq !== undefined && event.seq <= options.sinceSeq) continue
      const text = role === 'user'
        ? textOfBlocks((event.data as { content?: unknown } | undefined)?.content)
        : textOfBlocks((event.data as { message?: { content?: unknown } } | undefined)?.message?.content)
      if (text.trim() === '') continue
      const cap = options.maxCharsPerMessage
      const truncated = cap !== undefined && text.length > cap
      messages.push({
        role,
        text: truncated ? truncateText(text, cap) : text,
        time: event.time,
        seq: event.seq,
        chars: text.length,
        ...(truncated ? { truncated: true } : {}),
      })
    }
    return messages.slice(-limit)
  }

  /**
   * The durable session log.
   *
   * `sessionQuery` is the purpose-built reader; `sessionController.inspect` is
   * the fallback for a composition that mounts the controller without it.
   */
  private async readEvents(sessionId: string): Promise<readonly DshSessionEvent[]> {
    const query = this.sessionQuery()
    if (query !== undefined) {
      const snapshot = await query.readSession(sessionId)
      return snapshot.events
    }
    const inspected = await this.requireSessionController().inspect(sessionId)
    return inspected.events
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
   *    composition that mounts the controller without the query service.
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
    if (controller !== undefined) {
      try {
        const inspected = await controller.inspect(sessionId)
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
      'this DSH profile provides no session log reader (sessionQuery or sessionController), '
        + 'so token usage cannot be read for any session.',
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
    all?: boolean
    includeSubagents?: boolean
    includeTurns?: boolean
    /** Read money from cost-meter; false skips the ledger on a large scan. */
    includeCost?: boolean
    limit: number
  }): Promise<SessionUsageReport> {
    const includeSubagents = request.includeSubagents ?? true
    const includeTurns = request.includeTurns ?? false
    const includeCost = request.includeCost ?? true
    const notes: string[] = []
    const rows: SessionUsageRow[] = []
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

    /** Append a row once; the last rows beyond the cap set `truncatedRows`. */
    const addRow = async (
      sessionId: string,
      origin: 'self' | 'subagent',
      parentSessionId?: string,
    ): Promise<void> => {
      if (rows.some((row) => row.sessionId === sessionId)) return
      if (rows.length >= MAX_USAGE_ROWS) {
        truncatedRows = true
        return
      }
      rows.push(await this.usageRow(sessionId, origin, includeTurns, parentSessionId, includeCost))
    }

    if (request.sessionIds !== undefined && request.sessionIds.length > 0) {
      if (request.sessionId !== undefined || request.all === true) {
        throw new Error('pass sessionIds, sessionId, or all — not more than one of them')
      }
      scope = 'sessionIds'
      // Duplicates would double-count a row's tokens in the totals, and a caller
      // assembling ids from logs routinely repeats one.
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
    } else if (request.sessionId !== undefined) {
      scope = 'session'
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
          notes.push(
            'No session was created through this endpoint in the current DSH process. '
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
  ): Promise<SessionUsageRow> {
    try {
      const cut = await this.readUsageCut(sessionId)
      const report = buildUsageReport(cut, {
        includeTurns,
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
    const timer = setTimeout(() => controller.abort(), request.timeoutMs)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()

    try {
      const result = await registry.execute({
        callId: `dsh-as-mcp-${randomUUID()}`,
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
          error: truncateText(result.error.message, 2_000),
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
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', relay)
    }
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
    return {
      path: fs.processPath(target),
      text: new TextDecoder('utf-8', { fatal: false }).decode(slice),
      truncated,
      offset,
      bytes: slice.byteLength,
      ...(truncated ? { nextOffset: offset + slice.byteLength } : {}),
      ...(info?.size === undefined ? {} : { size: info.size }),
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
  }): Promise<{ path: string; operation: 'create' | 'update' }> {
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
    const outcome = await fs.writeText(target, request.content)
    return { path: fs.processPath(target), operation: outcome.operation }
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
  }): Promise<{
    path: string
    replacements: number
    bytesBefore: number
    bytesAfter: number
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
      return {
        path: root,
        entries: entries
          .map((entry) => ({
            name: entry.name,
            type: entry.type,
            ...(entry.size === undefined ? {} : { size: entry.size }),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
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

  /** Background jobs, newest first. */
  listShellJobs(): ShellJobSummary[] {
    return [...this.shellJobs.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((job) => this.summarizeShellJob(job))
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
    if (read.delta !== '') job.buffer += read.delta
    if (read.lossy) job.truncated = true
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
  try {
    onProgress({ turn: location.owningTurn, toolCalls, elapsedMs: Date.now() - startedAt, settled })
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
    } else if (event.type === 'turn/end') {
      turnEndReason = (event.data as { reason?: unknown } | undefined)?.reason ?? null
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
  }
}
