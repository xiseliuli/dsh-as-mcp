import type { Config } from '../src/config.js'
import { DEFAULT_AGENT_TOOLS } from '../src/defaults.js'
import type { EndpointStatus } from '../src/status.js'
import type { DshLogger } from '../src/dsh/types.js'
import type { FeedSurface } from '../src/mcp/feeds.js'
import type { ApprovalBroker } from '../src/mcp/approvals.js'
import { EndpointPushes } from '../src/mcp/push.js'
import { createRequestHandler, startListener, type EndpointHandle } from '../src/mcp/http.js'
import type { ConnectionInfo, McpDriver } from '../src/mcp/tools.js'

export const TOKEN = 'test-token-0123456789'

export const silentLog: DshLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** A driver stub: the MCP layer is what is under test, not the harness. */
export function stubDriver(overrides: Partial<McpDriver> = {}): McpDriver {
  return {
    describeCapabilities: () => ({
      sessionController: true,
      shell: false,
      sessionFork: false,
      sessionRename: false,
      approval: false,
    }),
    ownsSession: (sessionId) => sessionId === 'session-1',
    createWorkspace: async ({ path, title }) => ({
      created: true,
      workspace: {
        id: 'ws-1',
        path,
        title: title ?? 'stub',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sessionCount: 0,
        sessionIds: [],
        status: 'ok',
      },
    }),
    listWorkspaces: async () => [],
    deleteWorkspace: async ({ workspaceId }) => ({ workspaceId, deleted: true }),
    createSession: async () => ({ sessionId: 'session-1' }),
    createWorktree: async ({ sessionId }) => ({
      sessionId,
      path: '/tmp/stub/.agents/worktrees/wt-1',
      branch: 'wt-1',
      baseCommit: '0'.repeat(40),
      repositoryRoot: '/tmp/stub',
      from: null,
    }),
    restoreWorktree: async ({ sessionId, path }) => ({ sessionId, path, branchRecreated: false }),
    listSessions: async () => ({ sessions: [], total: 0 }),
    searchSessions: async () => ({ items: [], hasMore: false }),
    listSessionCommands: async ({ sessionId }) => ({
      sessionId,
      commands: [
        { name: 'compact', description: 'Shrink the conversation', permitted: true },
        { name: 'permission', description: 'Change the permission preset', permitted: false },
      ],
    }),
    runSessionCommand: async ({ sessionId, command }) => ({
      sessionId,
      commandId: 'command-1',
      ok: true,
      text: `ran ${command}`,
    }),
    sessionGoal: async ({ sessionId }) => ({ sessionId, goal: null }),
    createScheduledTask: async ({ title, prompt }) => ({
      task: {
        id: 'schedule-1',
        kind: 'every',
        title,
        prompt,
        scheduledAt: '2026-01-01T00:00:00.000Z',
        status: 'active',
        target: { kind: 'new', create: {} },
        everySeconds: 3600,
      },
    }),
    listScheduledTasks: async () => ({ items: [], shown: 0, total: 0, limit: 20, offset: 0 }),
    viewScheduledTask: async ({ scheduleId }) => ({ found: false, id: scheduleId }),
    editScheduledTask: async ({ scheduleId, action }) => (action === 'delete'
      ? { found: false, deleted: true, id: scheduleId }
      : { found: true, updated: true, id: scheduleId }),
    forgeChanges: async ({ sessionId }) => ({
      sessionId,
      changes: [{
        url: 'https://github.com/example/repo/pull/1',
        origin: 'created',
        number: 1,
        repository: { forge: 'github', host: 'github.com', owner: 'example', name: 'repo' },
        title: 'stub change request',
        state: 'open',
        checksRollup: 'success',
      }],
    }),
    forgeLocalDiff: async ({ sessionId, scope }) => ({
      sessionId,
      scope: scope ?? 'uncommitted',
      base: 'main',
      files: [{
        path: 'src/index.ts',
        previousPath: null,
        status: 'modified',
        binary: false,
        oversized: false,
        untracked: false,
        additions: 3,
        deletions: 1,
        hunks: 1,
      }],
      omitted: 0,
    }),
    forgeBranches: async ({ sessionId }) => ({
      sessionId,
      current: 'main',
      branches: ['main', 'feature'],
    }),
    deleteFile: async ({ path }) => ({ path, deleted: true }),
    moveFile: async ({ source, destination }) => ({
      source,
      destination,
      operation: 'create',
      sourceDeleted: true,
    }),
    renameWorkspace: async ({ workspaceId, title }) => ({ workspaceId, title }),
    moveSessionToWorkspace: async ({ sessionId, workspaceId, action }) => ({
      sessionId,
      workspaceId,
      attached: (action ?? 'attach') === 'attach',
    }),
    reorderSession: async ({ sessionId, workspaceId, beforeSessionId }) => ({
      sessionId,
      workspaceId,
      before: beforeSessionId ?? null,
    }),
    listLiveAgents: async () => ({
      agents: [{ sessionId: 'session-1', status: 'idle', root: true }],
      count: 1,
    }),
    subagentTree: async ({ sessionId }) => ({
      sessionId,
      children: [{ id: 'child-1', createdAt: 1, mode: 'one-shot', label: 'stub child', hasChildren: false }],
    }),
    listSkills: async (_request = {}) => ({
      skills: [{ name: 'stub-skill', description: 'a stub skill', path: '/repo/.dsh/skills/stub/SKILL.md' }],
      complete: true,
    }),
    readSkill: async ({ name }) => ({
      name,
      skill: { name, description: 'a stub skill', content: 'do the thing' },
    }),
    mutateSessionGoal: async ({ sessionId, action }) => ({
      sessionId,
      action,
      goal: action === 'clear'
        ? null
        : {
          id: 'goal-1',
          revision: 1,
          objective: 'stub objective',
          phase: 'active',
          activation: 'armed',
          maxGoalRounds: 8,
          roundsStarted: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ...(action === 'clear' ? { cleared: true } : {}),
    }),
    // A do-nothing status stub: the session is a cold, quiet log with no ending.
    sessionStatus: async ({ sessionId }) => ({
      sessionId,
      running: false,
      openTurn: null,
      openStep: null,
      lastEventSeq: null,
      lastEventAt: null,
      idleMs: null,
      lastTurn: null,
      failure: null,
      stalled: false,
      logReadable: true,
      waitedMs: 0,
    }),
    updateQueue: async (request) => ({ accepted: true, action: request.action }),
    archiveSession: async ({ sessionId }) => ({ sessionId, archived: true as const }),
    unarchiveSession: async ({ sessionId }) => ({ sessionId, archived: false as const }),
    pinSession: async ({ sessionId }) => ({ sessionId, pinned: true as const }),
    unpinSession: async ({ sessionId }) => ({ sessionId, pinned: false as const }),
    readQueue: async () => ({ queued: [] }),
    probeSessionSearch: async () => ({ available: true, matches: 0 }),
    renameSession: async ({ sessionId, title }) => ({ sessionId, title, seq: 1 }),
    setSessionModel: async ({ sessionId, provider, model }) => ({ sessionId, provider, model }),
    forkSession: async ({ sessionId }) => ({
      sessionId: 'session-forked',
      parentSessionId: sessionId,
      inheritedEventCount: 1,
    }),
    promptSession: async () => ({ accepted: true }),
    cancelSession: async () => ({ accepted: true }),
    readTranscript: async () => ({ messages: [], total: 0 }),
    readToolResult: async (request: { sessionId: string; callId?: string; toolName?: string }) => ({
      sessionId: request.sessionId, callId: request.callId ?? 'resolved', chars: 0, text: '',
    }),
    readImage: async ({ path }) => ({
      path,
      mimeType: 'image/png',
      base64: 'iVBORw0KGgo=',
      bytes: 8,
      size: 8,
    }),
    readFile: async ({ path, offset }) => ({
      path,
      text: 'hello',
      truncated: false,
      offset: offset ?? 0,
      bytes: 5,
    }),
    writeFile: async ({ path }) => ({ path, operation: 'create', sha256: 'stub' }),
    editFile: async ({ path }) => ({ path, replacements: 1, bytesBefore: 0, bytesAfter: 0, sha256: 'stub' }),
    listDirectory: async ({ path }) => ({ path, entries: [] }),
    // Present so the new group's tools can be registered; a test that exercises
    // them supplies its own driver.
    listAgentTools: async ({ sessionId }) => ({ tools: [], sessionId }),
    callAgentTool: async ({ name }) => ({ name, ok: true, text: '', resultBytes: 0 }),
    describeCatalog: async () => ({}),
    sessionUsage: async () => ({
      generatedAt: '2026-01-01T00:00:00.000Z',
      scope: 'pluginSessions',
      sessions: [],
      totals: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, steps: 0, samples: 0 },
      byModel: [],
      subagentsIncluded: false,
      cost: { available: false, reason: 'stub' },
      notes: [],
    }),
    runShell: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: 'ok',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
    startShellJob: async ({ command }) => ({
      jobId: 'shell-stub-1',
      command,
      status: 'running' as const,
      startedAt: 0,
      exitCode: null,
      signal: null,
      pendingBytes: 0,
    }),
    listShellJobs: () => [],
    readShellOutput: ({ jobId }) => ({
      jobId,
      status: 'completed' as const,
      exitCode: 0,
      signal: null,
      done: true,
      output: '',
      pendingBytes: 0,
      truncated: false,
      lossy: false,
    }),
    killShellJob: async ({ jobId }) => ({ jobId, killed: true, status: 'killed' as const }),
    ...overrides,
  }
}

