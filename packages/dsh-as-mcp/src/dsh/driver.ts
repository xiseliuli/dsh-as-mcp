import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve as resolveAbsolute } from 'node:path'

import type { Config } from '../config.js'
import { optional } from '../config.js'
import {
  eventsOf,
  loggerOf,
  serviceOf,
  type DshAgentRegistry,
  type DshFileSystem,
  type DshLogger,
  type DshSessionController,
  type DshSessionEvent,
  type DshSessionQuery,
  type DshShellExecutor,
  type DshWorkspaceRegistry,
} from './types.js'

/** How often a prompt wait re-reads the durable session log. */
const TURN_POLL_INTERVAL_MS = 200

/** Resolve after `ms`, without holding the event loop open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
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
}

/** One tool invocation the agent made while answering. */
export interface ToolCallInfo {
  readonly name: string
  readonly arguments: string
  readonly callId?: string
}

/** The settled outcome of one driver-initiated agent turn. */
export interface TurnResult {
  readonly reply: string
  readonly toolCalls: readonly ToolCallInfo[]
  readonly turn: number | null
  readonly turnEndReason: unknown
  /** True when the wait bound elapsed before the turn settled. */
  readonly timedOut: boolean
  /** True when the turn ended because it was cancelled. */
  readonly aborted: boolean
}

/** One message projected onto the caller-facing transcript. */
export interface TranscriptMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
  readonly seq: number
}

