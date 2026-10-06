/**
 * The single source of every configuration default.
 *
 * Two code paths can produce a plugin configuration: `normalizeConfig()` for the
 * composition entry (`cordis.patch.yml`), and the settings-service schema a user
 * edits in the DSH settings panel. If those two disagreed about a default, the
 * same knob would read one way from the file and another from the panel — a
 * difference that is invisible until someone sets one field and wonders why
 * another changed. Both read these constants, and a test asserts the two paths
 * resolve an empty input identically.
 */

import type {
  AgentToolsConfig,
  ApprovalConfig,
  AuthConfig,
  Config,
  HttpConfig,
  LimitsConfig,
  SessionConfig,
  ToolToggles,
} from './config.js'

/** {@link HttpConfig} defaults. */
export const DEFAULT_HTTP = {
  enabled: true,
  host: '127.0.0.1',
  port: 8790,
  path: '/mcp',
  mountOnWebServer: false,
} as const satisfies HttpConfig

/** {@link AuthConfig} defaults: no pinned token, so the file token is used. */
export const DEFAULT_AUTH = { token: '' } as const satisfies AuthConfig

/** {@link ToolToggles} defaults: every group exposed. */
export const DEFAULT_TOOLS = {
  workspace: true,
  session: true,
  files: true,
  shell: true,
  agentTools: true,
} as const satisfies ToolToggles

/**
 * {@link AgentToolsConfig} defaults.
 *
 * An **allow-list**, not a deny-list, because the harness ships tools no
 * deny-list can be trusted to cover:
 *
 * - `run_code` is the programmatic-tool-calling entry point: one call runs a
 *   program that may invoke *any other tool by name* (`core/tools/src/ptc.ts:20`).
 *   Exposing it would void every other entry here.
 * - `cordis_run`, `cordis_define`, `cordis_undefine` … execute arbitrary plugin
 *   code. No shipped bundle mounts them, so a deny-list written against today's
 *   Desktop profile is blind in exactly the profile that adds them.
 * - `ask_user_question` and `present` reach the human at the keyboard.
 * - `workflow`, `ralph`, `spawn_teammate`, `send_message` and `schedule_create`
 *   start work that outlives the call; `create_goal` and `update_goal` sustain
 *   unattended execution.
 *
 * All of those are denied by omission, and a tool a future harness adds is denied
 * by default rather than exposed by default. What remains is the deterministic,
 * bounded set — file access and search, the two shells, web read, job
 * observation, todo/skill/goal reads — whose authority this bridge already grants
 * through `file_*` and `shell_run`, so exposing them widens nothing.
 */
export const DEFAULT_AGENT_TOOLS: AgentToolsConfig = {
  allow: [
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'str_replace_editor',
    'read_image',
    'bash',
    'pwsh',
    'web_search',
    'web_fetch',
    'job_list',
    'job_output',
    'job_kill',
    'todo_write',
    'skill',
    'get_goal',
  ],
  deny: [],
}

/** {@link SessionConfig} defaults: inherit the DSH agent route, 15-minute turns. */
export const DEFAULT_SESSION = {
  agentPreset: '',
  provider: '',
  model: '',
  promptTimeoutMs: 15 * 60_000,
} as const satisfies SessionConfig

/** {@link LimitsConfig} defaults: 1 MiB reads, 2-minute commands and agent tools. */
export const DEFAULT_LIMITS = {
  maxReadBytes: 1024 * 1024,
  shellTimeoutMs: 120_000,
  agentToolTimeoutMs: 120_000,
} as const satisfies LimitsConfig

/** {@link ApprovalConfig} defaults: never widen the harness policy implicitly. */
export const DEFAULT_APPROVAL = { policy: 'inherit' } as const satisfies ApprovalConfig

/** Every default, as one configuration. */
export function defaultConfig(): Config {
  return {
    http: { ...DEFAULT_HTTP },
    auth: { ...DEFAULT_AUTH },
    tools: { ...DEFAULT_TOOLS },
    agentTools: { allow: [...DEFAULT_AGENT_TOOLS.allow], deny: [...DEFAULT_AGENT_TOOLS.deny] },
    session: { ...DEFAULT_SESSION },
    limits: { ...DEFAULT_LIMITS },
    approval: { ...DEFAULT_APPROVAL },
  }
}
