/**
 * Derive, per tool, whether this deployment can actually serve it.
 *
 * `dsh_info.harnessServices` answers "is this service mounted"; it does not answer
 * the question a caller actually has, which is "will `shell_start` work here?".
 * The mapping is small but version-sensitive (a profile can mount `shell` and not
 * `shell.start`), and getting it wrong in prose is how documentation drifts. So it
 * is code, next to the probe names it consumes, and `dsh_info` reports it.
 *
 * A tool is reported available unless a rule proves otherwise: the report is a
 * pre-flight aid for avoiding a doomed call, not a second authorization layer —
 * every tool still checks its own service at call time.
 *
 * @module dsh-as-mcp/mcp/availability
 */

import type { Config, ToolToggles } from '../config.js'

/** Why one tool is unavailable. */
export interface UnavailableTool {
  readonly tool: string
  readonly reason: string
}

/** The pre-flight view `dsh_info` reports. */
export interface ToolAvailability {
  /** Number of advertised tools that passed every rule (`dsh_info` included). */
  readonly available: number
  /** The tools that passed, so a caller can compare this with `tools/list`. */
  readonly availableTools: readonly string[]
  /** Tools a caller should not bother calling, each with the concrete reason. */
  readonly unavailable: readonly UnavailableTool[]
  /** Caveats that do not make a tool unavailable. */
  readonly notes?: readonly string[]
}

