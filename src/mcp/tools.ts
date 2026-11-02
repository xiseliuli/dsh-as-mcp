import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { DshDriver } from '../dsh/driver.js'
import type { DshLogger } from '../dsh/types.js'
import type { EndpointStatus } from '../status.js'
import { VERSION } from '../version.js'

/** Where external agents should connect, reported by `dsh_info`. */
export interface ConnectionInfo {
  /** The endpoint an MCP client should POST to. */
  readonly url: string
  /** The bearer token the endpoint requires. */
  readonly token: string
  /** How that token was obtained. */
  readonly tokenSource: string
  /** Whether the endpoint is also reachable through DSH's own web server. */
  readonly mountedOnWebServer: boolean
  /** Why it is not mounted yet, when `mountOnWebServer` is waiting for the service. */
  readonly mountNote?: string
}

/**
 * What {@link registerTools} needs beyond the server itself.
 *
 * Configuration is a getter rather than a value: the MCP handler builds a fresh
 * server per request, so reading the toggles here at that moment is what makes a
 * settings-panel change show up in the very next `tools/list` instead of at the
 * next restart.
 */
export interface ToolDeps {
  readonly driver: McpDriver
  readonly getConfig: () => Config
  readonly connection: () => ConnectionInfo
  /** Live endpoint state, so a caller can tell "not listening" from "no such tool". */
  readonly status: () => EndpointStatus
  readonly log: DshLogger
}

/**
 * The driver surface the tools use.
 *
 * Expressed as a `Pick` of the real driver so there is one source of truth for
 * the signatures, while tests can supply a stub without constructing a Cordis
 * context.
 */
export type McpDriver = Pick<
  DshDriver,
  | 'describeCapabilities'
  | 'ownsSession'
  | 'createWorkspace'
  | 'listWorkspaces'
  | 'deleteWorkspace'
  | 'createSession'
  | 'forkSession'
  | 'renameSession'
  | 'setSessionModel'
  | 'listSessions'
  | 'searchSessions'
  | 'updateQueue'
  | 'readQueue'
  | 'probeSessionSearch'
  | 'promptSession'
  | 'cancelSession'
  | 'readTranscript'
  | 'readFile'
  | 'readImage'
  | 'writeFile'
  | 'editFile'
  | 'listDirectory'
  | 'runShell'
  | 'startShellJob'
  | 'listShellJobs'
  | 'readShellOutput'
  | 'killShellJob'
  | 'listAgentTools'
  | 'callAgentTool'
  | 'sessionUsage'
  | 'describeCatalog'
>

/** Pretty-printed JSON as ordinary text content — the one shape every MCP client renders. */
function ok(value: unknown): CallToolResult {
  const text = JSON.stringify(value, null, 2)
  // A plain object also rides as `structuredContent`, so a schema-aware client can
  // read the same data without parsing the text block. Arrays and primitives stay
  // text-only: an MCP tool's structured content is an object, and wrapping a list
  // in a synthetic field would be a different payload.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return {
      content: [{ type: 'text', text }],
      structuredContent: value as Record<string, unknown>,
    }
  }
  return { content: [{ type: 'text', text }] }
}

/**
 * Declare an object output schema whose fields are advisory.
 *
 * `looseObject` advertises the keys and lets extra ones through: the plugin's
 * payloads do grow (a new field must not make an old schema lie), and MCP clients
 * that validate results would otherwise reject a compatible reply. Fields are
 * optional for the same reason — the schema describes the shape, the tool's own
 * documentation states what is guaranteed.
 */
function outputSchema(fields: Record<string, unknown>): ReturnType<typeof z.looseObject> {
  return z.looseObject(fields)
}

/**
 * A harness tool that ran and failed, as a protocol-level tool error.
 *
 * The payload still carries the whole outcome, so a caller that reads it loses
 * nothing; `isError` is set because the protocol is where a model looks to learn
 * that a call did not succeed. Leaving it unset would bury `ok: false` inside a
 * JSON body the model may treat as a success.
 */
function toolOutcome(value: { ok: boolean }): CallToolResult {
  const result = ok(value)
  return value.ok ? result : { ...result, isError: true }
}

/**
 * Wrap a tool body so a harness failure becomes a readable tool error rather
 * than a transport error.
 *
 * The caller is handed the message alone: a stack trace would leak this host's
 * paths into another agent's context and spend its attention on frames it
 * cannot act on. The full error, stack included, goes to the DSH log instead.
 */
