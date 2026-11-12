/**
 * Structural contracts for the DeepSeek Harness services this plugin consumes.
 *
 * These are deliberately hand-written and *minimal* instead of importing
 * `@deepseek-ai/dsh-*` types. Two reasons:
 *
 * 1. No `@deepseek-ai/*` package is imported here, so nothing in this file can
 *    disagree with the harness that is actually running. The manifest does
 *    declare two optional peers — `@deepseek-ai/dsh` and
 *    `@deepseek-ai/schemastery` — but they are there for resolution, not for
 *    types: DSH folds `peerDependencies` into the module-fallback graph it
 *    builds for a profile (`app-boot`'s `profileDependencyNames`), which is how
 *    `settings.ts`'s dynamic `import('@deepseek-ai/schemastery')` finds the
 *    module. An optional peer that fails to install degrades instead of
 *    breaking a load-time import, and neither peer is a type source.
 * 2. The published `@deepseek-ai/dsh-*` npm artifacts are far behind the
 *    harness that ships inside the Desktop app, so npm types would be wrong.
 *
 * Everything below was verified against harness `dsh-v0.1.5-rc.1` (the version
 * bundled with DSH Desktop 2.0.9). Each member carries the source path it came
 * from so a future reader can re-verify it cheaply.
 */

/** `ctx.workspaceRegistry` — packages/workspace/workspace/src/index.ts */
export interface DshWorkspace {
  /** Stable uuid; never the path. */
  readonly id: string
  /** Canonical absolute directory path. */
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
  setTitle(title: string): Promise<void>
  status(): Promise<'ok' | 'missing-dir'>
}

/** `ctx.workspaceRegistry` */
export interface DshWorkspaceRegistry {
  /**
   * Register an existing directory as a workspace.
   * The directory must already exist: the path is canonicalized through
   * `realpath`, and a relative, missing, or non-directory path rejects.
   */
  create(path: string, title?: string): Promise<DshWorkspace>
  get(id: string): DshWorkspace | undefined
  list(): DshWorkspace[]
  delete(id: string): Promise<boolean>
  resolveByPath(path: string): Promise<DshWorkspace | undefined>
  /**
   * Archive / unarchive one session — the registry-global set the DSH sidebar's
   * archive feature writes. Archiving also drops the session's pin; archiving a
   * session with running work is refused unless `stopActivity` is set.
   *
   * Optional because this is 0.1.7+ surface: an older host simply cannot archive.
   */
  archiveSession?(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
  unarchiveSession?(sessionId: string): Promise<void>
  /** Pin / unpin one session — the registry-global set behind the sidebar's pin. */
  pinSession?(sessionId: string): Promise<void>
  unpinSession?(sessionId: string): Promise<void>
  /** Archived session ids, most recently archived first (0.1.7+). */
  readonly archivedSessionIds?: readonly string[]
  /** Pinned session ids, in pin order (0.1.7+). */
  readonly pinnedSessionIds?: readonly string[]
}

/** One entry of `ctx.sessionController.list()`. */
export interface DshSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly cwd?: string
  /** Whether a live agent currently holds this session (0.2.2+). */
  readonly agentAvailable?: boolean
  /**
   * Summary projection hints folded into the listing — 0.2.2's `SessionSummary`.
   *
   * This is what makes `session_list { includeWorktree }` free: the listing
   * already carries the summary projections, including `workingDirectory` and the
   * forge bundle's `forgeWorktree`, so no per-session read is needed when they are
   * present.
   */
  readonly projections?: {
    readonly kind: 'cached' | 'sequenced'
    readonly asOfSeq: number
    /** `Partial<SessionProjectionSummaryValues>` — a partial map of projection views. */
    readonly values: Readonly<Record<string, unknown>>
  }
}

/** One durable session event as returned by `ctx.sessionQuery.readSession()`. */
export interface DshSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/**
 * One provider-reported token usage sample — `TokenUsage` in
 * `packages/llm/llm/src/types.ts`.
 *
 * The buckets are disjoint: `inputTokens` is the *uncached* prompt, cache reads
 * and writes are separate charges, and `reasoningTokens` is a subset of
 * `outputTokens`. `totalTokens` is the provider's own full-call total when it
 * reported a self-consistent one; it is deliberately not the field this plugin
 * bills against (see `usage.ts`).
 */
export interface DshTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/**
 * The `tokenUsage` session projection's wire view —
 * `TokenUsageProjection` in `packages/llm/token-meter/src/projection.ts`.
 *
 * Different field names from {@link DshTokenUsage} on purpose (that is the
 * harness's own naming, `uncachedInputTokens` for the disjoint use of
 * `inputTokens`), which is why the two are separate types here rather than one
 * with optional aliases.
 */