/** Tools per group, in registration order. */
const GROUP_TOOLS: Record<keyof ToolToggles, readonly string[]> = {
  workspace: ['workspace_create', 'workspace_list', 'workspace_delete'],
  session: [
    'session_create', 'worktree_create', 'worktree_restore', 'session_search', 'session_status', 'session_list',
    'session_prompt', 'session_messages', 'session_tool_result', 'session_queue', 'session_cancel', 'session_fork',
    'session_rename', 'session_set_model', 'session_archive', 'session_unarchive', 'session_pin', 'session_unpin',
    'session_command_list', 'session_command', 'session_goal',
    'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  ],
  files: ['file_read', 'file_read_image', 'file_write', 'file_edit', 'file_list'],
  shell: ['shell_run', 'shell_start', 'shell_output', 'shell_kill', 'shell_list'],
  agentTools: ['dsh_tool_list', 'dsh_tool_call'],
  usage: ['session_usage'],
}

/** Group label used in reasons. */
const GROUP_LABEL: Record<keyof ToolToggles, string> = {
  workspace: 'workspaces',
  session: 'sessions',
  files: 'files',
  shell: 'shell',
  agentTools: 'agent tools',
  usage: 'usage',
}

/**
 * Capabilities every tool needs, all of them.
 *
 * Absent entries (`dsh_info`, `file_write`, ...) need only their group's service,
 * which the group table already covers; this map is where the *extra* dependency
 * of a specific tool lives.
 */
const REQUIRED_CAPABILITIES: Record<string, readonly string[]> = {
  workspace_create: ['workspaceRegistry'],
  workspace_list: ['workspaceRegistry'],
  workspace_delete: ['workspaceRegistry'],
  session_create: ['sessionController'],
  worktree_create: ['sessionController', 'agentResolve', 'worktrees'],
  worktree_restore: ['sessionController', 'agentResolve', 'worktrees'],
  session_archive: ['sessionController', 'sessionArchive'],
  session_unarchive: ['sessionController', 'sessionArchive'],
  session_pin: ['sessionController', 'sessionPin'],
  session_command_list: ['sessionController', 'agentResolve', 'commands'],
  session_command: ['sessionController', 'agentResolve', 'commands'],
  session_goal: ['sessionController', 'agentResolve', 'goals'],
  schedule_create: ['schedule'],
  schedule_list: ['schedule'],
  schedule_view: ['schedule'],
  schedule_edit: ['schedule'],
  session_unpin: ['sessionController', 'sessionPin'],
  session_search: ['sessionController', 'sessionSearch'],
  session_list: ['sessionController'],
  session_status: ['sessionController'],
  session_prompt: ['sessionController'],
  session_messages: ['sessionController'],
  session_tool_result: ['sessionController'],
  session_queue: ['sessionController', 'sessionQueue'],
  session_cancel: ['sessionController'],
  session_fork: ['sessionController', 'sessionFork'],
  session_rename: ['sessionController', 'sessionRename'],
  session_set_model: ['sessionController', 'sessionModel'],
  session_usage: ['tokenUsage'],
  file_read: ['fs'],
  file_read_image: ['fs'],
  file_write: ['fs'],
  file_edit: ['fs'],
  file_list: ['fs'],
  shell_run: ['shell'],
  shell_start: ['shell', 'shellBackground'],
  shell_output: ['shell', 'shellBackground'],
  shell_kill: ['shell', 'shellBackground'],
  shell_list: ['shell', 'shellBackground'],
  dsh_tool_list: ['tools', 'agents'],
  dsh_tool_call: ['tools', 'agents'],
}

/** Human phrases for the probes, so the reason is about a service, not a flag. */
const CAPABILITY_LABEL: Record<string, string> = {
  workspaceRegistry: 'a workspace registry',
  sessionController: 'a session controller',
  sessionSearch: 'sessionController.search()',
  sessionQueue: 'sessionController.updateQueue()',
  sessionFork: 'sessionController.fork()',
  sessionRename: 'sessionController.rename()',
  sessionModel: 'sessionController.selectModel()',
  worktrees: 'a worktree service (the forge bundle in DSH Desktop/Web)',
  commands: 'a command registry (ctx.commands)',
  goals: 'a goal store (ctx.goals)',
  schedule: 'a schedule service (ctx.schedule)',
  agentResolve: 'sessionController.resolveAgent()',
  sessionViews: 'readable session projections',
  sessionArchive: 'workspaceRegistry.archiveSession()',
  sessionPin: 'workspaceRegistry.pinSession()',
  tokenUsage: 'a readable session log',
  fs: 'a filesystem service',
  shell: 'a shell service',
  shellBackground: 'a shell service with start()/execute()',
  tools: 'a tool registry',
  agents: 'an agents service',
}

/**
 * Compute the per-tool pre-flight report.
 *
 * @param enabled - The configured tool-group toggles.
 * @param capabilities - `DshDriver.describeCapabilities()`.
 * @param config - The effective configuration (for the agent-tool allow-list note).
 * @returns Available count, unavailable tools with reasons, and non-blocking notes.
 */
export function describeToolAvailability(
  enabled: ToolToggles,
  capabilities: Readonly<Record<string, boolean>>,
  config: Config,
): ToolAvailability {
  const unavailable: UnavailableTool[] = []
  const notes: string[] = []
  // `dsh_info` has no dependency beyond the plugin itself.
  const availableTools: string[] = ['dsh_info']

  for (const [group, tools] of Object.entries(GROUP_TOOLS) as [keyof ToolToggles, readonly string[]][]) {
    if (enabled[group] !== true) {
      for (const tool of tools) {
        unavailable.push({ tool, reason: `the ${GROUP_LABEL[group]} tool group is disabled (tools.${group}: false)` })
      }
      continue
    }
    for (const tool of tools) {
      const required = REQUIRED_CAPABILITIES[tool] ?? []
      const missing = required.find((probe) => capabilities[probe] !== true)
      if (missing === undefined) {
        availableTools.push(tool)
        continue
      }
      unavailable.push({
        tool,
        reason: `this DSH profile provides no ${CAPABILITY_LABEL[missing] ?? missing} (${missing})`,
      })
    }
  }

  if (enabled.session && capabilities['sessionSearch'] !== true) {
    notes.push(
      'session_search also needs an open session-query index; dsh_info { probeSearch: true } reports whether this '
        + 'deployment has one.',
    )
  }
  if (enabled.session && capabilities['worktrees'] !== true) {
    notes.push(
      'Without a worktrees service, session_create { worktree } is refused before the session is created, and '
        + 'worktree_create/worktree_restore are unavailable; sessions still work in the workspace directory itself.',
    )
  }
  if (enabled.session && capabilities['sessionViews'] !== true) {
    notes.push(
      'Without readable session projections, session_status and session_list cannot report workingDirectory or '
        + 'the forge worktree record; the rest of both replies is unchanged.',
    )
  }
  if (enabled.session && (capabilities['sessionArchive'] !== true || capabilities['sessionPin'] !== true)) {
    notes.push(
      'Archive/pin tools need the workspace registry\'s archive and pin operations; without them the sidebar '
        + 'sets cannot be written from this endpoint.',
    )
  }
  if (enabled.agentTools && capabilities['tools'] === true && capabilities['agents'] === true
    && config.agentTools.allow.length === 0) {
    notes.push('dsh_tool_call uses the built-in allow-list (agentTools.allow is empty).')
  }
  if (enabled.usage && capabilities['tokenUsage'] !== true) {
    notes.push(
      'With no readable session log, usage is unavailable in both session_usage and the session_prompt receipts.',
    )
  }

  return {
    available: availableTools.length,
    availableTools,
    unavailable,
    ...(notes.length === 0 ? {} : { notes }),
  }
}