function guard<A>(
  name: string,
  log: DshLogger,
  body: (args: A, ctx: ServerContext) => Promise<CallToolResult>,
) {
  return async (args: A, ctx: ServerContext): Promise<CallToolResult> => {
    try {
      return await body(args, ctx)
    } catch (error) {
      log.warn(`[dsh-as-mcp] %s failed:`, name, error)
      return {
        content: [{
          type: 'text',
          text: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      }
    }
  }
}

/**
 * The abort signal for the request being handled, when the context carries one.
 *
 * The SDK puts it on `mcpReq`, not at the top level. Canceled MCP requests fire it,
 * which is what lets a waiting `session_prompt` end instead of running to its
 * timeout.
 */
function requestSignal(ctx: ServerContext | undefined): AbortSignal | undefined {
  const request = (ctx as { mcpReq?: { signal?: AbortSignal } } | undefined)?.mcpReq
  const signal = request?.signal
  return signal instanceof AbortSignal ? signal : undefined
}

/**
 * Build a throttled `notifications/progress` sender for one request, or
 * `undefined` when the client did not ask for progress.
 *
 * Progress is opt-in at the protocol level: a client sends a `progressToken` in
 * `_meta` and receives updates keyed by it. Sending nothing when no token arrived
 * is not an omission — it is what the spec asks for, and it keeps a client that
 * never asked from paying for notifications it cannot match.
 *
 * @returns a callback that sends at most one notification per second.
 */
function progressReporter(ctx: ServerContext | undefined): ((message: string, progress: number) => void) | undefined {
  const request = (ctx as { mcpReq?: {
    _meta?: { progressToken?: unknown }
    notify?: (notification: unknown) => Promise<void>
  } } | undefined)?.mcpReq
  const token = request?._meta?.progressToken
  if (token === undefined || typeof request?.notify !== 'function') return undefined
  const notify = request.notify.bind(request)
  let lastSent = 0
  return (message, progress) => {
    const now = Date.now()
    // One per second is enough for liveness and far below what a busy turn would
    // otherwise emit (the wait re-checks on every session event).
    if (now - lastSent < 1_000) return
    lastSent = now
    void notify({
      method: 'notifications/progress',
      params: { progressToken: token, progress, message },
    }).catch(() => {
      // The client may have gone away; a lost ping is not a failed tool call.
    })
  }
}

/**
 * Register every enabled tool on one MCP server instance.
 *
 * `createMcpHandler` builds a fresh server from a factory per request, so this
 * runs on every call; keep the bodies thin and push work into {@link DshDriver}.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { driver, getConfig, connection, status, log } = deps
  const enabled = getConfig().tools

  server.registerTool(
    'dsh_info',
    {
      title: 'Describe this DSH MCP endpoint',
      description:
        'Report which DeepSeek Harness services this endpoint can drive, which tool groups are enabled, '
        + 'the catalog of values session_create accepts (provider routes, agent presets, sandbox mode), and the '
        + 'endpoint URL plus where its bearer token comes from. Call this first when you are unsure whether a '
        + 'capability (sessions, files, shell) is available in this DSH profile. `includeModels` also asks each '
        + 'provider route what models it advertises, which is the reliable way to pick a valid model id.',
      inputSchema: z.object({
        includeModels: z
          .boolean()
          .optional()
          .describe(
            'Also list each provider route\'s advertised models. Defaults to false because some adapters '
            + 'answer with remote discovery; each provider is time-boxed.',
          ),
        probeSearch: z
          .boolean()
          .optional()
          .describe(
            'Also check whether session search really works here (not just whether the controller exposes '
            + 'it): the session-query index may be configured with openAt "never". Opt-in because the first '
            + 'search may open and reconcile that index.',
          ),
      }),
      outputSchema: outputSchema({
        endpoint: z.string().optional(),
        version: z.string().optional(),
        uptimeMs: z.number().optional(),
        tokenSource: z.string().optional(),
        tokenFile: z.string().optional(),
        mountedOnDshWebServer: z.boolean().optional(),
        listening: z.boolean().optional(),
        enabledToolGroups: z.looseObject({}).optional(),
        harnessServices: z.looseObject({}).optional(),
        catalog: z.looseObject({}).optional(),
        config: z.looseObject({}).optional(),
        health: z.looseObject({}).optional(),
        usage: z.looseObject({}).optional(),
        search: z.looseObject({}).optional(),
        notes: z.array(z.string()).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard('dsh_info', log, async (args) => {
      const info = connection()
      const live = status()
      const capabilities = driver.describeCapabilities()
      const catalog = await driver.describeCatalog({
        ...(args.includeModels === undefined ? {} : { includeModels: args.includeModels }),
      })
      // Only when asked: opening the index on a cold profile is real work, and a
      // caller that never searches should not pay for it on every dsh_info.
      const search = args.probeSearch === true ? await driver.probeSessionSearch() : undefined
      return ok({
        endpoint: info.url,
        version: VERSION,
        uptimeMs: Math.round(process.uptime() * 1_000),
        // The token itself is deliberately absent. Its value is not needed by a
        // caller that just authenticated with it, and echoing a live credential
        // puts it into every calling agent's transcript and logs. `tokenSource`
        // and `tokenFile` say where it comes from, which is what a client that
        // legitimately needs to hand it on actually requires.
        tokenSource: info.tokenSource,
        tokenFile: live.tokenFile,
        mountedOnDshWebServer: info.mountedOnWebServer,
        ...(info.mountNote === undefined ? {} : { mountNote: info.mountNote }),
        listening: live.listening,
        listenError: live.error,
        settingsRegistered: live.settingsRegistered,
        enabledToolGroups: enabled,
        // The effective settings a caller can act on. Nothing secret lives here:
        // limits, policy names and configured defaults only — the token is
        // deliberately never echoed (see tokenSource above).
        config: {
          tools: enabled,
          limits: {
            maxReadBytes: getConfig().limits.maxReadBytes,
            shellTimeoutMs: getConfig().limits.shellTimeoutMs,
            agentToolTimeoutMs: getConfig().limits.agentToolTimeoutMs,
            promptTimeoutMs: getConfig().session.promptTimeoutMs,
          },
          approval: getConfig().approval.policy,
          session: {
            ...(getConfig().session.agentPreset === '' ? {} : { agentPreset: getConfig().session.agentPreset }),
            ...(getConfig().session.provider === '' ? {} : { provider: getConfig().session.provider }),
            ...(getConfig().session.model === '' ? {} : { model: getConfig().session.model }),
          },
        },
        // Endpoint health, so a caller can tell "the tool failed" from "the plugin
        // process is under memory pressure" without shell access to the host.
        health: {
          node: process.version,
          platform: process.platform,
          rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
          heapUsedMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
        },
        harnessServices: capabilities,
        // What this deployment accepts, so `session_create`'s provider / model /
        // agentPreset are chosen from a list instead of guessed. Each field is
        // independent; `catalog.unavailable` names what could not be read.
        catalog,
        // Usage is worth its own block rather than a line in the service map:
        // the numbers a caller bills against come with caveats (what is counted,
        // whether money is available) that a boolean cannot carry.
        ...(search === undefined ? {} : { search }),
        usage: {
          reported: enabled.usage,
          tool: enabled.usage ? 'session_usage' : null,
          tokensReadable: capabilities['tokenUsage'] === true,
          costAvailable: capabilities['costMeter'] === true,
          notes: [
            'Every session_prompt reply carries per-turn and cumulative token usage for its session.',
            'Tokens are folded from the durable session log; money is reported only when a price plugin (dsh-cost-meter) is installed, and it distinguishes real money (costUsd) from a list-price estimate (costEstimateUsd).',
          ],
        },
        notes: [
          'workspace_* and session_* drive this DSH instance directly; work appears live in the DSH UI.',
          'session_prompt waits for the turn to settle by default and returns the agent reply plus its tool calls.',
          'DSH has no "session ended" event; call session_usage after your last prompt to collect the final tally.',
          'catalog.providers and catalog.agentPresets are the values session_create accepts; a field that could not be read is named in catalog.unavailable.',
        ],
      })
    }),
  )

  if (enabled.workspace) {
    server.registerTool(
      'workspace_create',
      {
        title: 'Create a DSH workspace',
        description:
          'Register a directory as a workspace in DeepSeek Harness, so sessions created in it appear under '
          + 'that project in the DSH UI. Returns the existing registration when the path is already a workspace. '
          + 'The directory is created first unless createDirectory is false.',
        inputSchema: z.object({
          path: z.string().describe('Absolute path of the project directory.'),
          title: z.string().optional().describe('Display title; defaults to the final path segment.'),
          createDirectory: z
            .boolean()
            .optional()
            .describe('Create the directory when it does not exist. Defaults to true.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('workspace_create', log, async (args) => ok(await driver.createWorkspace({
        path: args.path,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.createDirectory === undefined ? {} : { createDirectory: args.createDirectory }),
      }))),
    )

    server.registerTool(
      'workspace_list',
      {
        title: 'List DSH workspaces',
        description: 'List every workspace registered in this DeepSeek Harness, with its id, path, title, session count, and whether the directory still exists.',
        inputSchema: z.object({}),
        outputSchema: outputSchema({
          workspaces: z.array(z.looseObject({})).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('workspace_list', log, async () => ok({ workspaces: await driver.listWorkspaces() })),
    )

    server.registerTool(
      'workspace_delete',
      {
        title: 'Unregister a DSH workspace',
        description:
          'Remove a workspace registration so it leaves the DSH project list. The directory and every file '
          + 'in it are untouched, and sessions that ran there keep their history. Idempotent: an unknown id '
          + 'answers deleted: false rather than failing, so a retried cleanup is not an error.',
        inputSchema: z.object({
          workspaceId: z.string().min(1).describe('Workspace id from workspace_create or workspace_list.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('workspace_delete', log, async (args) => ok(await driver.deleteWorkspace({
        workspaceId: args.workspaceId,
      }))),
    )
  }

  if (enabled.session) {
    server.registerTool(
      'session_create',
      {
        title: 'Start a DSH agent session',
        description:
          'Create a new DeepSeek Harness agent session bound to a workspace (or a bare directory) and return '
          + 'its session id. Pass that id to session_prompt to make the DSH agent do work. Sessions are visible '
          + 'live in the DSH UI. Model selection falls back to this DSH instance\'s default route.',
        inputSchema: z.object({
          workspaceId: z.string().optional().describe('Workspace id from workspace_list or workspace_create.'),
          cwd: z.string().optional().describe('Bare directory to bind the session to; use instead of workspaceId.'),
          agentPreset: z.string().optional().describe('Agent preset id; defaults to the harness default.'),
          provider: z.string().optional().describe('Model provider route. Must be paired with model.'),
          model: z.string().optional().describe('Model id. Must be paired with provider.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_create', log, async (args) => ok(await driver.createSession({
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.model === undefined ? {} : { model: args.model }),
      }))),
    )

    server.registerTool(
      'session_list',
      {
        title: 'List DSH sessions',
        description: 'List sessions known to this DeepSeek Harness, most recently updated first.',
        inputSchema: z.object({
          limit: z.number().int().positive().max(200).optional().describe('Maximum sessions to return. Defaults to 20.'),
          includeTitle: z
            .boolean()
            .optional()
            .describe(
              'Also fold each session\'s latest title. Costs one durable-log read per session, so it is '
              + 'off by default; useful when picking a session by what it was about.',
            ),
          cwd: z
            .string()
            .optional()
            .describe('Only sessions whose workspace directory is this path (canonicalised before matching).'),
          running: z
            .boolean()
            .optional()
            .describe('Only sessions that are currently running (true) or idle (false).'),
        }),
        outputSchema: outputSchema({
          sessions: z.array(z.looseObject({})).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_list', log, async (args) => {
        const listed = await driver.listSessions(args.limit ?? 20, {
          ...(args.includeTitle === undefined ? {} : { includeTitle: args.includeTitle }),
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.running === undefined ? {} : { running: args.running }),
        })
        // `truncated` is the question a caller actually has: did the limit hide
        // sessions that match? `total` is how many matched before the cut.
        return ok({
          sessions: listed.sessions,
          total: listed.total,
          ...(listed.total > listed.sessions.length ? { truncated: true } : {}),
        })
      }),
    )

    server.registerTool(
      'session_search',
      {
        title: 'Search session content',
        description:
          'Search the message content of the sessions this DSH knows, returning each match as sessionId, '
          + 'a snippet, and (when the session listing is readable) its workspace cwd, updatedAt and '
          + 'running flag. Use it to find the session that discussed a topic before prompting or reading '
          + 'it. Results match tokens and phrases (FTS), not arbitrary substrings, and multiple terms must all match (AND). The harness bounds one '
          + 'search at 20 matches and reports hasMore; sessions are matched on messages, not titles. Search '
          + 'is opt-in: a profile whose session-query index is configured with openAt "never" fails with an '
          + 'explanation instead of searching.',
        inputSchema: z.object({
          query: z.string().trim().min(1).describe('Literal text to look for in session messages.'),
          limit: z.number().int().positive().max(20).optional()
            .describe('Cap the matches returned (the harness caps a search at 20).'),
        }),
        annotations: { readOnlyHint: true },
      },
      guard('session_search', log, async (args) => ok(await driver.searchSessions({
        query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      }))),
    )

    server.registerTool(
      'session_fork',
      {
        title: 'Fork a live DSH session',
        description:
          'Branch a live session into a child that inherits its event prefix up to an optional boundary. The '
          + 'child continues the same conversation without re-sending or re-priming it, so trying an alternative '
          + 'direction costs one new turn instead of a replay. The source may be a session that is live right now '
          + 'or one restored from disk. The child is tracked as this endpoint\'s session and its inherited prefix '
          + 'is reported separately from its own spend by session_usage.',
        inputSchema: z.object({
          sessionId: z.string().describe('Live source session id.'),
          atSeq: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              'Inclusive event seq to fork through. Defaults to the source\'s current last event; use a '
              + 'smaller seq to branch from an earlier point in the conversation.',
            ),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_fork', log, async (args) => ok(await driver.forkSession({
        sessionId: args.sessionId,
        ...(args.atSeq === undefined ? {} : { atSeq: args.atSeq }),
      }))),
    )

    server.registerTool(
      'session_rename',
      {
        title: 'Name a DSH session',
        description:
          'Set an explicit title on a session. The title is owned by the user, so the harness stops generating '
          + 'one automatically and the name stays as given — that is what makes a session created by an external '
          + 'harness recognizable in the DSH UI (and in session_list with includeTitle). A session currently held '
          + 'open by another DSH process is refused by the harness with that explanation.',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          title: z.string().trim().min(1).max(200).describe('The title to set; trimmed and length-capped.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_rename', log, async (args) => ok(await driver.renameSession({
        sessionId: args.sessionId,
        title: args.title,
      }))),
    )

    server.registerTool(
      'session_set_model',
      {
        title: 'Switch a DSH session\'s model',
        description:
          'Change the provider route and model that a session\'s subsequent turns use. Useful to start on a '
          + 'cheap model and escalate for a hard turn, or to fall back when a route is unavailable. The harness '
          + 'stores the selection on the session, so later session_prompt calls use it, and the reply\'s per-'
          + 'model usage shows which route spent what. Use dsh_info with includeModels: true to see valid ids; '
          + 'an unknown route or model is refused with the list of known routes.',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          provider: z.string().describe('Provider route id, e.g. from dsh_info catalog.providers.'),
          model: z.string().describe('Model id advertised by that route.'),
          reasoningEffort: z
            .string()
            .optional()
            .describe('Optional reasoning effort level for routes that expose one, e.g. "high".'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_set_model', log, async (args) => ok(await driver.setSessionModel({
        sessionId: args.sessionId,
        provider: args.provider,
        model: args.model,
        ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
      }))),
    )

    server.registerTool(
      'session_prompt',
      {
        title: 'Ask a DSH session to do work',
        description:
          'Send one user message to a DSH agent session. This is how to write code through DSH: describe the '
          + 'task and the DSH agent runs its own tools (file edits, shell, subagents) in the session workspace, '
          + 'subject to this DSH instance\'s permission policy. By default the call waits for the turn to settle '
          + 'and returns the agent\'s final reply plus every tool call it made. Set wait=false to queue the '
          + 'message and return immediately. '
          + 'Attach screenshots with images: each path is read through this instance\'s filesystem seam, '
          + 'and the agent sees the picture (png/jpeg/webp/gif, at most 4); prompt may be empty when images '
          + 'are attached. '
          + 'Every reply also carries token usage: turn.usage is what the turn consumed (all its steps, '
          + 'including tool round trips) and session.usage is the cumulative total for the session so far, '
          + 'with a per-model breakdown. With mode=steer the turn was already running, so its usage also '
          + 'covers steps that ran before this message. When a price plugin is installed, session.cost '
          + 'carries money — real money charged and separately a list-price estimate; without one it says '
          + 'why money is unavailable. Token counts are exact provider-reported numbers. If the usage could '
          + 'not be read at all, the reply says so with usageUnavailable and a reason instead of silently '
          + 'omitting the block.',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          // Trimmed so the harness does not reject whitespace-only content after
          // the session was already touched. Optional because an image-only message
          // is valid; the pair must not both be empty, which the driver enforces.
          prompt: z.string().trim().optional().describe('The task or question for the DSH agent.'),
          images: z
            .array(z.object({
              path: z.string().describe('Image path; relative paths resolve against cwd.'),
              cwd: z.string().optional().describe('Base directory for a relative path.'),
            }))
            .max(4)
            .optional()
            .describe('Images to attach, read through the DSH filesystem seam (png, jpeg, webp, gif).'),
          idempotencyKey: z
            .string()
            .optional()
            .describe(
              'Retry-safe key for this message (letters, digits, . _ : -). Repeating a call with the same key '
              + 'returns the existing turn instead of sending the prompt twice; reusing it with different '
              + 'content is refused. Use one key per logical message when your own timeout may cause retries.',
            ),
          toolCalls: z
            .enum(['summary', 'full', 'none'])
            .optional()
            .describe(
              'How much of each tool call the reply carries. summary (default) gives name, id and argument '
              + 'size; full also returns the arguments (bounded by maxArgumentChars); none drops the list. '
              + 'Arguments are omitted by default because an agent file_write carries the whole file.',
            ),
          maxArgumentChars: z
            .number()
            .int()
            .positive()
            .max(1_000_000)
            .optional()
            .describe('Per-call argument ceiling in full mode. Defaults to 4000 characters.'),
          maxReplyChars: z
            .number()
            .int()
            .positive()
            .max(1_000_000)
            .optional()
            .describe(
              'Cut the agent\'s final reply to this many characters. Omitted returns the full reply; '
              + 'a cut reply carries replyTruncated and its original replyChars.',
            ),
          mode: z
            .enum(['queue', 'steer'])
            .optional()
            .describe('queue (default) runs a new turn; steer delivers into the running turn.'),
          wait: z.boolean().optional().describe('Wait for the turn to settle. Defaults to true.'),
          timeoutMs: z
            .number()
            .int()
            .positive()
            // Capped because each waiting call holds a loop alive (one durable read
            // per second at most, since it wakes on session events), and the queue
            // only serialises per session — so an uncapped timeout lets a caller
            // keep N loops alive indefinitely. Ten minutes is far beyond any real
            // turn the wait is meant to cover; a caller that genuinely needs longer
            // should poll session_messages instead of holding one call open.
            .max(600_000)
            .optional()
            .describe('Upper bound for the wait. Defaults to the endpoint configuration.'),
        }),
        annotations: { openWorldHint: true },
      },
      guard('session_prompt', log, async (args, ctx) => {
        const progress = progressReporter(ctx)
        const signal = requestSignal(ctx)
        return ok(await driver.promptSession({
          sessionId: args.sessionId,
          prompt: args.prompt ?? '',
          ...(args.images === undefined ? {} : { images: args.images }),
          mode: args.mode ?? 'queue',
          wait: args.wait ?? true,
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
          ...(args.toolCalls === undefined ? {} : { toolCalls: args.toolCalls }),
          ...(args.maxArgumentChars === undefined ? {} : { maxArgumentChars: args.maxArgumentChars }),
          ...(args.maxReplyChars === undefined ? {} : { maxReplyChars: args.maxReplyChars }),
          // A client that cancels the request stops the wait instead of leaving a
          // loop behind; the reply then says aborted + partial.
          ...(signal === undefined ? {} : { signal }),
          ...(progress === undefined
            ? {}
            : {
              onProgress: (update) => {
                // `progress` is monotonically non-decreasing seconds, which is
                // what a progress bar needs; the message carries the real state.
                progress(
                  `turn ${update.turn ?? '?'}: ${update.toolCalls} tool call(s), `
                  + `${Math.round(update.elapsedMs / 1_000)}s`
                  + (update.settled ? ' (settled)' : ''),
                  update.elapsedMs / 1_000,
                )
              },
            }),
        }))
      }),
    )

    server.registerTool(
      'session_messages',
      {
        title: 'Read a DSH session transcript',
        description: 'Return the most recent user and assistant messages of one session, oldest first.',
        inputSchema: z.object({
          sessionId: z.string(),
          limit: z.number().int().positive().max(500).optional().describe('Maximum messages to return. Defaults to 50.'),
          sinceSeq: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              'Only messages with a larger seq than this. Poll incrementally: pass the seq of the last message '
              + 'you already have instead of re-reading the transcript.',
            ),
          beforeSeq: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Page backwards: only messages with a smaller seq, newest of those first-of-the-window '
              + 'last. To walk a long transcript, pass the seq of the oldest message you already have.',
            ),
          role: z
            .enum(['user', 'assistant'])
            .optional()
            .describe('Only one side of the conversation.'),
          maxCharsPerMessage: z
            .number()
            .int()
            .positive()
            .max(1_000_000)
            .optional()
            .describe(
              'Cut each message to this many characters. Omitted returns full text (the historical '
              + 'behaviour); a cut message carries truncated and its original chars.',
            ),
        }),
        outputSchema: outputSchema({
          messages: z.array(z.looseObject({})).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_messages', log, async (args) => {
        const transcript = await driver.readTranscript(args.sessionId, args.limit ?? 50, {
          ...(args.sinceSeq === undefined ? {} : { sinceSeq: args.sinceSeq }),
          ...(args.beforeSeq === undefined ? {} : { beforeSeq: args.beforeSeq }),
          ...(args.role === undefined ? {} : { role: args.role }),
          ...(args.maxCharsPerMessage === undefined ? {} : { maxCharsPerMessage: args.maxCharsPerMessage }),
        })
        // The newest `limit` messages are returned even when more exist, so say
        // when the window hid some: a poll that missed messages must not read as
        // an empty conversation.
        return ok({
          messages: transcript.messages,
          total: transcript.total,
          ...(transcript.total > transcript.messages.length ? { truncated: true } : {}),
        })
      }),
    )

    server.registerTool(
      'session_queue',
      {
        title: 'Inspect or mutate the pending queue',
        description:
          'Without action/messageId: list the messages waiting in this session\'s inbox, each with the id '
          + 'queue mutations address (a queued message has no transcript event yet, which is why '
          + 'session_messages cannot show it). With action/messageId: mutate one pending message — remove it '
          + 'so it never runs, replace its text, or steer it into the running turn. session_cancel stops the '
          + 'current turn; this changes the work waiting behind it.',
        inputSchema: z.object({
          sessionId: z.string(),
          messageId: z.string().optional().describe('The queued message id from a listing; pass it with action.'),
          action: z.enum(['remove', 'edit', 'steer']).optional()
            .describe('remove, edit (needs content), or steer. Omit, with messageId, to list the queue.'),
          content: z.string().optional().describe('Replacement text; required for edit, ignored otherwise.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_queue', log, async (args) => {
        if (args.action === undefined && args.messageId === undefined) {
          return ok(await driver.readQueue(args.sessionId))
        }
        if (args.action === undefined || args.messageId === undefined) {
          throw new Error('pass messageId and action together, or neither of them to list the queue')
        }
        return ok(await driver.updateQueue({
          sessionId: args.sessionId,
          messageId: args.messageId,
          action: args.action,
          ...(args.content === undefined ? {} : { content: args.content }),
        }))
      }),
    )

    server.registerTool(
      'session_cancel',
      {
        title: 'Cancel a DSH turn',
        description: 'Ask the agent in this session to stop its current turn. Queued work is preserved.',
        inputSchema: z.object({ sessionId: z.string() }),
        annotations: { openWorldHint: false },
      },
      guard('session_cancel', log, async (args) => ok(driver.cancelSession(args.sessionId))),
    )
  }

  if (enabled.usage) {
    server.registerTool(
      'session_usage',
      {
        title: 'Report token usage for a DSH session',
        description:
          'Report how many DeepSeek tokens a session (or several) consumed: exact provider-reported counts '
          + 'split into uncached input, cache read, cache write and output, with a per-model breakdown, an '
          + 'optional per-turn breakdown, and the sum you can bill against. '
          + 'Call it after your last prompt to collect a final tally — DSH has no "session ended" event, and '
          + 'every session_prompt reply already carries the same numbers plus the session total so far. '
          + 'Usage is read from the durable session log, so it works for a session that has since gone idle '
          + 'or left the live store, and for a session created by a previous run of DSH as long as you know '
          + 'its id. With no sessionId it totals the sessions this endpoint created in this DSH process; '
          + 'pass all=true to scan every session this DSH knows. '
          + 'Money is reported only when a price plugin (dsh-cost-meter) is installed. It is an estimate from '
          + 'a price catalog: costUsd is the real money charged (0 for a plan-covered call) and '
          + 'costEstimateUsd is what the same calls would have cost at API list prices. Token totals remain '
          + 'available either way.',
        inputSchema: z.object({
          sessionId: z
            .string()
            .optional()
            .describe('Session id from session_create or session_list. Omit to total the sessions this endpoint created.'),
          sessionIds: z
            .array(z.string().min(1))
            .max(200)
            .optional()
            .describe(
              'Report several known sessions in one receipt (duplicates collapsed). Mutually exclusive with '
              + 'sessionId and all; useful when a caller tracks a batch of task ids.',
            ),
          cwd: z
            .string()
            .optional()
            .describe(
              'Total every session that ran in this workspace directory (canonicalised). Mutually '
              + 'exclusive with sessionId/sessionIds/all; needs the session listing.',
            ),
          all: z
            .boolean()
            .optional()
            .describe(
              'Without a sessionId: scan every session this DSH knows, most recently updated first. '
              + 'Ignored when sessionId is given.',
            ),
          includeSubagents: z
            .boolean()
            .optional()
            .describe(
              'Fold subagent sessions under the target session (or under each listed session) into the '
              + 'receipt, listing them as their own rows. An ordinary fork of a session is not a subagent '
              + 'and is never folded in. With all=true the flag instead decides whether subagent sessions '
              + 'are scanned at all. Defaults to true — subagent tokens are billed to the same account, so a '
              + 'total that ignored them would understate the cost of the task. When false, a note says how '
              + 'many were left out.',
            ),
          includeTurns: z
            .boolean()
            .optional()
            .describe('Also return the per-turn breakdown of each row. Defaults to false.'),
          includeCost: z
            .boolean()
            .optional()
            .describe(
              'Read money from dsh-cost-meter. Defaults to true. Set false for a wide scan: every '
              + 'priced row is one ledger read, and a scan of many sessions does not need money.',
            ),
          limit: z
            .number()
            .int()
            .positive()
            // Bounded like the other scanning tools: every row costs one durable
            // log read, so an unbounded scan is an unbounded amount of I/O on a
            // machine with years of sessions.
            .max(200)
            .optional()
            .describe('How many sessions to scan when no sessionId is given. Defaults to 20.'),
        }),
        outputSchema: outputSchema({
          generatedAt: z.string().optional(),
          scope: z.string().optional(),
          sessions: z.array(z.looseObject({})).optional(),
          totals: z.looseObject({}).optional(),
          byModel: z.array(z.looseObject({})).optional(),
          subagentsIncluded: z.boolean().optional(),
          cost: z.looseObject({}).optional(),
          notes: z.array(z.string()).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_usage', log, async (args) => ok(await driver.sessionUsage({
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        ...(args.sessionIds === undefined ? {} : { sessionIds: args.sessionIds }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.all === undefined ? {} : { all: args.all }),
        ...(args.includeSubagents === undefined ? {} : { includeSubagents: args.includeSubagents }),
        ...(args.includeTurns === undefined ? {} : { includeTurns: args.includeTurns }),
        ...(args.includeCost === undefined ? {} : { includeCost: args.includeCost }),
        limit: args.limit ?? 20,
      }))),
    )
  }

  if (enabled.files) {
    server.registerTool(
      'file_read',
      {
        title: 'Read a file through DSH',
        description:
          'Read a UTF-8 text file through this DSH instance\'s filesystem service, so the same path rules and '
          + 'sandboxing the DSH agent uses apply to you. Output is truncated at a byte limit; when '
          + '`truncated` is true, call again with `offset: nextOffset` to read the rest. Paging (offset + a '
          + 'smaller maxBytes) is how to read a slice of a large file without paying for the whole thing. '
          + 'Offsets are bytes, so a window can split a multi-byte character; the split character shows up '
          + 'as U+FFFD and the next window continues correctly.',
        inputSchema: z.object({
          path: z.string().describe('File path; relative paths resolve against cwd.'),
          cwd: z.string().optional().describe('Base directory for a relative path; defaults to the DSH process cwd.'),
          offset: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Byte offset to start reading at. Defaults to 0; use nextOffset from a truncated reply.'),
          maxBytes: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Bytes to return for this call, capped by the limits.maxReadBytes setting. Defaults to that '
              + 'setting; a smaller value is what makes paging cheap.',
            ),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('file_read', log, async (args) => {
        const limit = getConfig().limits.maxReadBytes
        return ok(await driver.readFile({
          path: args.path,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          // The configured limit is a ceiling, not a suggestion: a caller may ask
          // for less so paging costs less, never for more.
          maxBytes: args.maxBytes === undefined ? limit : Math.min(args.maxBytes, limit),
          ...(args.offset === undefined ? {} : { offset: args.offset }),
        }))
      }),
    )

    server.registerTool(
      'file_read_image',
      {
        title: 'Read an image through DSH',
        description:
          'Read one image file through this DSH instance\'s filesystem service and return it as an MCP image '
          + 'content block, so you can actually look at a screenshot, chart, or diagram instead of inferring it '
          + 'from code. The format is detected from the bytes (png, jpeg, gif, webp, bmp); the file is capped at '
          + '8 MiB and is refused above that. Use file_read for anything textual.',
        inputSchema: z.object({
          path: z.string().describe('Image path; relative paths resolve against cwd.'),
          cwd: z.string().optional().describe('Base directory for a relative path; defaults to the DSH process cwd.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('file_read_image', log, async (args) => {
        const image = await driver.readImage({
          path: args.path,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                path: image.path,
                mimeType: image.mimeType,
                bytes: image.bytes,
                ...(image.size === undefined ? {} : { size: image.size }),
              }),
            },
            { type: 'image', data: image.base64, mimeType: image.mimeType },
          ],
        }
      }),
    )

    server.registerTool(
      'file_write',
      {
        title: 'Write a file through DSH',
        description:
          'Create or replace a UTF-8 text file through this DSH instance\'s filesystem service. The write is '
          + 'atomic. Use this for direct edits; use session_prompt when you want the DSH agent to do the work.',
        inputSchema: z.object({
          path: z.string().describe('File path; relative paths resolve against cwd.'),
          content: z.string().describe('Complete new file content.'),
          cwd: z.string().optional(),
          createDirectories: z
            .boolean()
            .optional()
            .describe(
              'When false, the call fails if the parent directory does not exist instead of '
              + 'creating it. Defaults to true (create it).',
            ),
        }),
        annotations: { openWorldHint: false },
      },
      guard('file_write', log, async (args) => ok(await driver.writeFile({
        path: args.path,
        content: args.content,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        createDirectories: args.createDirectories ?? true,
      }))),
    )

    server.registerTool(
      'file_list',
      {
        title: 'List a directory through DSH',
        description:
          'List a directory through this DSH instance\'s filesystem service. One level by default; '
          + '`recursive: true` walks subdirectories (bounded by maxDepth and an entry cap, with `truncated` '
          + 'when the cap stops it) and gives every entry a `path` relative to the listed directory.',
        inputSchema: z.object({
          path: z.string().describe('Directory path; relative paths resolve against cwd.'),
          cwd: z.string().optional(),
          recursive: z
            .boolean()
            .optional()
            .describe('Walk subdirectories instead of one level. Defaults to false.'),
          maxDepth: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('How deep a recursive walk goes; defaults to no explicit bound (the entry cap still applies).'),
        }),
        outputSchema: outputSchema({
          path: z.string().optional(),
          entries: z.array(z.looseObject({})).optional(),
          truncated: z.boolean().optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('file_list', log, async (args) => ok(await driver.listDirectory({
        path: args.path,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.recursive === undefined ? {} : { recursive: args.recursive }),
        ...(args.maxDepth === undefined ? {} : { maxDepth: args.maxDepth }),
      }))),
    )

    server.registerTool(
      'file_edit',
      {
        title: 'Edit a file through DSH',
        description:
          'Replace literal text in one file through this DSH instance\'s filesystem service. This exists '
          + 'because editing by reading the whole file and writing it back costs the caller a full file in '
          + 'each direction; with file_edit only the pattern and its replacement cross the wire. '
          + '`oldText` must match the file exactly, including whitespace, and must occur once unless '
          + '`replaceAll: true`; an ambiguous match is refused and nothing is written. The write is atomic.',
        inputSchema: z.object({
          path: z.string().describe('File path; relative paths resolve against cwd.'),
          cwd: z.string().optional().describe('Base directory for a relative path; defaults to the DSH process cwd.'),
          oldText: z.string().min(1).describe('Exact text to replace, including indentation and newlines.'),
          newText: z.string().describe('Replacement text; may be empty to delete the match.'),
          replaceAll: z
            .boolean()
            .optional()
            .describe('Replace every occurrence instead of requiring a unique match. Defaults to false.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('file_edit', log, async (args) => ok(await driver.editFile({
        path: args.path,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        oldText: args.oldText,
        newText: args.newText,
        replaceAll: args.replaceAll ?? false,
        maxBytes: getConfig().limits.maxReadBytes,
      }))),
    )
  }

  if (enabled.shell) {
    server.registerTool(
      'shell_run',
      {
        title: 'Run a command through DSH',
        description:
          'Run one shell command through this DSH instance\'s shell service, so the DSH sandbox and permission '
          + 'policy decide what is allowed. Prefer session_prompt when you want the agent to interpret results; '
          + 'use this for deterministic commands.',
        inputSchema: z.object({
          command: z.string().min(1).describe('Command line to run.'),
          cwd: z.string().optional().describe('Working directory; defaults to the shell executor\'s configured directory.'),
          timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds.'),
        }),
        annotations: { openWorldHint: true },
      },
      guard('shell_run', log, async (args) => ok(await driver.runShell({
        command: args.command,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        timeoutMs: args.timeoutMs ?? getConfig().limits.shellTimeoutMs,
      }))),
    )

    server.registerTool(
      'shell_start',
      {
        title: 'Start a background command through DSH',
        description:
          'Start one command in the background and return a job id immediately, for a build, test run, or dev '
          + 'server that should not block the conversation. Poll with shell_output and stop it with shell_kill. '
          + 'The command runs through the same shell service and sandbox as shell_run. Stdin is closed; for an '
          + 'interactive program use a script that reads its input from a file.',
        inputSchema: z.object({
          command: z.string().describe('Shell command to start.'),
          cwd: z.string().optional().describe('Working directory; defaults to the DSH process cwd.'),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Watchdog: kill the command after this many milliseconds. Omit for no deadline.'),
        }),
        annotations: { openWorldHint: true },
      },
      guard('shell_start', log, async (args) => ok(await driver.startShellJob({
        command: args.command,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      }))),
    )

    server.registerTool(
      'shell_output',
      {
        title: 'Read background command output',
        description:
          'Read output produced by a background job since the last read. Each byte is delivered once; '
          + '`pendingBytes` says how much is still buffered, `done`/`status` say whether the process has '
          + 'finished, and the final output remains readable after exit. Output is capped per call; a job that '
          + 'writes faster than you poll loses the oldest bytes beyond its retained buffer (`truncated`, with '
          + 'spill paths when the shell service provides them).',
        inputSchema: z.object({
          jobId: z.string().describe('Job id returned by shell_start.'),
          maxBytes: z
            .number()
            .int()
            .positive()
            .max(1024 * 1024)
            .optional()
            .describe('Maximum bytes to return in this call. Defaults to 65536.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      guard('shell_output', log, async (args) => ok(driver.readShellOutput({
        jobId: args.jobId,
        ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes }),
      }))),
    )

    server.registerTool(
      'shell_kill',
      {
        title: 'Stop a background command',
        description:
          'Ask a background job to stop and wait briefly for it to settle. Idempotent: a job that already '
          + 'finished reports `killed: false`. Its remaining output stays readable with shell_output.',
        inputSchema: z.object({
          jobId: z.string().describe('Job id returned by shell_start.'),
          waitMs: z
            .number()
            .int()
            .nonnegative()
            .max(30_000)
            .optional()
            .describe('How long to wait for the process to settle. Defaults to 2000.'),
        }),
        annotations: { openWorldHint: true },
      },
      guard('shell_kill', log, async (args) => ok(await driver.killShellJob({
        jobId: args.jobId,
        ...(args.waitMs === undefined ? {} : { waitMs: args.waitMs }),
      }))),
    )

    server.registerTool(
      'shell_list',
      {
        title: 'List background commands',
        description:
          'Every background job this endpoint knows: id, command, status, timestamps, exit code, and how many '
          + 'output bytes are waiting for a read.',
        inputSchema: z.object({
          running: z
            .boolean()
            .optional()
            .describe('Only jobs that are currently running (true) or only settled ones (false).'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      guard('shell_list', log, async (args) => ok({
        jobs: driver.listShellJobs(args.running === undefined ? {} : { running: args.running }),
      })),
    )
  }

  if (enabled.agentTools) {
    server.registerTool(
      'dsh_tool_list',
      {
        title: "List this DSH instance's own agent tools",
        description:
          'List the tools one DSH session can run, with the same schema its own agent sees. Only the permitted '
          + 'names are shown; the rest are neither listed nor callable. A sessionId is required because DSH '
          + 'registers tools inside an agent scope — there is no deployment-wide toolbox.',
        inputSchema: z.object({
          sessionId: z.string().min(1)
            .describe('The session whose agent and policy scope the listing. Required.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('dsh_tool_list', log, async (args) => ok(await driver.listAgentTools({
        sessionId: args.sessionId,
      }))),
    )

    server.registerTool(
      'dsh_tool_call',
      {
        title: "Run one of this DSH instance's agent tools",
        description:
          'Run a tool from dsh_tool_list directly, through the same pipeline the DSH agent uses — pre-policy, '
          + 'guards, sandbox and approval all still apply — without spending a model turn to decide to call it. '
          + 'Use dsh_tool_list first: a name that is not listed is refused. The call runs as the given '
          + 'session agent, which is what supplies the policy. Prefer session_prompt when the task needs '
          + 'judgement; use this for deterministic calls.',
        inputSchema: z.object({
          name: z.string().trim().min(1).describe('Tool name, exactly as dsh_tool_list reports it.'),
          args: z.record(z.string(), z.unknown()).optional()
            .describe('Arguments object matching the schema that tool reports.'),
          sessionId: z.string().min(1)
            .describe('The session whose agent runs the call, under its policy and working directory. Required.'),
          timeoutMs: z.number().int().positive().max(600_000).optional()
            .describe(
              'Abort the call after this many milliseconds. Defaults to the configured agent '
              + 'tool timeout (limits.agentToolTimeoutMs).',
            ),
          maxResultChars: z.number().int().positive().max(200_000).optional()
            .describe(
              'Ceiling on the result text returned to you. Defaults to 20000. An agent tool can '
              + 'return a whole file or command output; beyond the cap the reply sets truncated and '
              + 'resultBytes instead of flooding this conversation.',
            ),
        }),
        annotations: { openWorldHint: true },
      },
      guard('dsh_tool_call', log, async (args) => toolOutcome(await driver.callAgentTool({
        name: args.name,
        ...(args.args === undefined ? {} : { args: args.args }),
        sessionId: args.sessionId,
        timeoutMs: args.timeoutMs ?? getConfig().limits.agentToolTimeoutMs,
        ...(args.maxResultChars === undefined ? {} : { maxResultChars: args.maxResultChars }),
      }))),
    )
  }
}
