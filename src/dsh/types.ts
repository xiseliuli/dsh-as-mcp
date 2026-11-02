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

  inspect(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly meta: { readonly id: string; readonly cwd?: string; readonly agentPreset?: string }
    readonly inheritedEventCount: number
    readonly events: readonly DshSessionEvent[]
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
 * `ctx.tools` — packages/core/tools/src/index.ts
 *
 * `execute` runs the full production pipeline: pre-policy, guards, around-dispatch,
 * post-policy and final notification. That is the point of routing through it
 * rather than calling a service directly — the permission model travels with the
 * call, so an external caller gets exactly the decisions the agent would get.
 */
export interface DshToolRegistry {
  schemas(scope?: unknown): DshToolSchema[]
  execute(exec: {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly agent?: DshAgentHandle
    readonly signal: AbortSignal
  }): Promise<DshToolExecutionResult>
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