export interface DshTokenUsageProjection {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** `ProjectionSnapshot` from `packages/session/session-projection/src/index.ts` (`snapshot()`). */
export interface DshProjectionSnapshot {
  /** Seq of the last event every value reflects; `-1` for an empty log. */
  readonly asOfSeq: number
  /** Whole current client value per registered key. */
  readonly values: Partial<Record<string, unknown>>
}

/**
 * `SessionObservation` from
 * `SessionObservation` in `packages/session-query/session-query/src/observation.ts`.
 *
 * A caller-owned lease over one immutable cut of a session; `Disposable`
 * releases it, and not releasing it pins the prepared-session cache. Only the
 * fields this plugin reads are declared.
 */
export interface DshSessionObservation extends Disposable {
  /** Whether the cut came from an attached session or a retained preparation. */
  readonly source: 'live' | 'prepared'
  readonly header: {
    readonly id: string
    readonly cwd?: string
    readonly createdAt?: number
    /** Set when this session is a subagent child. */
    readonly origin?: 'subagent'
    /** Fork lineage, not subagent parentage. */
    readonly parentSession?: string
  }
  readonly inheritedEventCount: number
  readonly events: readonly DshSessionEvent[]
  /** Last observed event seq, `-1` for an empty log. */
  readonly cursor: number
  /** Projection baseline at {@link cursor}, when the projection registry is mounted. */
  readonly projections?: DshProjectionSnapshot
  /** Retain the same immutable cut for another owner. */
  retain?(): DshSessionObservation
}

/** `ctx.sessionQuery` — packages/session-query/session-query/src/index.ts */
export interface DshSessionQuery {
  readSession(sessionId: string): Promise<{
    readonly session: { readonly id: string; readonly cwd?: string; readonly agentPreset?: string }
    readonly inheritedEventCount: number
    readonly events: readonly DshSessionEvent[]
  }>

  /**
   * Observe one live **or persisted-only** session, with its projections.
   *
   * This is the read this plugin prefers for usage: it is the only one that
   * answers for a session that has left the live store, and `projections` gives
   * the harness's own cumulative `tokenUsage` for cross-checking the log fold.
   * Added in 0.1.5-rc.1 (`packages/session-query/session-query/src/index.ts:140`);
   * declared optional because a profile may mount an older `sessionQuery`, and a
   * missing method must degrade to {@link DshSessionQuery.readSession}, not throw.
   */
  observeSession?(
    sessionId: string,
    options?: {
      readonly signal?: AbortSignal
      /** `all` computes every projection; `none` leaves projection state untouched. */
      readonly projectionMode?: 'all' | 'none'
    },
  ): Promise<DshSessionObservation>

  /**
   * Fold the latest title of one live-or-persisted session —
   * `SessionTitleObservation` in `packages/session-query/session-query/src/types.ts`.
   *
   * Declared optional: a harness without the title package still lists sessions,
   * it just cannot name them. Reading a title costs one corpus observation, which
   * is why `session_list` asks for it only when the caller opts in.
   */
  readTitleSnapshot?(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly session: { readonly id: string }
    readonly title?: { readonly title: string; readonly eventSeq?: number }
  }>
}

/** One part of a prompt's content: the text, or an image the harness supports. */
export type DshPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    readonly data: string
    readonly name?: string
  }

/** `ctx.sessionController` — packages/api/session-controller/src/index.ts */
export interface DshSessionController {
  create(request: {
    readonly workspaceId?: string
    readonly cwd?: string
    readonly sessionId?: string
    readonly agentPreset?: string
  }): Promise<{ readonly sessionId: string; readonly agentPreset?: string }>

  list(
    request: unknown,
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly DshSessionSummary[] }>

  selectModel(request: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ readonly selected: { readonly provider: string; readonly model: string } }>

  /**
   * Resolve the live agent driving a session, or report why it cannot be.
   *
   * This is the bridge that makes the agent's *own* tools reachable: the returned
   * agent is the scope key `ctx.tools` resolves visibility against, so without it
   * a caller can start a turn and read the log but cannot address the toolbox the
   * turn would use. The harness resolves sessions this way for its own host API
   * domains (`packages/api/session-controller/src/agent.ts:149-162`, which is how
   * `ctx.tools`, `ctx.commands` and `ctx.skills` are reached in-process).
   *
   * Optional because it is additive across versions: a host without it simply
   * reports the capability as absent.
   */
  resolveAgent?(sessionId: string): Promise<DshAgentResolution>