/** A complete config with every section filled, overridable per field. */
export function testConfig(overrides: Partial<Config['tools']> = {}, port = 0): Config {
  return {
    http: { enabled: true, host: '127.0.0.1', port, path: '/mcp', mountOnWebServer: false },
    auth: { token: TOKEN },
    tools: { workspace: true, session: true, files: true, shell: false, agentTools: false, usage: false, ...overrides },
    agentTools: { allow: [...DEFAULT_AGENT_TOOLS.allow], deny: [...DEFAULT_AGENT_TOOLS.deny] },
    session: { agentPreset: '', provider: '', model: '', promptTimeoutMs: 1000, scope: 'all' },
    limits: { maxReadBytes: 1024, shellTimeoutMs: 1000, agentToolTimeoutMs: 1000 },
    approval: { policy: 'inherit', humanTimeoutMs: 120000 },
  }
}

/** Bring up one listener over the given driver and return its URL plus teardown. */
export async function boot(
  driver: McpDriver,
  config: Config = testConfig(),
  options: { feeds?: FeedSurface; pushes?: EndpointPushes; approvals?: ApprovalBroker } = {},
): Promise<{
  url: string
  stop: () => Promise<void>
  /** The push surface this endpoint published on (created when not supplied). */
  pushes: EndpointPushes
}> {
  const connection = (): ConnectionInfo => ({
    url: 'http://127.0.0.1:0/mcp',
    token: TOKEN,
    tokenSource: 'test',
    mountedOnWebServer: false,
  })
  const status = (): EndpointStatus => ({
    listening: true,
    url: 'http://127.0.0.1:0/mcp',
    mountedOnWebServer: false,
    error: null,
    tokenSource: 'test',
    token: TOKEN,
    settingsRegistered: false,
    tokenFile: '/tmp/dsh-as-mcp/token',
    enabledToolGroups: ['workspace', 'session', 'files'],
  })
  const pushes = options.pushes ?? new EndpointPushes()
  const requestHandler = createRequestHandler({
    deps: {
      driver,
      getConfig: () => config,
      connection,
      status,
      log: silentLog,
      ...(options.feeds === undefined ? {} : { feeds: options.feeds }),
      ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    },
    getToken: () => TOKEN,
    log: silentLog,
    pushes,
  })
  const handle: EndpointHandle = await startListener({ config, handler: requestHandler.handle, log: silentLog })
  return {
    url: handle.url,
    pushes,
    stop: async () => {
      await handle.dispose()
      await requestHandler.close()
    },
  }
}