/** One directory entry. */
export interface DirectoryEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** A tool name the driver can serve, used to advertise capability gating. */
export type DriverTool = 'workspace' | 'session' | 'files' | 'shell'

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

  /** Capabilities the running profile actually provides, for diagnostics. */
  describeCapabilities(): Record<string, boolean> {
    return {
      workspaceRegistry: this.workspaceRegistry() !== undefined,
      sessionController: this.sessionController() !== undefined,
      sessionQuery: this.sessionQuery() !== undefined,
      agents: this.agentRegistry() !== undefined,
      fs: this.fileSystem() !== undefined,
      shell: this.shellExecutor() !== undefined,
      webServer: serviceOf<unknown>(this.ctx, 'webServer') !== undefined,
      events: typeof eventsOf(this.ctx).on === 'function',
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

  private agentRegistry(): DshAgentRegistry | undefined {
    return serviceOf<DshAgentRegistry>(this.ctx, 'agents')
  }

  private fileSystem(): DshFileSystem | undefined {
    return serviceOf<DshFileSystem>(this.ctx, 'fs')
  }

  private shellExecutor(): DshShellExecutor | undefined {
    return serviceOf<DshShellExecutor>(this.ctx, 'shell')
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
      // `workspaceRegistry.create()` canonicalizes through realpath and rejects a
      // missing directory; it deliberately does not mkdir. `ctx.fs` exposes no
      // mkdir either, so this is the one place the driver touches node:fs.
      await mkdir(absolute, { recursive: true })
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

  /** Create a session bound to a workspace (or a bare directory) and pick its model. */
  async createSession(request: {
    workspaceId?: string
    cwd?: string
    agentPreset?: string
    provider?: string
    model?: string
  }): Promise<{ sessionId: string; cwd?: string; agentPreset?: string; model?: string }> {
    const controller = this.requireSessionController()

    const workspaceId = request.workspaceId
    let cwd = request.cwd
    if (workspaceId === undefined && cwd === undefined) {
      throw new Error('provide either workspaceId or cwd when creating a session')
    }
    if (workspaceId !== undefined) {
      const workspace = this.requireWorkspaceRegistry().get(workspaceId)
      if (workspace === undefined) throw new Error(`unknown workspaceId: ${workspaceId}`)
      cwd = workspace.path
    }

    const agentPreset = optional(request.agentPreset) ?? optional(this.config.session.agentPreset)
    const created = await controller.create({
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    })
    this.ownedSessions.add(created.sessionId)

    const provider = optional(request.provider) ?? optional(this.config.session.provider)
    const model = optional(request.model) ?? optional(this.config.session.model)
    let selected: string | undefined
    if (provider !== undefined && model !== undefined) {
      const result = await controller.selectModel({ sessionId: created.sessionId, provider, model })
      selected = `${result.selected.provider}/${result.selected.model}`
    } else if (provider !== undefined || model !== undefined) {
      this.log.warn('[dsh-as-mcp] provider and model must be set together; ignoring partial selection')
    }

    return {
      sessionId: created.sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
      ...(selected === undefined ? {} : { model: selected }),
    }
  }

  /** Live session summaries, most recently updated first. */
  async listSessions(limit: number): Promise<SessionInfo[]> {
    const controller = this.requireSessionController()
    const listed = await controller.list({}, new AbortController().signal)
    return listed.items.slice(0, limit).map((item) => ({
      sessionId: item.sessionId,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      running: item.running,
      blank: item.blank,
      updatedAt: item.updatedAt,
    }))
  }

  /**
   * Submit one user message and, by default, wait for its turn to settle.
   *
   * Turns on one session are serialized, so two concurrent MCP callers cannot
   * interleave prompts and then disagree about which reply belongs to which
   * request.
   */
  async promptSession(request: {
    sessionId: string
    prompt: string
    mode: 'queue' | 'steer'
    wait: boolean
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ accepted: true; turn?: TurnResult }> {
    return await this.enqueueTurn(request.sessionId, async () => {
      const controller = this.requireSessionController()
      // The harness records this id as `source.rpcId` on the committed user
      // message, which is how the wait below identifies *our* turn.
      const requestId = `dsh-as-mcp-${randomUUID()}`

      await controller.prompt(
        {
          requestId,
          sessionId: request.sessionId,
          mode: request.mode,
          content: [{ type: 'text', text: request.prompt }],
        },
        request.signal ?? new AbortController().signal,
      )
      if (!request.wait) return { accepted: true as const }

      const timeoutMs = request.timeoutMs ?? this.config.session.promptTimeoutMs
      const deadline = Date.now() + timeoutMs

      for (;;) {
        const events = await this.readEvents(request.sessionId)
        const location = locateTurn(events, requestId, request.mode)

        if (location.settled) {
          const summary = summarizeTurn(events, location)
          return { accepted: true as const, turn: { ...summary, timedOut: false } }
        }

        if (request.signal?.aborted === true) {
          return {
            accepted: true as const,
            turn: { ...summarizeTurn(events, location), timedOut: false, aborted: true },
          }
        }

        if (Date.now() >= deadline) {
          return {
            accepted: true as const,
            turn: { ...summarizeTurn(events, location), timedOut: true },
          }
        }

        await delay(TURN_POLL_INTERVAL_MS)
      }
    })
  }

  /** Ask the live agent to cancel its current turn. */
  cancelSession(sessionId: string): { accepted: true } {
    return this.requireSessionController().cancel({ sessionId })
  }

  /** The caller-facing transcript of one session. */
  async readTranscript(sessionId: string, limit: number): Promise<TranscriptMessage[]> {
    const events = await this.readEvents(sessionId)
    const messages: TranscriptMessage[] = []
    for (const event of events) {
      if (event.type === 'user/message') {
        const text = textOfBlocks((event.data as { content?: unknown } | undefined)?.content)
        if (text.trim() !== '') {
          messages.push({ role: 'user', text, time: event.time, seq: event.seq })
        }
      } else if (event.type === 'assistant/message') {
        const data = event.data as { message?: { content?: unknown } } | undefined
        const text = textOfBlocks(data?.message?.content)
        if (text.trim() !== '') {
          messages.push({ role: 'assistant', text, time: event.time, seq: event.seq })
        }
      }
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
  // Files
  // ---------------------------------------------------------------------------

  /** Read one UTF-8 file through the harness filesystem seam. */
  async readFile(request: { path: string; cwd?: string; maxBytes: number }): Promise<{
    path: string
    text: string
    truncated: boolean
  }> {
    const fs = this.requireFileSystem()
    const target = await fs.resolve(request.path, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    })
    const info = await fs.stat(target)
    if (info?.type === 'directory') throw new Error(`${target.displayPath} is a directory; use file_list`)

    const bytes = await fs.readBytes(target, undefined, request.maxBytes + 1)
    const truncated = bytes.byteLength > request.maxBytes
    const slice = truncated ? bytes.subarray(0, request.maxBytes) : bytes
    return {
      path: fs.processPath(target),
      text: new TextDecoder('utf-8', { fatal: false }).decode(slice),
      truncated,
    }
  }

  /** Write one UTF-8 file, creating parent directories when asked. */
  async writeFile(request: {
    path: string
    content: string
    cwd?: string
    createDirectories: boolean
  }): Promise<{ path: string; operation: 'create' | 'update' }> {
    const fs = this.requireFileSystem()
    if (request.createDirectories) {
      const absolute = isAbsolute(request.path)
        ? request.path
        : resolveAbsolute(request.cwd ?? process.cwd(), request.path)
      const parent = resolveAbsolute(absolute, '..')
      // As in createWorkspace: the fs seam exposes no mkdir.
      await mkdir(parent, { recursive: true })
    }
    const target = await fs.resolve(request.path, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    })
    const outcome = await fs.writeText(target, request.content)
    return { path: fs.processPath(target), operation: outcome.operation }
  }

  /** List one directory through the harness filesystem seam. */
  async listDirectory(request: { path: string; cwd?: string }): Promise<{
    path: string
    entries: DirectoryEntry[]
  }> {
    const fs = this.requireFileSystem()
    const target = await fs.resolve(request.path, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    })
    const entries = await fs.listDir(target)
    return {
      path: fs.processPath(target),
      entries: entries
        .map((entry) => ({
          name: entry.name,
          type: entry.type,
          ...(entry.size === undefined ? {} : { size: entry.size }),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
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
    const result = await shell.run(spec)
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
 * - `queue` (the default) appends a new turn, so the owner is the next
 *   `turn/start` to appear after the message.
 * - `steer` delivers into the turn that is already open, so the owner is the
 *   turn that was open when the message landed.
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

  const owningTurn = mode === 'steer' ? (openTurn ?? nextTurn) : nextTurn

  // Anchoring the slice on the previous turn boundary is only right for a
  // steered message, which joins the open turn. A queued message sits *inside*
  // the span of the turn that was already running, so its own content begins at
  // its own turn's start — anchoring on the boundary would fold that running
  // turn's reply into ours.
  let from: number
  if (mode === 'steer' && openTurnIndex >= 0) {
    from = openTurnIndex + 1
  } else if (nextTurn === owningTurn && nextTurnIndex >= 0) {
    from = nextTurnIndex
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

/** Project one located turn onto the caller-facing result. */
function summarizeTurn(
  events: readonly DshSessionEvent[],
  location: TurnLocation,
): Omit<TurnResult, 'timedOut'> {
  if (location.promptIndex < 0) {
    return { reply: '', toolCalls: [], turn: null, turnEndReason: null, aborted: false }
  }

  const replies: string[] = []
  const toolCalls: ToolCallInfo[] = []
  let turn = location.owningTurn
  let turnEndReason: unknown = null

  for (const event of events.slice(location.from, location.to)) {
    if (event.type === 'assistant/message') {
      if (turn === null) turn = turnOf(event)
      const data = event.data as { message?: { content?: unknown } } | undefined
      const text = textOfBlocks(data?.message?.content)
      if (text.trim() !== '') replies.push(text)
    } else if (event.type === 'tool/call') {
      if (turn === null) turn = turnOf(event)
      const data = event.data as { name?: string; arguments?: string; callId?: string } | undefined
      toolCalls.push({
        name: typeof data?.name === 'string' ? data.name : 'unknown',
        arguments: typeof data?.arguments === 'string' ? data.arguments : '',
        ...(typeof data?.callId === 'string' ? { callId: data.callId } : {}),
      })
    } else if (event.type === 'turn/end') {
      turnEndReason = (event.data as { reason?: unknown } | undefined)?.reason ?? null
    }
  }

  return {
    reply: replies.join('\n\n'),
    toolCalls,
    turn,
    turnEndReason,
    aborted: isAbortedReason(turnEndReason),
  }
}
