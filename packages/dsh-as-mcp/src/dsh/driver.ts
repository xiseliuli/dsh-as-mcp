import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolveAbsolute } from 'node:path'

import type { Config } from '../config.js'
import { optional } from '../config.js'
import { DEFAULT_AGENT_TOOLS } from '../defaults.js'
import {
  eventsOf,
  loggerOf,
  serviceOf,
  type DshAgentRegistry,
  type DshFileSystem,
  type DshLogger,
  type DshSessionController,
  type DshSessionEvent,
  type DshAgentHandle,
  type DshSessionQuery,
  type DshSandboxPolicy,
  type DshToolRegistry,
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
      // `workspaceRegistry.create()` canonicalizes through realpath and rejects a
      // missing directory; it deliberately does not mkdir.
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
  }): Promise<{
    sessionId: string
    cwd?: string
    agentPreset?: string
    model?: string
    /** Set when the session was created but its requested model was not applied. */
    modelSelectionError?: string
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
        modelSelectionError = error instanceof Error ? error.message : String(error)
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

    return {
      sessionId: created.sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
      ...(selected === undefined ? {} : { model: selected }),
      ...(modelSelectionError === undefined ? {} : { modelSelectionError }),
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
   */
  async listAgentTools(request: { sessionId?: string }): Promise<{
    tools: { name: string; description: string; parameters: Record<string, unknown> }[]
    sessionId?: string
    /** Set when a session was named but could not be scoped to an agent. */
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
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(scopeError === undefined ? {} : { scopeError }),
    }
  }

  /**
   * Run one harness tool through the production pipeline.
   *
   * The allow-list is re-checked here rather than trusted from the listing: a
   * caller can name any tool it likes, and `execute` would happily run one that
   * was never advertised.
   */
  async callAgentTool(request: {
    name: string
    args?: unknown
    sessionId?: string
    signal?: AbortSignal
    timeoutMs: number
  }): Promise<{
    name: string
    ok: boolean
    value?: unknown
    /** Text blocks the tool produced, flattened. */
    text: string
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

    const { agent } = await this.resolveScope(request.sessionId)
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
        ...(agent === undefined ? {} : { agent }),
        signal: controller.signal,
      })
      const text = flattenToolContent(result.content)
      if (result.isError) {
        return { name: request.name, ok: false, text, error: result.error.message }
      }
      return { name: request.name, ok: true, value: result.value, text }
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
   * Resolve the scope a tool call runs under.
   *
   * A named session scopes the call to that session's live agent, so the harness
   * applies that session's policy and the call appears in its transcript. Without
   * one, the call is agentless and the harness falls back to the deployment
   * default — the same resolution this plugin's own `file_*` and `shell_run`
   * already use.
   */
  private async resolveScope(sessionId?: string): Promise<{
    agent?: DshAgentHandle
    scopeError?: string
  }> {
    if (sessionId === undefined) return {}
    const controller = this.requireSessionController()
    if (typeof controller.resolveAgent !== 'function') {
      return { scopeError: 'this DSH profile cannot resolve a session to an agent; the call ran unscoped' }
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

    // One byte past the cap, so a file exactly at the cap reads whole and one
    // byte more proves truncation. `readByteRange` is the read that can do this:
    // `readBytes` REJECTS with `FS_TOO_LARGE` when the file exceeds its cap
    // rather than truncating, so using it here made `truncated` unreachable and
    // turned every file over the cap into an error.
    const bytes = await fs.readByteRange(target, { offset: 0, length: request.maxBytes + 1 })
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
    // Deliberately no `node:fs` mkdir here, even when `createDirectories` is set.
    // Creating the parent ourselves would run *before* `fs.resolve`, and therefore
    // before the sandbox backend's `checkedTarget`: under the fail-safe `read-only`
    // default it would create directories the policy forbids, and under
    // `workspace-write` a symlinked ancestor would land them outside the root
    // before the write itself was refused. It is also unnecessary — the seam's
    // atomic write already does `mkdir(dirname(target), { recursive: true })`
    // inside the fence (`fs-local/src/fsio.ts:578-580`). `createDirectories` is
    // kept in the schema because it is a no-op that documents intent, not because
    // the driver acts on it.
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
    // `run` on the shipped harness, `execute` from 0.1.7-rc.2 onward, which drops
    // `run` altogether. Call whichever the host actually has.
    const launch = shell.run ?? shell.execute
    if (launch === undefined) {
      throw new Error('the shell service exposes neither run() nor execute(); cannot run a command')
    }
    const result = await launch.call(shell, spec)
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