  /**
   * Admit one user message. Resolves as soon as the message is queued; it does
   * not wait for the turn to run.
   */
  prompt(
    request: {
      readonly requestId: string
      readonly sessionId: string
      readonly mode: 'queue' | 'steer'
      /**
       * Text and, from the harness's attachment support, images. The image shape is
       * `PromptContentPart`'s image variant in
       * `packages/api/session-controller/src/types.ts`: base64 `data` with one of
       * `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
       */
      readonly content: readonly DshPromptPart[]
      readonly clientTimeZone?: string
    },
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true }>

  cancel(request: { readonly sessionId: string }): { readonly accepted: true }

  /**
   * Mutate one pending queued message (edit/remove/steer), addressed by message id.
   *
   * Optional like the other additive members: a profile without it simply cannot
   * retract queued work.
   */
  updateQueue?(request: {
    readonly sessionId: string
    readonly itemId: string
    readonly action:
      | { readonly kind: 'edit'; readonly content: readonly unknown[] }
      | { readonly kind: 'remove' }
      | { readonly kind: 'steer' }
  }): Promise<{ readonly accepted: true }>

  /**
   * Literal content search over visible sessions, without activating any of them.
   *
   * Optional: it needs `sessionQuery` on the host, and a profile without that
   * reports the capability as absent rather than failing the whole tool set.
   */
  search?(
    request: { readonly query: string },
    signal: AbortSignal,
  ): Promise<{
    readonly items: readonly { readonly sessionId: string; readonly snippet: string }[]
    readonly hasMore: boolean
  }>

  /**
   * Read one session's current projection values without resuming its agent —
   * `@Remote('projections')` in DSH 0.2.2.
   *
   * Cold-safe and activation-free, which is why it is the preferred exact read for
   * the live working directory and the forge worktree record. `null` means the
   * session's projections are absent; `migration-required` carries cached hints.
   */
  projections?(
    request: { readonly sessionId: string },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'sequenced'; readonly asOfSeq: number; readonly values: Readonly<Record<string, unknown>> }
    | { readonly kind: 'migration-required'; readonly values: Readonly<Record<string, unknown>> }
    | null
  >

  /**
   * Read one session's durable log through the controller.
   *
   * **Removed in DSH 0.2.2** (together with `page`); declared optional for the
   * older versions this plugin still loads on. 0.2.2's replacement,
   * {@link events}, serves one message-aligned history page rather than the whole
   * log, so it is a UI-facing read and is used only where a page is enough.
   */
  inspect?(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly meta: { readonly id: string; readonly cwd?: string; readonly agentPreset?: string }
    readonly inheritedEventCount: number
    readonly events: readonly DshSessionEvent[]
  }>

  /**
   * Read one cold-safe, message-aligned history page — `@Remote('events')` in
   * 0.2.2's session controller.
   *
   * The page carries `records: [{type: 'event', event}]`; it is bounded by the
   * harness's page budget, so it is not a whole-log reader.
   */
  events?(
    request: {
      readonly address: { readonly kind: 'session'; readonly sessionId: string }
      readonly throughSeq?: number
      readonly beforeSeq?: number
      readonly maxMessages?: number
    },
    signal: AbortSignal,
  ): Promise<{
    readonly records: readonly { readonly type: string; readonly event?: DshSessionEvent }[]
    readonly hasMore?: boolean
    readonly cursor?: number
  }>
}

/** `ctx.agents` — packages/core/agent/src/index.ts */
export interface DshAgent {
  readonly status: 'idle' | 'running'
  readonly session?: { readonly id: string }
  whenIdle(): Promise<void>
  cancel(cause: { readonly kind: string }, options?: { readonly keepInbox?: boolean }): void
}

/** `ctx.agents` */
export interface DshAgentRegistry {
  get(sessionId: string): DshAgent | undefined
}

/** One model a provider route advertises — `LlmModelInfo` in packages/llm/llm/src/types.ts. */
export interface DshLlmModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** `LlmProviderInfo` — packages/llm/llm/src/types.ts. */
export interface DshLlmProviderInfo {
  /** Provider route key a caller passes as `session_create.provider`. */
  readonly id: string
  /** Human-readable name for selectors and diagnostics. */
  readonly name: string
}

/**
 * `ctx.llm` — packages/llm/llm/src/index.ts.
 *
 * Only the catalog read is declared: `listProviders()` is synchronous and
 * returns the routes with a **registered adapter**, which is exactly what a
 * caller may name. `listModels()` is deliberately absent — it can perform remote
 * model discovery, and a diagnostics tool must not trigger network work.
 */