/** POST one JSON-RPC message and return the raw response. */
export async function rpc(
  url: string,
  message: unknown,
  options: { token?: string | null; protocolVersion?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`
  if (options.protocolVersion !== undefined) headers['mcp-protocol-version'] = options.protocolVersion
  return await fetch(url, { method: 'POST', headers, body: JSON.stringify(message) })
}

/**
 * Read one JSON-RPC reply out of either framing.
 *
 * The transport answers ordinary requests as a single `event: message` SSE
 * frame and only uses a bare JSON body for some protocol paths, so a client
 * has to handle both. Doing it here keeps the tests honest about the wire.
 */
export async function readJsonRpc(response: Response, id: number): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? ''
  const body = await response.text()
  if (!contentType.includes('text/event-stream')) {
    return JSON.parse(body) as Record<string, unknown>
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const parsed = JSON.parse(line.slice(5).trim()) as { id?: number }
    if (parsed.id === id) return parsed as Record<string, unknown>
  }
  throw new Error(`no SSE frame carried a reply for id ${id}: ${body.slice(0, 300)}`)
}

/** POST a `tools/call` and return its first text content block. */
export async function callTool(url: string, name: string, args: unknown): Promise<{
  isError: boolean
  text: string
}> {
  const response = await rpc(url, {
    jsonrpc: '2.0',
    id: 99,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const body = (await readJsonRpc(response, 99)) as {
    result?: { content?: { text?: string }[]; isError?: boolean }
  }
  return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? '' }
}
