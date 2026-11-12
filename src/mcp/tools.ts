import { ResourceTemplate, type CallToolResult, type McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { DshDriver } from '../dsh/driver.js'
import type { DshLogger } from '../dsh/types.js'
import type { EndpointStatus } from '../status.js'
import { VERSION } from '../version.js'
import { describeToolAvailability } from './availability.js'
import type { FeedResource, FeedSurface } from './feeds.js'

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
  /**
   * The server-push feeds, when this host started them. Optional so a test or an
   * embedder can serve the tool surface without the resource layer; the tools never
   * read from it, only the resource registrations do.
   */
  readonly feeds?: FeedSurface
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
  | 'createWorktree'
  | 'restoreWorktree'
  | 'forkSession'
  | 'renameSession'
  | 'setSessionModel'
  | 'listSessions'
  | 'searchSessions'
  | 'sessionStatus'
  | 'archiveSession'
  | 'unarchiveSession'
  | 'pinSession'
  | 'unpinSession'
  | 'listSessionCommands'
  | 'runSessionCommand'
  | 'sessionGoal'
  | 'mutateSessionGoal'
  | 'createScheduledTask'
  | 'listScheduledTasks'
  | 'viewScheduledTask'
  | 'editScheduledTask'
  | 'updateQueue'
  | 'readQueue'
  | 'probeSessionSearch'
  | 'promptSession'
  | 'cancelSession'
  | 'readTranscript'
  | 'readToolResult'
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
 * Register the synthetic push resources of one tool group.
 *
 * A URI template becomes a `ResourceTemplate` (so `resources/templates/list`
 * advertises it and a client can subscribe to the concrete URI); a static URI
 * registers directly. Every read answers one JSON payload — that is the whole
 * contract a push notification depends on: notify a URI, read it for the data.
 */
function registerFeedResources(server: McpServer, feeds: FeedSurface, group: FeedResource['group']): void {
  for (const resource of feeds.resources) {
    if (resource.group !== group) continue
    const metadata = {
      title: resource.title,
      description: resource.description,
      mimeType: 'application/json',
    }
    if (resource.uriTemplate.includes('{')) {
      server.registerResource(
        resource.name,
        new ResourceTemplate(resource.uriTemplate, { list: undefined }),
        metadata,
        async (uri, variables) => ({
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await resource.read(uri, variables as Readonly<Record<string, string>>)),
          }],
        }),
      )
    } else {
      server.registerResource(
        resource.name,
        resource.uriTemplate,
        metadata,
        async (uri) => ({
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await resource.read(uri, {})),
          }],
        }),
      )
    }
  }
}