export interface DshLlmRegistry {
  listProviders?(): readonly DshLlmProviderInfo[]
  /** Models the adapter advertises for one route; may perform remote discovery. */
  listModels?(provider: string): Promise<readonly DshLlmModelInfo[]>
}

/** `AgentPreset` — packages/preset/agent-preset-registry/src/preset.ts. */
export interface DshAgentPresetInfo {
  /** Preset id a caller passes as `session_create.agentPreset`. */
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Set when the preset failed to compose; such a preset cannot be selected. */
  readonly broken?: string
}

/** `ctx.agentPresets` — packages/preset/agent-preset-registry/src/index.ts. */
export interface DshAgentPresetRegistry {
  /** The preset used when a caller names none. */
  readonly defaultId?: string
  list?(): Promise<readonly DshAgentPresetInfo[]>
}

/**
 * `ctx.permissionPresets` — packages/interaction/permission-presets/src/index.ts.
 *
 * `names` is the advertised preset roster (a getter, not a method). `current()`
 * needs a live `Session` object and is not used here.
 */
export interface DshPermissionPresets {
  readonly names?: readonly string[]
}

/**
 * One ledger row `dsh-cost-meter` reports for a session —
 * `dsh-cost-meter/lib/typert.host.js` (`sessionSchema`).
 *
 * Only the fields this plugin reads are declared. The token counts here are
 * cost-meter's own bookkeeping and are deliberately NOT used: this plugin folds
 * tokens from the durable log instead, so there is one arithmetic path that can
 * be reviewed and tested. Money is the only thing borrowed.
 */
export interface DshCostMeterSession {
  readonly id: string
  /** LLM calls booked for the session: turns, compaction, and titling. */
  readonly calls: number
  /** List-price USD estimate (cost-meter's `cost`), independent of how it was billed. */
  readonly cost: number
  /**
   * Real-money USD charged (cost-meter's `apiCost`), `0` for a plan-covered
   * call. Absent on ledger rows written before the plan/API split existed.
   */
  readonly apiCost?: number
  /** Frozen FX copies of the estimate; the ledger itself is USD-canonical. */
  readonly costCny?: number
  readonly costEur?: number
}

/**
 * `ctx.costMeter` — the optional host service of the third-party
 * `dsh-cost-meter` plugin (`dsh-cost-meter/lib/index.js:3795`).
 *
 * Declared as an optional, structurally-minimal shim for the same reason as
 * every other service here: the plugin is not part of the harness, may be absent
 * or replaced, and must never be imported. Only the one method this plugin calls
 * is declared.
 */
export interface DshCostMeter {
  /**
   * Price one session.
   *
   * `found: false` means cost-meter's ledger has no row for it — which is a
   * normal answer, not an error.
   */
  getSessionCost?(sessionId: string): Promise<{
    /** This session's own spend (does not merge subagents; this plugin reports those per row). */
    readonly own: DshCostMeterSession
    readonly found: boolean
  }>
}

/** `ctx.fs` resolved target — packages/fs/fs/src/types.ts */
export interface DshFsTarget {
  readonly targetKey: string
  readonly displayPath: string
}

/** `ctx.fs` directory entry */
export interface DshFsDirEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly target: DshFsTarget
  readonly size?: number
}

