import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { Config } from '../config.js'
import type { DshDriver } from '../dsh/driver.js'

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
}

/** What {@link registerTools} needs beyond the server itself. */
export interface ToolDeps {
  readonly driver: McpDriver
  readonly config: Config
  readonly connection: () => ConnectionInfo
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
  | 'createWorkspace'
  | 'listWorkspaces'
  | 'createSession'
  | 'listSessions'
  | 'promptSession'
  | 'cancelSession'
  | 'readTranscript'
  | 'readFile'
  | 'writeFile'
  | 'listDirectory'
  | 'runShell'
>

/** Pretty-printed JSON as ordinary text content — the one shape every MCP client renders. */
function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** Wrap a tool body so a harness failure becomes a readable tool error, not a transport error. */
function guard<A>(name: string, body: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await body(args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const detail = error instanceof Error && error.stack !== undefined ? `\n${error.stack}` : ''
      return {
        content: [{ type: 'text', text: `${name} failed: ${message}${detail}` }],
        isError: true,
      }
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
  const { driver, config, connection } = deps
  const enabled = config.tools

  server.registerTool(
    'dsh_info',
    {
      title: 'Describe this DSH MCP endpoint',
      description:
        'Report which DeepSeek Harness services this endpoint can drive, which tool groups are enabled, '
        + 'and the URL plus bearer token an MCP client needs. Call this first when you are unsure whether '
        + 'a capability (sessions, files, shell) is available in this DSH profile.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard('dsh_info', async () => {
      const info = connection()
      return ok({
        endpoint: info.url,
        bearerToken: info.token,
        tokenSource: info.tokenSource,
        mountedOnDshWebServer: info.mountedOnWebServer,
        enabledToolGroups: enabled,
        harnessServices: driver.describeCapabilities(),
        notes: [
          'workspace_* and session_* drive this DSH instance directly; work appears live in the DSH UI.',
          'session_prompt waits for the turn to settle by default and returns the agent reply plus its tool calls.',
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
      guard('workspace_create', async (args) => ok(await driver.createWorkspace({
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
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('workspace_list', async () => ok({ workspaces: await driver.listWorkspaces() })),
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
      guard('session_create', async (args) => ok(await driver.createSession({
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
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_list', async (args) => ok({ sessions: await driver.listSessions(args.limit ?? 20) })),
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
          + 'message and return immediately.',
        inputSchema: z.object({
          sessionId: z.string().describe('Session id from session_create or session_list.'),
          prompt: z.string().min(1).describe('The task or question for the DSH agent.'),
          mode: z
            .enum(['queue', 'steer'])
            .optional()
            .describe('queue (default) runs a new turn; steer delivers into the running turn.'),
          wait: z.boolean().optional().describe('Wait for the turn to settle. Defaults to true.'),
          timeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Upper bound for the wait. Defaults to the endpoint configuration.'),
        }),
        annotations: { openWorldHint: true },
      },
      guard('session_prompt', async (args) => ok(await driver.promptSession({
        sessionId: args.sessionId,
        prompt: args.prompt,
        mode: args.mode ?? 'queue',
        wait: args.wait ?? true,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      }))),
    )

    server.registerTool(
      'session_messages',
      {
        title: 'Read a DSH session transcript',
        description: 'Return the most recent user and assistant messages of one session, oldest first.',
        inputSchema: z.object({
          sessionId: z.string(),
          limit: z.number().int().positive().max(500).optional().describe('Maximum messages to return. Defaults to 50.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('session_messages', async (args) => ok({
        messages: await driver.readTranscript(args.sessionId, args.limit ?? 50),
      })),
    )

    server.registerTool(
      'session_cancel',
      {
        title: 'Cancel a DSH turn',
        description: 'Ask the agent in this session to stop its current turn. Queued work is preserved.',
        inputSchema: z.object({ sessionId: z.string() }),
        annotations: { openWorldHint: false },
      },
      guard('session_cancel', async (args) => ok(driver.cancelSession(args.sessionId))),
    )
  }

  if (enabled.files) {
    server.registerTool(
      'file_read',
      {
        title: 'Read a file through DSH',
        description:
          'Read a UTF-8 text file through this DSH instance\'s filesystem service, so the same path rules and '
          + 'sandboxing the DSH agent uses apply to you. Output is truncated at the configured byte limit.',
        inputSchema: z.object({
          path: z.string().describe('File path; relative paths resolve against cwd.'),
          cwd: z.string().optional().describe('Base directory for a relative path; defaults to the DSH process cwd.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('file_read', async (args) => ok(await driver.readFile({
        path: args.path,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        maxBytes: config.limits.maxReadBytes,
      }))),
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
            .describe('Create missing parent directories. Defaults to true.'),
        }),
        annotations: { openWorldHint: false },
      },
      guard('file_write', async (args) => ok(await driver.writeFile({
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
        description: 'List one directory level through this DSH instance\'s filesystem service.',
        inputSchema: z.object({
          path: z.string().describe('Directory path; relative paths resolve against cwd.'),
          cwd: z.string().optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      guard('file_list', async (args) => ok(await driver.listDirectory({
        path: args.path,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
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
      guard('shell_run', async (args) => ok(await driver.runShell({
        command: args.command,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        timeoutMs: args.timeoutMs ?? config.limits.shellTimeoutMs,
      }))),
    )
  }
}