/**
 * Register every enabled tool on one MCP server instance.
 *
 * `createMcpHandler` builds a fresh server from a factory per request, so this
 * runs on every call; keep the bodies thin and push work into {@link DshDriver}.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { driver, getConfig, connection, status, log, feeds } = deps
  const enabled = getConfig().tools

  server.registerTool(
    'dsh_info',
    {
      title: 'Describe this DSH MCP endpoint',
      description:
        'Report which DeepSeek Harness services this endpoint can drive, which tool groups are enabled, '
        + 'the catalog of values session_create accepts (provider routes, agent presets, sandbox mode), and the '
        + 'endpoint URL plus where its bearer token comes from. Call this first when you are unsure whether a '
        + 'capability (sessions, files, shell) is available in this DSH profile, and `toolAvailability` lists the '
        + 'tools this deployment cannot serve with the reason. `includeModels` also asks each '
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
        toolAvailability: z.looseObject({}).optional(),
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
      // What a caller can actually call here, derived from the probes above: the
      // booleans say which services exist, this says which tools depend on them.
      const toolAvailability = describeToolAvailability(enabled, capabilities, getConfig())
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
            scope: getConfig().session.scope,
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
        toolAvailability,
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
          'session_create { worktree } and worktree_create/worktree_restore need a worktrees service (the forge bundle in DSH Desktop/Web); harnessServices.worktrees reports it. A workspaceId-created session that enters a worktree keeps its workspace group and works in the new checkout (a cwd-only session stays ungrouped); session_status.workingDirectory and session_list { includeWorktree } show where each session is working.',
          'session_archive/unarchive and session_pin/unpin write the same registry sets the DSH sidebar uses; session_list reports each row\'s archived and pinned flags. The harness has no session delete, and these tools do not add one.',
          'Slash commands execute without a model turn: session_command_list names what this session accepts and session_command runs one. Only the user-plane commands are admitted (/compact, /plan, /goal, /export); /permission and /feedback are refused before any handler runs, and a refused call writes nothing to the session log.',
          'Scheduled tasks (schedule_*) are Host records, not session records: the harness delivers the prompt at each occurrence whether or not anyone is connected, and the reply carries the generated id plus the first occurrence. They are refused while session.scope is "owned", because a Host record has no owning session to filter on.',
          'session_goal reads and mutates the session\'s durable goal (the round driver advances it across turns). Mutations carry the harness\'s own goal revision, so pass expectedRevision from a read to refuse a goal that changed underneath you.',
          ...(feeds === undefined ? [] : ['Push feeds: modern clients open one subscriptions/listen stream and name resources — dsh://sessions, dsh://session/<id>/turn|events|assistant|status|projections, dsh://jobs, dsh://jobs/<id>. 2025-era clients get the same notifications on a stateful session\'s GET SSE stream after resources/subscribe. Reads return JSON; event and assistant feeds carry a monotonic seq so a client can drop repeats.']),
          'session_prompt waits for the turn to settle by default and returns the agent reply plus its tool calls.',
          'DSH has no "session ended" event; call session_usage after your last prompt to collect the final tally.',
          'catalog.providers and catalog.agentPresets are the values session_create accepts; a field that could not be read is named in catalog.unavailable.',
        ],
      })
    }),
  )

  // `resources.subscribe` is what makes the SDK's `subscriptions/listen` ack honor
  // `resourceSubscriptions` (`honoredSubset` drops a feed it cannot advertise, and
  // the client then never hears about it). The session group owns the turn and
  // session feeds, the shell group owns the job feeds, so the capability is
  // advertised whenever either exists — not only when session tools are on.
  if (enabled.session || enabled.shell) {
    server.server.registerCapabilities({ resources: { subscribe: true } })
  }

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
    server.registerResource(
      'session-turn',
      new ResourceTemplate('dsh://session/{sessionId}/turn', { list: undefined }),
      {
        title: 'DSH session turn',
        description:
          'The live state of one DSH session\'s latest turn, the same payload as the session_status tool. '
          + 'Subscribe to this URI with subscriptions/listen before calling session_prompt { wait: false }: the '
          + 'endpoint publishes notifications/resources/updated here when that turn settles, including a failure.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const sessionId = String(variables.sessionId ?? '')
        const state = await driver.sessionStatus({ sessionId })
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(state),
          }],
        }
      },
    )
    // The progress feeds. Every one is a readable synthetic resource published
    // through the same listen channel; the collector decides when it is stale.
    if (feeds !== undefined) registerFeedResources(server, feeds, 'session')

    // A 2025-era client expresses "tell me when this changes" with
    // resources/subscribe. The SDK has no default handler for it, so a
    // spec-following client that had just seen resources.subscribe advertised got
    // "Method not found". The endpoint fans every known feed out to every live
    // stateful session (see LegacySessionManager), so acknowledging the
    // subscription is enough: the notifications arrive on its GET stream either
    // way, and filtering by URI is then the client's own concern.
    server.server.setRequestHandler('resources/subscribe', async () => ({}))
    server.server.setRequestHandler('resources/unsubscribe', async () => ({}))
    server.registerTool(
      'session_create',
      {
        title: 'Start a DSH agent session',
        description:
          'Create a new DeepSeek Harness agent session bound to a workspace (or a bare directory) and return '
          + 'its session id. Pass that id to session_prompt to make the DSH agent do work. Sessions are visible '
          + 'live in the DSH UI. Model selection falls back to this DSH instance\'s default route; provider and '
          + 'model must be given together (a half pair is refused before the session is created), and an '
          + 'unroutable pair still creates the session but says why in `modelSelectionError`. '
          + 'Pass `worktree: true` (or { name, from }) to also create a Git worktree from the workspace checkout '
          + 'and make it the session\'s live working directory: this is how several sessions in the same '
          + 'workspace group each work in an isolated checkout. A session created with workspaceId keeps that '
          + 'group membership (its durable directory stays the workspace); a cwd-only session stays outside every '
          + 'group, as before. The reply carries the created `worktree` record; '
          + 'a failed worktree request leaves the session usable in the workspace and reports `worktreeError` '
          + '(retry with worktree_create). Needs a profile with a worktrees service — dsh_info '
          + 'harnessServices.worktrees says whether this one has it.',
        inputSchema: z.object({
          workspaceId: z.string().optional().describe('Workspace id from workspace_list or workspace_create.'),
          cwd: z.string().optional().describe('Bare directory to bind the session to; use instead of workspaceId.'),
          agentPreset: z.string().optional().describe('Agent preset id; defaults to the harness default.'),
          provider: z.string().optional().describe('Model provider route. Must be paired with model.'),
          model: z.string().optional().describe('Model id. Must be paired with provider.'),
          worktree: z
            .union([
              z.boolean(),
              z.object({
                name: z
                  .string()
                  .optional()
                  .describe(
                    'New branch name, also the checkout directory name under the source checkout\'s '
                    + '.agents/worktrees/. Omit to let the harness generate dsh-<session uuid8>-<4 hex>.',
                  ),
                from: z
                  .string()
                  .optional()
                  .describe('Local commit, branch, or tag to start from; defaults to the checkout\'s HEAD.'),
              }),
            ])
            .optional()
            .describe(
              'Create a Git worktree for the session and enter it: true with generated names, or '
              + '{ name, from } to choose the branch and base revision. The session is created in the '
              + 'workspace/directory first, so a workspaceId-created session keeps its workspace group.',
            ),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_create', log, async (args) => ok(await driver.createSession({
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.worktree === undefined || args.worktree === false
          ? {}
          : { worktree: args.worktree === true ? {} : args.worktree }),
      }))),
    )

    server.registerTool(
      'worktree_create',
      {
        title: 'Create and enter a Git worktree for a session',
        description:
          'Create a new Git branch and checkout from the session\'s current checkout, then make that checkout '
          + 'the session\'s working directory — the same operation the DSH UI\'s "New worktree" option performs, '
          + 'for a session that already exists. Use it after `session_create` when you want several sessions in '
          + 'one workspace group to work in isolated checkouts: a session created with workspaceId keeps that '
          + 'group membership (its durable directory does not change) while its tools, commands and prompts run '
          + 'in the worktree; a cwd-only session stays outside every group, as before. '
          + 'Uncommitted files stay in the source checkout; existing branch or checkout names fail. The reply '
          + 'carries `path`, `branch`, `baseCommit`, `repositoryRoot` and the `from` revision (null for HEAD) — '
          + 'keep it if you may need worktree_restore. Requires the session\'s agent to resolve and a profile '
          + 'with a worktrees service (dsh_info harnessServices.worktrees).',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          name: z
            .string()
            .optional()
            .describe(
              'New branch name, also the checkout directory name under the source checkout\'s '
              + '.agents/worktrees/. Omit to let the harness generate dsh-<session uuid8>-<4 hex>.',
            ),
          from: z
            .string()
            .optional()
            .describe('Local commit, branch, or tag to start from; defaults to the checkout\'s HEAD.'),
        }),
        outputSchema: outputSchema({
          sessionId: z.string().optional(),
          path: z.string().optional(),
          branch: z.string().optional(),
          baseCommit: z.string().optional(),
          repositoryRoot: z.string().optional(),
          from: z.string().nullable().optional(),
        }),
        annotations: { openWorldHint: false },
      },
      guard('worktree_create', log, async (args, ctx) => {
        const signal = requestSignal(ctx)
        return ok(await driver.createWorktree({
          sessionId: args.sessionId,
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.from === undefined ? {} : { from: args.from }),
          ...(signal === undefined ? {} : { signal }),
        }))
      }),
    )

    server.registerTool(
      'worktree_restore',
      {
        title: 'Restore a removed worktree for a session',
        description:
          'Check a session\'s Git worktree out again at its recorded directory after it was removed outside the '
          + 'session. Pass the record worktree_create (or session_status.worktree) returned. The branch is '
          + 'checked out when it still exists, otherwise recreated at baseCommit; uncommitted changes that were '
          + 'lost with the directory cannot be recovered, and the session\'s working directory is not changed. '
          + 'Requires a profile with a worktrees service (dsh_info harnessServices.worktrees).',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id whose worktree is being restored.'),
          path: z.string().describe('Recorded checkout path (worktree_create reply: path).'),
          branch: z.string().describe('Recorded branch name (worktree_create reply: branch).'),
          baseCommit: z.string().describe('Recorded full commit object name (worktree_create reply: baseCommit).'),
          repositoryRoot: z
            .string()
            .describe('Recorded source checkout root (worktree_create reply: repositoryRoot).'),
        }),
        outputSchema: outputSchema({
          sessionId: z.string().optional(),
          path: z.string().optional(),
          branchRecreated: z.boolean().optional(),
        }),
        annotations: { openWorldHint: false },
      },
      guard('worktree_restore', log, async (args, ctx) => {
        const signal = requestSignal(ctx)
        return ok(await driver.restoreWorktree({
          sessionId: args.sessionId,
          path: args.path,
          branch: args.branch,
          baseCommit: args.baseCommit,
          repositoryRoot: args.repositoryRoot,
          ...(signal === undefined ? {} : { signal }),
        }))
      }),
    )

    server.registerTool(
      'session_list',
      {
        title: 'List DSH sessions',
        description:
          'List sessions known to this DeepSeek Harness, most recently updated first. Rows carry each '
          + 'session\'s archived and pinned flags — the same registry sets the DSH sidebar\'s archive and pin '
          + 'actions write — and includeWorktree folds in where each session is currently working.',
        inputSchema: z.object({
          limit: z.number().int().positive().max(200).optional().describe('Maximum sessions to return. Defaults to 20.'),
          includeTitle: z
            .boolean()
            .optional()
            .describe(
              'Also fold each session\'s latest title. Costs one durable-log read per session, so it is '
              + 'off by default; useful when picking a session by what it was about.',
            ),
          includeWorktree: z
            .boolean()
            .optional()
            .describe(
              'Also fold each session\'s live working directory and the worktree record the forge panel created '
              + 'for it (workingDirectory, worktree). Costs one projection read per session, so it is off by '
              + 'default; with several sessions of one workspace each working in its own checkout, this is how '
              + 'a caller tells which checkout a session is in.',
            ),
          cwd: z
            .string()
            .optional()
            .describe('Only sessions whose workspace directory is this path (canonicalised before matching).'),
          running: z
            .boolean()
            .optional()
            .describe('Only sessions that are currently running (true) or idle (false).'),
          origin: z
            .enum(['root', 'subagent'])
            .optional()
            .describe(
              'Only sessions this endpoint/DSH started (root), or only subagent sessions. Together with '
              + 'parentSessionId on each row, this is a tree view.',
            ),
        }),
        outputSchema: outputSchema({
          sessions: z.array(z.looseObject({})).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_list', log, async (args) => {
        const listed = await driver.listSessions(args.limit ?? 20, {
          ...(args.includeTitle === undefined ? {} : { includeTitle: args.includeTitle }),
          ...(args.includeWorktree === undefined ? {} : { includeWorktree: args.includeWorktree }),
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.running === undefined ? {} : { running: args.running }),
          ...(args.origin === undefined ? {} : { origin: args.origin }),
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
      'session_status',
      {
        title: 'Report one session\'s live state',
        description:
          'Report whether a session is running right now, which turn and step are open, how long its log '
          + 'has been quiet, and how the last turn ended — including a failure reason when it ended abnormally '
          + '(error, blocked, max-tokens, interrupted). This is the reporting channel for work started with '
          + 'session_prompt { wait: false }: poll it, or pass waitMs and the call returns as soon as anything '
          + 'changes or the bound elapses, whichever comes first. stalled is true when a turn is running but '
          + 'nothing has been written for a minute — a symptom worth reporting, not a verdict, because a model '
          + 'call may legitimately think for a long time. A turn that disappeared without a turn/end (the wait '
          + 'reports it as failure kind "vanished") also shows up here as not running with no fresh ending, so '
          + 'a supervisor never has to assume a silent session is healthy. When the profile can read session '
          + 'projections, the report also carries `workingDirectory` (the directory the session currently works '
          + 'in — a worktree checkout when it entered one) and `worktree` (the forge panel\'s record for a '
          + 'worktree it created).',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          waitMs: z
            .number()
            .int()
            .nonnegative()
            .max(60_000)
            .optional()
            .describe(
              'Hold the call until the session changes or this many milliseconds pass (capped at 60 s). '
              + 'Omitted or 0 answers immediately.',
            ),
        }),
        outputSchema: outputSchema({
          sessionId: z.string().optional(),
          running: z.boolean().optional(),
          openTurn: z.number().int().nullable().optional(),
          openStep: z.number().int().nullable().optional(),
          lastEventSeq: z.number().int().nullable().optional(),
          lastEventAt: z.string().nullable().optional(),
          idleMs: z.number().nullable().optional(),
          lastTurn: z
            .looseObject({
              turn: z.number().int(),
              endedAt: z.string().nullable(),
              reason: z.unknown(),
            })
            .nullable()
            .optional(),
          // The field a supervisor acts on: null for a completed turn, set (kind +
          // message) for an abnormal ending, including the wait-detected
          // "unreadable" and "vanished".
          failure: z.looseObject({ kind: z.string(), message: z.string() }).nullable().optional(),
          stalled: z.boolean().optional(),
          logReadable: z.boolean().optional(),
          workingDirectory: z.string().nullable().optional(),
          worktree: z.looseObject({}).nullable().optional(),
          changed: z.boolean().optional(),
          waitedMs: z.number().optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_status', log, async (args, ctx) => {
        const signal = requestSignal(ctx)
        return ok(await driver.sessionStatus({
          sessionId: args.sessionId,
          ...(args.waitMs === undefined ? {} : { waitMs: args.waitMs }),
          ...(signal === undefined ? {} : { signal }),
        }))
      }),
    )

    server.registerTool(
      'session_fork',
      {
        title: 'Fork a live DSH session',
        description:
          'Branch a live session into a child that inherits its event prefix up to an optional boundary. The '
          + 'child continues the same conversation without re-sending or re-priming it, so trying an alternative '
          + 'direction costs one new turn instead of a replay. The source may be a session that is live right now '
          + 'or one restored from disk, but it needs at least one completed turn: a session that has never '
          + 'answered has no prefix to branch from, and the harness refuses it with that explanation. The child '
          + 'is tracked as this endpoint\'s session and its inherited prefix is reported separately from its own '
          + 'spend by session_usage.',
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
          atTurn: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Fork through the end of this turn instead of naming a raw seq — the unit a caller bills in. '
              + 'Mutually exclusive with atSeq; an unknown turn lists the turns the log records.',
            ),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_fork', log, async (args) => ok(await driver.forkSession({
        sessionId: args.sessionId,
        ...(args.atSeq === undefined ? {} : { atSeq: args.atSeq }),
        ...(args.atTurn === undefined ? {} : { atTurn: args.atTurn }),
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
          'Change the provider route and model for the model calls that follow — including later steps of a '
          + 'turn that is already running. Useful to start on a '
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
          + 'message and return immediately — that is a fire-and-forget handoff, so follow it with session_status '
          + '(pass its waitMs to be told on the first change) or retry the same idempotencyKey with wait=true to '
          + 'await the turn. An abnormal ending is reported, never returned as an ordinary success: turn.failure '
          + 'carries {kind, message} for the harness\'s error, blocked, max-tokens and interrupted endings (and '
          + 'for an ending this build does not recognize); a completed turn, a caller-requested cancellation '
          + '(turn.aborted) and a fork boundary carry no failure block. '
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
              + 'content is refused. A retry with the same key and wait:true waits for that turn, which is how '
              + 'a caller awaits work it queued with wait:false. Use one key per logical message when your own '
              + 'timeout may cause retries.',
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
          wait: z
            .boolean()
            .optional()
            .describe(
              'true (default) waits for the turn to settle. false returns as soon as the message is queued — '
              + 'follow it with session_status, which reports whether the session is running, how long its log '
              + 'has been quiet, and how the turn ended (including a failure). A modern (2026-07-28) client that '
              + 'opened a subscriptions/listen stream for dsh://session/<sessionId>/turn BEFORE this call gets '
              + 'notifications/resources/updated when the turn settles, instead of polling.',
            ),
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
        outputSchema: outputSchema({
          accepted: z.boolean().optional(),
          replayed: z.boolean().optional(),
          turn: z
            .looseObject({
              reply: z.string().optional(),
              replyChars: z.number().int().optional(),
              models: z.array(z.string()).optional(),
              toolCalls: z.array(z.looseObject({})).optional(),
              turn: z.number().int().nullable().optional(),
              turnEndReason: z.unknown().optional(),
              timedOut: z.boolean().optional(),
              aborted: z.boolean().optional(),
              // Present only for an abnormal ending; absent for a completed turn,
              // a caller-requested cancellation and a fork boundary.
              failure: z.looseObject({ kind: z.string(), message: z.string() }).optional(),
              durationMs: z.number().optional(),
              usage: z.looseObject({}).optional(),
            })
            .optional(),
          session: z.looseObject({}).optional(),
          usageUnavailable: z.boolean().optional(),
          reason: z.string().optional(),
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
                // The silence is reported separately from the elapsed wait: a turn
                // can be long and healthy, or long and dead, and only the second
                // number tells them apart.
                const quiet = update.idleMs >= 2_000
                  ? `, log quiet for ${Math.round(update.idleMs / 1_000)}s`
                  : ''
                progress(
                  `turn ${update.turn ?? '?'}: ${update.toolCalls} tool call(s), `
                  + `${Math.round(update.elapsedMs / 1_000)}s elapsed${quiet}`
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
          turn: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              'Only rows the log attributes to this turn (assistant and tool rows carry turn/step; the user '
              + 'prompt itself has no turn number, so it is not part of a turn-filtered read).',
            ),
          fromTurn: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Only rows attributed to turns at or after this one, for reading one phase of a long transcript. '
              + 'Same attribution rule as turn: prompt rows carry no turn and are not included.',
            ),
          toTurn: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Only rows attributed to turns at or before this one.'),
          includeToolResults: z
            .union([z.boolean(), z.literal('errors')])
            .optional()
            .describe(
              'Also include tool results as role "tool" rows (callId, text, error), so one read covers the whole '
              + 'timeline; "errors" keeps only the ones the harness marked as failures, which is the quickest way '
              + 'to see why a turn went wrong. Off by default because a result can be as large as a file; each '
              + 'row obeys maxCharsPerMessage.',
            ),
          includeToolCalls: z
            .boolean()
            .optional()
            .describe(
              'Also return each assistant message\'s tool calls (name, call id, argument JSON length). Off by '
              + 'default so a prose-only read does not grow by every invocation in the session.',
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
          ...(args.fromTurn === undefined ? {} : { fromTurn: args.fromTurn }),
          ...(args.toTurn === undefined ? {} : { toTurn: args.toTurn }),
          ...(args.includeToolCalls === undefined ? {} : { includeToolCalls: args.includeToolCalls }),
          ...(args.includeToolResults === undefined ? {} : { includeToolResults: args.includeToolResults }),
          ...(args.turn === undefined ? {} : { turn: args.turn }),
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
      'session_tool_result',
      {
        title: 'Read one recorded tool result',
        description:
          'Return the recorded textual result of one tool call, addressed by the call id from '
          + 'session_messages { includeToolCalls: true }. Use it to read what a tool actually returned (an '
          + 'error message, a failing test) without re-reading the transcript; the call is capped by maxChars '
          + 'and reports its original length and whether the harness marked it an error. Address it by callId, '
          + 'or by toolName to read the most recent completed call of that tool.',
        inputSchema: z.object({
          sessionId: z.string(),
          callId: z.string().min(1).optional()
            .describe('Tool call id from session_messages { includeToolCalls: true }. Pass this or toolName.'),
          toolName: z.string().min(1).optional()
            .describe('Or: the most recent completed call of this tool name (the reply names the resolved call id).'),
          maxChars: z.number().int().positive().max(100_000).optional()
            .describe('Cap on the returned text. Defaults to 4000 characters.'),
          from: z.enum(['start', 'end']).optional()
            .describe(
              'Which end to keep when the result is longer than maxChars. Defaults to start; end is useful '
              + 'for a stack trace or error at the tail.',
            ),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_tool_result', log, async (args) => ok(await driver.readToolResult({
        sessionId: args.sessionId,
        ...(args.callId === undefined ? {} : { callId: args.callId }),
        ...(args.toolName === undefined ? {} : { toolName: args.toolName }),
        maxChars: args.maxChars ?? 4_000,
        ...(args.from === undefined ? {} : { from: args.from }),
      }))),
    )

    server.registerTool(
      'session_cancel',
      {
        title: 'Cancel a DSH turn',
        description: 'Ask the agent in this session to stop its current turn. Queued work is preserved.',
        inputSchema: z.object({ sessionId: z.string() }),
        annotations: { openWorldHint: false },
      },
      guard('session_cancel', log, async (args) => ok(await driver.cancelSession(args.sessionId))),
    )

    server.registerTool(
      'session_archive',
      {
        title: 'Archive a DSH session',
        description:
          'Archive a session in this DSH instance — the same registry-global archive the sidebar\'s archive '
          + 'action writes. An archived session disappears from the DSH UI\'s grouping and its future turns are '
          + 'refused, but its log is kept, so session_unarchive restores it to its recorded position. Archiving '
          + 'a session that still has running work is refused unless `stopActivity: true` is passed, which also '
          + 'asks that work to stop; that flag is deliberately something a caller must ask for. Nothing is '
          + 'deleted. session_list reports each session\'s archived flag.',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          stopActivity: z
            .boolean()
            .optional()
            .describe(
              'Stop the session\'s running work (turn, subagents, jobs) before archiving. Required when the '
              + 'session is active; without it an active session is refused.',
            ),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_archive', log, async (args) => ok(await driver.archiveSession({
        sessionId: args.sessionId,
        ...(args.stopActivity === undefined ? {} : { stopActivity: args.stopActivity }),
      }))),
    )

    server.registerTool(
      'session_unarchive',
      {
        title: 'Unarchive a DSH session',
        description:
          'Return an archived session to its recorded position in the DSH UI. Idempotent: an id that is not '
          + 'archived is not an error. The session log was never touched, so this makes it visible and '
          + 'promptable again.',
        inputSchema: z.object({ sessionId: z.string() }),
        annotations: { openWorldHint: false },
      },
      guard('session_unarchive', log, async (args) => ok(await driver.unarchiveSession({ sessionId: args.sessionId }))),
    )

    server.registerTool(
      'session_pin',
      {
        title: 'Pin a DSH session',
        description:
          'Pin a session to the top of the DSH UI\'s session list (the same pin set the sidebar writes). A '
          + 'pinned session must exist and must not be archived; pinning is idempotent. session_list reports '
          + 'each session\'s pinned flag.',
        inputSchema: z.object({ sessionId: z.string() }),
        annotations: { openWorldHint: false },
      },
      guard('session_pin', log, async (args) => ok(await driver.pinSession({ sessionId: args.sessionId }))),
    )

    server.registerTool(
      'session_unpin',
      {
        title: 'Unpin a DSH session',
        description: 'Remove a session from the DSH UI\'s pin set. Idempotent: an id that is not pinned is not an error.',
        inputSchema: z.object({ sessionId: z.string() }),
        annotations: { openWorldHint: false },
      },
      guard('session_unpin', log, async (args) => ok(await driver.unpinSession({ sessionId: args.sessionId }))),
    )

    server.registerTool(
      'session_command_list',
      {
        title: 'List a DSH session\'s slash commands',
        description:
          'The slash commands this session\'s agent can run, with a one-line description and an input hint. '
          + 'A command executes without a model turn — the handler runs directly — so this is the cheap way to '
          + 'compact a long session, export its log, enter plan mode or set a goal, exactly as a human typing '
          + 'into the DSH composer would. Each entry carries `permitted`: the endpoint only executes the '
          + 'user-plane commands (`/compact`, `/plan`, `/goal`, `/export`) and refuses `/permission` and '
          + '/feedback on purpose. Run one with session_command.',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_command_list', log, async (args) => ok(await driver.listSessionCommands({
        sessionId: args.sessionId,
      }))),
    )

    server.registerTool(
      'session_command',
      {
        title: 'Run a DSH slash command on a session',
        description:
          'Execute one slash command against a session\'s agent without spending a model turn. Give the '
          + 'command with or without its leading slash, plus any arguments in the same string: "compact", '
          + '"/export", "/goal finish the migration", "/plan off". The harness appends a command/run and '
          + 'command/done event to the session log, so the human sees what was run. Only the user-plane '
          + 'commands are permitted — `/permission` (would change the session permission preset) and '
          + '/feedback (would write the user\'s own review records) are refused before any handler runs, and '
          + 'a name that is not registered on this profile is refused with the admitted set. Call '
          + 'session_command_list first to see the exact names and the input hint this agent accepts.',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          command: z
            .string()
            .min(1)
            .describe('Command line, e.g. "compact", "/export", "/goal <objective>", "/plan off".'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_command', log, async (args, ctx) => {
        const signal = requestSignal(ctx)
        return ok(await driver.runSessionCommand({
          sessionId: args.sessionId,
          command: args.command,
          ...(signal === undefined ? {} : { signal }),
        }))
      }),
    )

    server.registerTool(
      'session_goal',
      {
        title: 'Read or change a DSH session\'s durable goal',
        description:
          'A goal is the session\'s long-running objective: the harness\'s round driver keeps advancing it '
          + 'across turns, which is how a caller delegates multi-hour work instead of holding one turn open. '
          + 'With action "get" this returns the current goal (or null); "create" needs `objective`; "edit" '
          + 'needs `objective` and/or `maxGoalRounds`; "pause", "resume", "complete" and "clear" act on the '
          + 'goal that exists now. Pass `expectedRevision` (from a previous read) to refuse a mutation whose '
          + 'goal changed underneath you — the equivalent of the UI\'s conflict handling. "complete" marks the '
          + 'goal complete and reports it back with `phase: \"complete\"`; only "clear" removes it, and that '
          + 'reply carries `goal: null` plus `cleared: true`. The objective text is what the DSH goal strip '
          + 'shows.',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          action: z
            .enum(['get', 'create', 'edit', 'pause', 'resume', 'complete', 'clear'])
            .describe('get reads; the rest mutate.'),
          objective: z.string().optional().describe('New objective text (create, edit).'),
          maxGoalRounds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Automatic continuation round cap (create, edit).'),
          expectedRevision: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Refuse the mutation unless the goal is still at this revision.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('session_goal', log, async (args) => {
        if (args.action === 'get') {
          return ok(await driver.sessionGoal({ sessionId: args.sessionId }))
        }
        return ok(await driver.mutateSessionGoal({
          sessionId: args.sessionId,
          action: args.action,
          ...(args.objective === undefined ? {} : { objective: args.objective }),
          ...(args.maxGoalRounds === undefined ? {} : { maxGoalRounds: args.maxGoalRounds }),
          ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
        }))
      }),
    )

    server.registerTool(
      'schedule_create',
      {
        title: 'Create a scheduled DSH task',
        description:
          'Create a Host-level scheduled task: an instruction the harness delivers to a conversation at each '
          + 'occurrence, whether or not this endpoint is running. Give exactly one timing form — `rrule` (one '
          + 'DTSTART line plus one RRULE line, the same RFC 5545 subset the DSH Automation page writes), '
          + '`afterSeconds` for a one-shot N seconds from now, or `everySeconds` for a fixed interval. `target` '
          + 'decides where each delivery lands: "session" updates an existing conversation (needs `sessionId`), '
          + '"new_once" creates one conversation on the first delivery and reuses it, "new" starts a fresh '
          + 'conversation every time; the two new-conversation targets accept `cwd` and `agentPreset`. Tasks '
          + 'belong to the Host, not to a session, so this surface is refused while session.scope is "owned" — '
          + 'a Host record has no owning session to filter on. The reply is the stored task with its generated '
          + 'id, first occurrence and status.',
        inputSchema: z.object({
          title: z
            .string()
            .min(1)
            .max(120)
            .describe('Short name for the task, at most 120 characters (action plus object, no ids).'),
          prompt: z.string().min(1).describe('Instruction delivered to the target conversation each time.'),
          rrule: z
            .string()
            .optional()
            .describe('One DTSTART line and one RRULE line (RFC 5545 subset), e.g. "DTSTART;TZID=Asia/Singapore:20260901T080000\\nRRULE:FREQ=DAILY;COUNT=3".'),
          afterSeconds: z
            .number()
            .positive()
            .optional()
            .describe('One-shot timing: deliver once, this many seconds from now.'),
          everySeconds: z
            .number()
            .positive()
            .optional()
            .describe('Fixed-interval timing: deliver every this many seconds.'),
          target: z
            .enum(['session', 'new_once', 'new'])
            .optional()
            .describe('Where deliveries land. Defaults to "session" when sessionId is given, otherwise "new".'),
          sessionId: z.string().optional().describe('Existing conversation to update (target "session").'),
          cwd: z.string().optional().describe('Directory for a created conversation (target "new"/"new_once").'),
          agentPreset: z.string().optional().describe('Agent preset for a created conversation.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('schedule_create', log, async (args) => ok(await driver.createScheduledTask({
        title: args.title,
        prompt: args.prompt,
        ...(args.rrule === undefined ? {} : { rrule: args.rrule }),
        ...(args.afterSeconds === undefined ? {} : { afterSeconds: args.afterSeconds }),
        ...(args.everySeconds === undefined ? {} : { everySeconds: args.everySeconds }),
        ...(args.target === undefined ? {} : { target: args.target }),
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
      }))),
    )

    server.registerTool(
      'schedule_list',
      {
        title: 'List scheduled DSH tasks',
        description:
          'One page of Host scheduled tasks, active ones first by next occurrence and paused/ended ones after. '
          + '`active: true` keeps only active tasks, `false` only paused and ended ones; absent returns every '
          + 'task. Each row carries the task id, title, prompt, its timing fields, `scheduledAt`, status, target '
          + 'and the last delivery when it has fired. Tasks are Host records: this lists tasks any session '
          + 'created, and it is refused while session.scope is "owned".',
        inputSchema: z.object({
          active: z.boolean().optional().describe('Filter by state: true active only, false paused/ended only.'),
          limit: z.number().int().positive().optional().describe('Page size, 1-200 (default 20).'),
          offset: z.number().int().nonnegative().optional().describe('Rows to skip.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('schedule_list', log, async (args) => ok(await driver.listScheduledTasks({
        ...(args.active === undefined ? {} : { active: args.active }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.offset === undefined ? {} : { offset: args.offset }),
      }))),
    )

    server.registerTool(
      'schedule_view',
      {
        title: 'Read one scheduled DSH task',
        description:
          'One Host scheduled task by id, with the same fields schedule_list reports plus its delivery target '
          + 'detail. An id that no longer exists answers `{ "found": false, "id": ... }` rather than an error, '
          + 'so a cleanup loop can be idempotent. Refused while session.scope is "owned".',
        inputSchema: z.object({
          scheduleId: z.string().min(1).describe('Task id from schedule_create or schedule_list.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('schedule_view', log, async (args) => ok(await driver.viewScheduledTask({
        scheduleId: args.scheduleId,
      }))),
    )

    server.registerTool(
      'schedule_edit',
      {
        title: 'Update or delete a scheduled DSH task',
        description:
          'Change or remove one Host scheduled task. action "update" needs at least one of `title`, `prompt`, a '
          + 'timing form (`rrule`, `afterSeconds` or `everySeconds`), a `target` (with `sessionId` for "session", '
          + 'or `cwd`/`agentPreset` for "new"/"new_once"), or `active` — `false` pauses the task and `true` '
          + 'resumes it (a resume needs a future occurrence, so supply a new timing if the old rule is '
          + 'exhausted). action "delete" removes the task and its saved delivery records and accepts no change '
          + 'fields. `expectedUpdatedAt` is the lost-update guard: if the task changed after that read, the call '
          + 'answers `conflict: true` and changes nothing. Refused while session.scope is "owned".',
        inputSchema: z.object({
          scheduleId: z.string().min(1).describe('Task id from schedule_create or schedule_list.'),
          action: z.enum(['update', 'delete']).describe('update changes fields; delete removes the task.'),
          title: z.string().min(1).max(120).optional().describe('New title.'),
          prompt: z.string().min(1).optional().describe('New instruction.'),
          rrule: z.string().optional().describe('New recurrence (DTSTART + RRULE lines).'),
          afterSeconds: z.number().positive().optional().describe('New one-shot timing, seconds from now.'),
          everySeconds: z.number().positive().optional().describe('New fixed-interval timing, seconds.'),
          target: z.enum(['session', 'new_once', 'new']).optional().describe('New delivery target kind.'),
          sessionId: z.string().optional().describe('Existing conversation for target "session".'),
          cwd: z.string().optional().describe('Directory for a created conversation.'),
          agentPreset: z.string().optional().describe('Agent preset for a created conversation.'),
          active: z.boolean().optional().describe('false pauses the task, true resumes it.'),
          expectedUpdatedAt: z
            .string()
            .nullable()
            .optional()
            .describe('Refuse the change unless the task still carries this updatedAt (null matches a task never updated).'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('schedule_edit', log, async (args) => ok(await driver.editScheduledTask({
        scheduleId: args.scheduleId,
        action: args.action,
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
        ...(args.rrule === undefined ? {} : { rrule: args.rrule }),
        ...(args.afterSeconds === undefined ? {} : { afterSeconds: args.afterSeconds }),
        ...(args.everySeconds === undefined ? {} : { everySeconds: args.everySeconds }),
        ...(args.target === undefined ? {} : { target: args.target }),
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
        ...(args.active === undefined ? {} : { active: args.active }),
        ...(args.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: args.expectedUpdatedAt }),
      }))),
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
          fromTurn: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'With toTurn, fold only the turns in this inclusive range (bill a task phase rather than the whole '
              + 'session). Like a sinceSeq window, it is not compared with the harness projection.',
            ),
          toTurn: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Inclusive upper turn bound; defaults to the last turn.'),
          sinceSeq: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              'Fold each row from this event seq onward, for an incremental receipt on a long session. A '
              + 'windowed report cannot be compared with the harness projection (it covers the whole log), so '
              + 'verifiedAgainstProjection is false for it; turns that started before the window are only '
              + 'partly inside the segment.',
            ),
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
        ...(args.sinceSeq === undefined ? {} : { sinceSeq: args.sinceSeq }),
        ...(args.fromTurn === undefined ? {} : { fromTurn: args.fromTurn }),
        ...(args.toTurn === undefined ? {} : { toTurn: args.toTurn }),
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
          sha256: z
            .boolean()
            .optional()
            .describe(
              'Also return the SHA-256 of the whole file (not of the returned window), as the '
              + 'expectedSha256 a later write/edit can carry. Reads the whole file, so it refuses one above '
              + 'limits.maxReadBytes.',
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
          ...(args.sha256 === undefined ? {} : { sha256: args.sha256 }),
          ...(args.sha256 === true ? { sha256Limit: limit } : {}),
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
          expectedSha256: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional()
            .describe(
              'Compare-and-swap guard: write only if the file currently hashes to this (returned as sha256 by '
              + 'a previous write/read). A mismatch names the actual hash and writes nothing; the file must '
              + 'already exist.',
            ),
        }),
        annotations: { openWorldHint: false },
      },
      guard('file_write', log, async (args) => ok(await driver.writeFile({
        path: args.path,
        content: args.content,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        createDirectories: args.createDirectories ?? true,
        ...(args.expectedSha256 === undefined ? {} : { expectedSha256: args.expectedSha256 }),
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
          sha256: z
            .boolean()
            .optional()
            .describe(
              'Also hash each file\'s content (SHA-256) for bulk change detection. Files above '
              + 'limits.maxReadBytes carry sha256Unavailable with the reason instead of a hash, so a partial '
              + 'picture is never passed off as complete.',
            ),
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
        ...(args.sha256 === undefined ? {} : { sha256: args.sha256 }),
        ...(args.sha256 === true ? { sha256Limit: getConfig().limits.maxReadBytes } : {}),
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
          expectedSha256: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional()
            .describe(
              'Compare-and-swap guard over the whole file: edit only if it currently hashes to this. A '
              + 'mismatch names the actual hash and writes nothing.',
            ),
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
        ...(args.expectedSha256 === undefined ? {} : { expectedSha256: args.expectedSha256 }),
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
    // Job feeds live with the shell group: they only exist when the endpoint can
    // start jobs in the first place.
    if (feeds !== undefined) registerFeedResources(server, feeds, 'shell')
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