/** `ctx.fs` stat result */
export interface DshFsInfo {
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** `ctx.fs` — packages/fs/fs/src/index.ts */
export interface DshFileSystem {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<DshFsTarget>
  processPath(target: DshFsTarget): string
  stat(target: DshFsTarget, signal?: AbortSignal): Promise<DshFsInfo | undefined>
  readText(target: DshFsTarget, signal?: AbortSignal): Promise<string>
  /**
   * Read one byte window of a file.
   *
   * Deliberately not `readBytes`: that one *rejects* with `FS_TOO_LARGE` when the
   * file exceeds its cap "instead of returning a truncated result", so it cannot
   * be used to read the head of a large file. The window is the bound here, not
   * the file, which is exactly the semantics a bounded read needs.
   */
  readByteRange(
    target: DshFsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>
  listDir(target: DshFsTarget, signal?: AbortSignal): Promise<readonly DshFsDirEntry[]>
  writeText(target: DshFsTarget, content: string, expected?: unknown, signal?: AbortSignal): Promise<{
    readonly operation: 'create' | 'update'
  }>
}

/** One collected output stream — packages/subprocess/subprocess/src/types.ts */
export interface DshCollectedOutput {
  /** Collected text; the tail of the stream when truncated. */
  readonly text: string
  readonly truncated: boolean
  readonly spillPath?: string
}

/** Result of `ctx.shell.run()` */
export interface DshShellRunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly timeoutMs: number
  readonly stdout: DshCollectedOutput
  readonly stderr: DshCollectedOutput
}

/** One incremental read of a background process's captured output. */
export interface DshShellProcessRead {
  /** Output produced since the previous read (stderr in a marked section). */
  readonly delta: string
  /** True when truncation dropped unread bytes the delta cannot include. */
  readonly lossy: boolean
  /** Full stdout spill file, when stdout truncation occurred and one exists. */
  readonly stdoutSpillPath?: string
  /** Full stderr spill file, when stderr truncation occurred and one exists. */
  readonly stderrSpillPath?: string
}

/**
 * A background process handle — `ShellProcess` in
 * `packages/shell/shell/src/types.ts`.
 *
 * Buffered output stays readable after exit, and `kill()` is idempotent. This is
 * the same object the foreground path now goes through: from 0.1.7-rc.2,
 * `execute()` resolves to a live handle and the foreground projection is its
 * `result()`.
 */
export interface DshShellProcess {
  readonly status: 'running' | 'completed' | 'killed'
  readonly exitCode: number | null
  readonly signal: string | null
  /** Resolves when the process settles; never rejects. */
  readonly done?: Promise<void>
  readOutput(): DshShellProcessRead
  kill(): boolean
}

/** What `execute()` returns from 0.1.7-rc.2 onward: a handle plus its foreground result. */
export interface DshShellExecution extends DshShellProcess {
  /** Settles with the foreground result; rejects only for infrastructure failures. */
  result?(): Promise<DshShellRunResult>
}

/** `ctx.shell` — packages/shell/shell/src/index.ts + src/types.ts */
export interface DshShellExecutor {
  resolve(request: {
    command: string
    workdir?: string
    timeoutMs?: number
    stdoutMaxBytes?: number
    signal?: AbortSignal
    /** Deadline policy at `timeoutMs`; `none` arms no deadline (background jobs). */
    onExpiry?: 'kill' | 'none'
  }): unknown
  /**
   * 0.1.5-rc.1's background entry point: spawn and resolve the handle.
   */
  start?(spec: unknown): DshShellProcess
  /**
   * 0.1.5-rc.1's foreground entry point: run to completion.
   *
   * 0.1.7-rc.2 replaced `run`/`start` with {@link execute}, which resolves to a
   * live {@link DshShellExecution} handle: its `result()` is the foreground
   * projection, and the handle itself is the background process. The live
   * 0.2.1-rc.5 executor behaves exactly that way (`dsh-bash-local`'s
   * `executeArgv`).
   *
   * All three are optional because the plugin straddles versions; the driver
   * picks whichever the running host provides and says so when none exists.
   */
  run?(spec: unknown): Promise<DshShellRunResult>
  execute?(spec: unknown): Promise<DshShellExecution>
}

/**
 * `ctx.sandboxPolicy` — packages/sandbox/sandbox-policy/src/index.ts
 *
 * Read-only use: the plugin consults the deployment's file policy before the one
 * mutation it cannot route through the fs seam (creating a workspace directory).
 */
export interface DshSandboxPolicy {
  readonly defaultMode?: string
  resolve?(request?: unknown): { mode: string }
}

/** `ctx.approval` — packages/interaction/user-approval/src/index.ts */
export interface DshApprovalService {
  setPolicy(agent: unknown, policy: 'ask' | 'never'): void
}

/**
 * Minimal logger contract. Cordis supplies `ctx.logger`; we type only what we
 * call so this package does not depend on the harness's logger declaration.
 */
/** What `sessionController.resolveAgent` reports. */
export type DshAgentResolution =
  | { readonly agent: DshAgentHandle }
  | { readonly error: unknown }

/**
 * A live agent, as far as this plugin is concerned.
 *
 * Opaque on purpose: the only thing done with it is to hand it back to `ctx.tools`
 * as a scope. Nothing here reads its fields, so no `@deepseek-ai/*` shape leaks
 * into this package.
 */
export interface DshAgentHandle {
  readonly [brand]?: never
}
declare const brand: unique symbol

/** When a scheduled task fires — `ScheduleTiming` in the 0.2.2 catalog (the subset this endpoint uses). */
export type DshScheduleTiming =
  | { readonly kind: 'after'; readonly after_seconds: number }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'rrule'; readonly rrule: string }
  | { readonly kind: 'cron'; readonly cron: { readonly expression: string; readonly time_zone: string } }

/**
 * Where a scheduled delivery goes — `ScheduleTargetRequest` in the 0.2.2 catalog.
 *
 * `session` delivers into an existing conversation; `new_once` creates one on the
 * first delivery and reuses it; `new` creates a fresh conversation every time.
 */
