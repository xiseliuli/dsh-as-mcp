/**
 * Structural contracts for the DeepSeek Harness services this plugin consumes.
 *
 * These are deliberately hand-written and *minimal* instead of importing
 * `@deepseek-ai/dsh-*` types. Two reasons:
 *
 * 1. DSH gates a plugin on the `peerDependencies` it declares for
 *    `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`: every declared range must match
 *    the single running runtime version. Declaring none imposes no constraint,
 *    so this plugin loads across harness releases instead of pinning one.
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

/** `ctx.sessionQuery` — packages/session-query/session-query/src/index.ts */
export interface DshSessionQuery {
  readSession(sessionId: string): Promise<{
    readonly session: { readonly id: string; readonly cwd?: string; readonly agentPreset?: string }
    readonly inheritedEventCount: number
    readonly events: readonly DshSessionEvent[]
  }>
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
   * Admit one user message. Resolves as soon as the message is queued; it does
   * not wait for the turn to run.
   */
  prompt(
    request: {
      readonly requestId: string
      readonly sessionId: string
      readonly mode: 'queue' | 'steer'
      readonly content: readonly { readonly type: 'text'; readonly text: string }[]
      readonly clientTimeZone?: string
    },
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true }>

  cancel(request: { readonly sessionId: string }): { readonly accepted: true }

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

/** `ctx.shell` — packages/shell/shell/src/index.ts + src/types.ts */
export interface DshShellExecutor {
  resolve(request: {
    command: string
    workdir?: string
    timeoutMs?: number
    stdoutMaxBytes?: number
    signal?: AbortSignal
  }): unknown
  /**
   * Run a resolved spec to completion.
   *
   * The method was renamed across harness versions: 0.1.5-rc.1 — the one shipped
   * in DSH Desktop — exposes `run`, while 0.1.7-rc.2 replaces it with `execute`
   * and drops `run` and `start` altogether, so a plugin calling `run` there dies
   * with "not a function". Both are declared optional and the driver picks
   * whichever the running host provides, the same way the filesystem seam
   * straddles `readBytes` and `readByteRange`.
   */
  run?(spec: unknown): Promise<DshShellRunResult>
  execute?(spec: unknown): Promise<DshShellRunResult>
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