export type DshScheduleTargetRequest =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'new_once'; readonly create?: { readonly cwd?: string; readonly agentPreset?: string } }
  | { readonly kind: 'new'; readonly create?: { readonly cwd?: string; readonly agentPreset?: string } }

/** The resolved target of a stored task — `ScheduleTarget`. */
export type DshScheduleTarget =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'new_once'; readonly sessionId: string; readonly create: { readonly cwd?: string; readonly agentPreset?: string } }
  | { readonly kind: 'new'; readonly create: { readonly cwd?: string; readonly agentPreset?: string } }

/**
 * One stored scheduled task — `ScheduleCatalogEntry` in the 0.2.2 catalog.
 *
 * Only the fields this endpoint reports are declared; the timing variant fields
 * (`afterSeconds`, `everySeconds`, `rrule`, `expression`/`timeZone`) arrive on the
 * same object and are projected through {@link DshScheduleEntry}.
 */
export interface DshScheduleEntry {
  readonly id: string
  readonly kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule'
  readonly title: string
  readonly prompt: string
  readonly scheduledAt: string
  readonly scheduledAtLocal?: string
  readonly status: 'active' | 'paused' | 'ended'
  readonly target: DshScheduleTarget
  readonly involvedSessionIds?: readonly string[]
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly executionActive?: true
  readonly lastDelivery?: {
    readonly scheduledAt: string
    readonly deliveredAt: string
    readonly targetSessionId: string
  }
  readonly afterSeconds?: number
  readonly everySeconds?: number
  readonly rrule?: string
  readonly expression?: string
  readonly timeZone?: string
}

/** One page of tasks — `ScheduleListResult`. */
export interface DshScheduleListResult {
  readonly items: readonly DshScheduleEntry[]
  readonly shown: number
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** The result of an edit: the updated entry, a deletion, a miss, or a conflict. */
export type DshScheduleEditResult =
  | DshScheduleEntry
  | { readonly id: string; readonly deleted: true }
  | { readonly id: string; readonly code: 'schedule_not_found' }
  | { readonly id: string; readonly code: 'schedule_conflict' }

/**
 * `ctx.schedule` — the Host's durable task store and delivery engine.
 *
 * Tasks belong to the **Host**, not to a session: `list`/`view`/`edit` reach every
 * task by id and only `target` names a conversation. That is why this endpoint
 * refuses the whole surface under `session.scope: "owned"` — an ownership check
 * cannot be expressed on a host-global record.
 */
export interface DshScheduleService {
  create(
    request: {
      readonly title: string
      readonly prompt: string
      readonly timing: DshScheduleTiming
      readonly target?: DshScheduleTargetRequest
    },
    actorSessionId?: string,
    signal?: AbortSignal,
  ): Promise<DshScheduleEntry>
  list(request?: { readonly active?: boolean; readonly limit?: number; readonly offset?: number }): Promise<DshScheduleListResult>
  view(request: { readonly id: string }): Promise<DshScheduleEntry | { readonly id: string; readonly code: 'schedule_not_found' }>
  edit(request: {
    readonly id: string
    readonly action: 'update' | 'delete'
    readonly patch?: {
      readonly title?: string
      readonly prompt?: string
      readonly timing?: DshScheduleTiming
      readonly target?: DshScheduleTargetRequest
      readonly active?: boolean
    }
    readonly expectedUpdatedAt?: string | null
  }): Promise<DshScheduleEditResult>
  history?(request: {
    readonly id: string
    readonly limit: number
  }): Promise<unknown>
}

/** One slash command a session's agent can run — `CommandDescriptor` in the 0.2.2 catalog. */
export interface DshCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly acceptsAttachments?: boolean }
}

/** The outcome of one command execution — `CommandResult` in the 0.2.2 catalog. */
export type DshCommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string }

/**
 * `ctx.commands` — the slash-command registry.
 *
 * Commands run without a model turn: they parse a line like `/compact` and invoke
 * the registered handler directly. Both entry points are agent-scoped, which is
 * what makes them reachable for a session this endpoint owns.
 */
export interface DshCommandService {
  list(agent: DshAgentHandle): readonly DshCommandDescriptor[]
  execute(
    agent: DshAgentHandle,
    line: string,
    submittedAttachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ readonly commandId: string; readonly result: DshCommandResult } | undefined>
}

/** Durable goal phase — `GoalPhase` in the 0.2.2 catalog. */
export type DshGoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Whether the round driver is currently advancing the goal (`GoalActivation`). */
export type DshGoalActivation = 'armed' | 'disarmed'

/** A goal's identity plus its optimistic-concurrency revision — `GoalRef`. */
export interface DshGoalRef {
  readonly id: string
  readonly revision: number
}

/** One durable goal — `GoalView` in the 0.2.2 catalog. */
export interface DshGoalView extends DshGoalRef {
  readonly objective: string
  readonly phase: DshGoalPhase
  readonly activation: DshGoalActivation
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly blockedReason?: { readonly code: string; readonly message: string }
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * `ctx.goals` — the durable objective store the round driver advances.
 *
 * Every method takes the owning agent, so a goal belongs to one session and the
 * harness refuses a mutation whose `GoalRef.revision` is stale.
 */
export interface DshGoalService {
  get(agent: DshAgentHandle): DshGoalView | undefined
  create(
    agent: DshAgentHandle,
    request: { readonly objective: string; readonly maxGoalRounds?: number },
  ): DshGoalView
  edit(
    agent: DshAgentHandle,
    ref: DshGoalRef,
    request: { readonly objective?: string; readonly maxGoalRounds?: number },
  ): DshGoalView
  pause(agent: DshAgentHandle, ref: DshGoalRef): DshGoalView
  resume(agent: DshAgentHandle, ref: DshGoalRef): DshGoalView
  complete(agent: DshAgentHandle, ref: DshGoalRef): DshGoalView
  clear(agent: DshAgentHandle, ref: DshGoalRef): DshGoalRef
  disarm?(agent: DshAgentHandle): DshGoalView | undefined
}

/**
 * One created worktree — `CreatedWorktree` in
 * `packages/tool/worktree/src/index.ts` (harness 0.2.2-rc.1).
 *
 * The four fields are the canonical identity of the checkout: where it lives,
 * which branch was created for it, the local commit it was pinned to, and the
 * source checkout root it belongs to. They are also exactly what
 * {@link DshWorktreeService.restore} needs, which is why a caller that may need
 * to recover a removed worktree should keep the record it was given.
 */
export interface DshWorktreeRecord {
  /** Canonical absolute checkout path. */
  readonly path: string
  /** The new branch checked out there. */
  readonly branch: string
  /** Full commit object name the checkout was pinned to. */
  readonly baseCommit: string
  /** Canonical top level of the source checkout the worktree belongs to. */
  readonly repositoryRoot: string
}

/** One restored worktree — `RestoredWorktree` in the same package. */
export interface DshRestoredWorktree {
  /** The recorded checkout path that now exists again. */
  readonly path: string
  /** Whether the branch itself had to be recreated at `baseCommit`. */
  readonly branchRecreated: boolean
}

/**
 * `ctx.worktrees` — packages/tool/worktree/src/index.ts (harness 0.2.2-rc.1).
 *
 * Mounted by the forge bundle (DSH Desktop / Web enable it as "变更请求与工作树");
 * a profile without it has no worktree capability at all. Both methods take the
 * **live agent** as their scope: the agent's session selects the source
 * repository and its sandbox policy confines the Git commands, and `create`
 * commits the new checkout as that session's working directory. There is no
 * agentless form, which is why the plugin resolves one through
 * `sessionController.resolveAgent` before calling either.
 */
export interface DshWorktreeService {
  /**
   * Create a fresh branch and checkout at a pinned local revision, then enter it.
   *
   * Existing branches and existing checkout paths fail; uncommitted files stay in
   * the source checkout. The returned record is the canonical one the harness
   * itself reports. `onPhase` receives each stage (`prepare`, `checkout`) before
   * it begins and must not throw.
   */
  create(
    agent: DshAgentHandle,
    request?: {
      /** New branch name, also the checkout directory name; generated when omitted. */
      readonly name?: string
      /** Local commit, branch, or tag; defaults to the source checkout's HEAD. */
      readonly from?: string
    },
    signal?: AbortSignal,
    onPhase?: (phase: 'prepare' | 'checkout') => void,
  ): Promise<DshWorktreeRecord>

  /**
   * Check out a removed worktree again at its recorded directory.
   *
   * The session's own working directory is not changed, and uncommitted changes
   * that were lost with the directory cannot be recovered.
   */
  restore(
    agent: DshAgentHandle,
    request: {
      readonly path: string
      readonly branch: string
      readonly baseCommit: string
      readonly repositoryRoot: string
    },
    signal?: AbortSignal,
    onPhase?: (phase: 'prepare' | 'checkout') => void,
  ): Promise<DshRestoredWorktree>
}

/** One tool as a scope sees it — the model-facing schema, no callbacks. */
export interface DshToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

/** A tool call that ran. Mirrors the harness's `ToolExecutionSuccess`. */
export interface DshToolSuccess {
  readonly isError: false
  readonly value: unknown
  readonly content: readonly unknown[]
}

/** A tool call that was refused or failed. Mirrors `ToolExecutionFailure`. */
export interface DshToolFailure {
  readonly isError: true
  readonly error: { readonly message: string }
  readonly content: readonly unknown[]
}

export type DshToolExecutionResult = DshToolSuccess | DshToolFailure

/**
 * One raw call in the 0.2.2+ batch contract — `ToolCallBlock` in
 * `packages/core/tools/src/types.ts`.
 *
 * `arguments` is the model-facing JSON **string**; the executor parses it and
 * preserves invalid JSON as text, which is why a caller passing structured
 * arguments must serialize them.
 */
export interface DshToolCallBlock {
  readonly type: 'tool-call'
  readonly id: string
  readonly name: string
  readonly arguments: string
}

/** The 0.2.2+ `ctx.tools.execute` input — `ToolBatchInput`. */
export interface DshToolBatchInput {
  readonly calls: readonly DshToolCallBlock[]
  readonly signal: AbortSignal
  readonly agent?: DshAgentHandle
  readonly maxParallelToolCalls?: number
}

/** The 0.2.2+ `ctx.tools.execute` output — `ToolBatchResult`. */
export interface DshToolBatchOutput {
  readonly results: readonly { readonly callId: string; readonly result: DshToolExecutionResult }[]
  readonly concluded?: boolean
}

/** The ≤0.1.7 `ctx.tools.execute` input — `ToolExecutionInput`. */
export interface DshToolExecutionInput {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: DshAgentHandle
  readonly signal: AbortSignal
}

/**
 * `ctx.tools` — packages/core/tools/src/index.ts
 *
 * `execute` runs the full production pipeline: pre-policy, guards, around-dispatch,
 * post-policy and final notification. That is the point of routing through it
 * rather than calling a service directly — the permission model travels with the
 * call, so an external caller gets exactly the decisions the agent would get.
 *
 * **The `execute` contract changed in DSH 0.2.2**: `ToolExecutionInput` (one call,
 * one result) became `ToolBatchInput` (a batch of raw calls) with a
 * `ToolBatchResult` answer. The member is therefore declared `unknown` in and out —
 * the plugin speaks whichever shape the running registry implements, detected by
 * {@link DshToolRegistry.resolve}, which shipped in the same release as the batch
 * executor. Declaring a single shape would be a lie on one of the two versions.
 */
export interface DshToolRegistry {
  schemas(scope?: unknown): DshToolSchema[]
  execute(input: unknown): Promise<unknown>
  /** 0.2.2+: resolve a step's admitted tool set. The batch-contract marker. */
  resolve?(context: unknown): Promise<unknown>
  /** 0.2.2+: resolve one executable definition. */
  executable?(name: string, scope?: unknown, toolSet?: unknown): DshToolDefinition | undefined
  /** 0.2.2+: read visible definitions. */
  definitions?(scope?: unknown, toolSet?: unknown): readonly DshToolDefinition[]
}

/** One registered definition, as `ctx.tools.definitions` reports it. */
export interface DshToolDefinition extends DshToolSchema {
  readonly output?: unknown
}

export interface DshLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Read one service off a Cordis context without forcing it to be a dependency. */
export function serviceOf<T>(ctx: unknown, name: string): T | undefined {
  const get = (ctx as { get?: (key: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  return get.call(ctx, name) as T | undefined
}

/**
 * The event surface of a Cordis context.
 *
 * Typed loosely on purpose: the harness augments `@deepseek-ai/cordis`'s event
 * map through declaration merging, and re-declaring `session/event` here would
 * require depending on the very packages this plugin avoids depending on.
 */
export interface DshEventBus {
  // biome-ignore lint/suspicious/noExplicitAny: see doc comment.
  on(name: string, listener: (...args: any[]) => void): () => boolean
}

/** Narrow a Cordis context to its event surface. */
export function eventsOf(ctx: unknown): DshEventBus {
  return ctx as DshEventBus
}

/** Take `ctx.logger`, falling back to the console outside a Cordis host. */
export function loggerOf(ctx: unknown): DshLogger {
  const logger = (ctx as { logger?: Partial<DshLogger> }).logger
  if (logger !== undefined && typeof logger.info === 'function') {
    return {
      debug: (...args) => logger.debug?.(...args),
      info: (...args) => logger.info?.(...args),
      warn: (...args) => logger.warn?.(...args),
      error: (...args) => logger.error?.(...args),
    }
  }
  return {
    debug: (...args) => console.debug(...args),
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  }
}
