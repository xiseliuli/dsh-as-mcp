/**
 * Plugin configuration: contract, defaults, and validation.
 *
 * Defaults themselves live in `defaults.ts`, because the settings schema must
 * resolve the very same values.
 *
 * Two layers validate the same object, and they are deliberately different:
 *
 * - **{@link Config}** is a real schemastery schema, because that is what the
 *   harness requires to project a settings form. DSH 0.2.0-rc.2's settings
 *   service keeps only entries whose `fiber.runtime.Config` carries a
 *   `toJSON()` (`SettingsForms.schema()`), and builds the form from the fields
 *   marked `meta.volatile`. A hand-written Standard Schema — which this module
 *   used before — has neither, so the entry was silently skipped and the panel
 *   could never appear. Schemastery is a declared optional peer and is present
 *   in every DSH installation.
 * - **{@link normalizeConfig}** stays the authority on what this plugin can
 *   actually act on: it reports every problem at once and refuses unknown keys,
 *   which a schema projection cannot express. `apply()` runs it once per config
 *   read, so a typo in a user's override still fails loudly instead of being
 *   silently dropped by the schema.
 *
 * Every leaf is marked `.volatile()`. That is the harness's own mechanism for
 * "editable without a remount": the resolved value becomes a `Volatile` box the
 * Loader commits into, so this plugin reads live values through
 * {@link plainConfig} and the settings panel can write them. Fields left
 * ordinary would be absent from the form entirely.
 *
 * One leaf deliberately carries **no default**: {@link Config}'s `auth.token`.
 * A configuration surface never receives a secret's value — it receives
 * `{ path, set }`, and `@deepseek-ai/dsh-settings`'s `redactSecrets()` computes
 * `set` as `value !== undefined`. A default would therefore make every panel
 * report "a token is pinned" from the moment the plugin loads, even though
 * nothing is. Absent resolves to `undefined`, which is the honest answer;
 * {@link normalizeConfig} still turns that into the empty string this plugin
 * acts on, and the panel's badge is the only reader of the distinction.
 */

import Schema from '@deepseek-ai/schemastery'

import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_APPROVAL,
  DEFAULT_HTTP,
  DEFAULT_LIMITS,
  DEFAULT_SESSION,
  DEFAULT_TOOLS,
  defaultConfig,
} from './defaults.js'

/** Where the MCP endpoint listens, and whether DSH's own web server carries it too. */
export interface HttpConfig {
  /** Serve the Streamable HTTP endpoint from a listener owned by this plugin. */
  enabled: boolean
  /** Listen host for the plugin-owned listener. */
  host: string
  /** Listen port for the plugin-owned listener; `0` asks the OS for a free port. */
  port: number
  /** Absolute pathname of the MCP endpoint, with no trailing slash. */
  path: string
  /**
   * Also mount the same endpoint on DSH's own web server, making it reachable at
   * `http://<dsh host>:<dsh web port><path>`.
   */
  mountOnWebServer: boolean
}

/** Bearer-token admission for every request the endpoint serves. */
export interface AuthConfig {
  /**
   * Shared secret. When empty the plugin reads `$DSH_HOME/dsh-as-mcp/token`,
   * generating and persisting a fresh token when that file is absent.
   */
  token: string
}

/** Per-capability tool toggles, so an operator can narrow the exposed surface. */
export interface ToolToggles {
  /** `workspace_create`, `workspace_list`. */
  workspace: boolean
  /** `session_create`, `session_list`, `session_prompt`, `session_messages`, `session_cancel`. */
  session: boolean
  /** `file_read`, `file_write`, `file_list`. */
  files: boolean
  /** `shell_run`. */
  shell: boolean
  /**
   * `dsh_tool_list` and `dsh_tool_call` — run this instance's own agent tools
   * directly, without spending a model turn to decide to call them.
   */
  agentTools: boolean
}

/**
 * Which of the harness's own tools `dsh_tool_call` may invoke.
 *
 * Only these names are reachable; `dsh_tool_list` reports exactly them and no
 * others, so a caller cannot discover what it may not call.
 */
export interface AgentToolsConfig {
  /**
   * Permitted tool names. A non-empty list **replaces** the built-in default;
   * an empty list leaves the default in place, so widening is always deliberate.
   */
  allow: string[]
  /** Names removed after `allow` is resolved, so an operator can subtract only. */
  deny: string[]
}

/** Defaults applied when a caller does not name an agent preset or model route. */
export interface SessionConfig {
  /** Agent preset id; empty uses the harness default. */
  agentPreset: string
  /** Provider route; empty uses `selectModel`'s own default handling. */
  provider: string
  /** Model id; must be paired with {@link provider}. */
  model: string
  /** Upper bound for one `session_prompt` call that waits for the turn to end. */
  promptTimeoutMs: number
}

/** Bounds that keep one external call from monopolising the host. */
export interface LimitsConfig {
  /** Bytes `file_read` returns before truncating. */
  maxReadBytes: number
  /** Default timeout for `shell_run`, in milliseconds. */
  shellTimeoutMs: number
  /** Default timeout for `dsh_tool_call`, in milliseconds. */
  agentToolTimeoutMs: number
}

/** How sessions driven by this plugin answer harness approval requests. */
export interface ApprovalConfig {
  /**
   * - `inherit`: leave the harness policy untouched. Without a browser or other
   *   answerer attached, approval-requiring tools fail closed.
   * - `allow`: install an answerer that approves every request raised by a
   *   session this plugin created. This grants the driving agent whatever the
   *   harness sandbox permits.
   */
  policy: 'inherit' | 'allow'
}

/** Complete plugin configuration. */
export interface Config {
  http: HttpConfig
  auth: AuthConfig
  tools: ToolToggles
  agentTools: AgentToolsConfig
  session: SessionConfig
  limits: LimitsConfig
  approval: ApprovalConfig
}

/** The approval policies a configuration may name. */
export const APPROVAL_POLICIES = ['inherit', 'allow'] as const

/** Raised when a config value cannot be normalized. */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError'

  constructor(readonly issues: readonly string[]) {
    super(`invalid dsh-as-mcp configuration:\n  - ${issues.join('\n  - ')}`)
  }
}

/** Render a value's type for an error message. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a nested section, defaulting to empty when absent. */
function section(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): Record<string, unknown> {
  const value = raw[key]
  if (value === undefined) return {}
  if (!isRecord(value)) {
    issues.push(`${path} must be an object, got ${describe(value)}`)
    return {}
  }
  return value
}

/** Report a key the schema does not know, which is almost always a typo. */
function rejectUnknown(raw: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}.${key} is not a dsh-as-mcp option (known keys: ${allowed.join(', ')})`)
    }
  }
}

function bool(raw: Record<string, unknown>, key: string, fallback: boolean, path: string, issues: string[]): boolean {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    issues.push(`${path}.${key} must be a boolean, got ${describe(value)}`)
    return fallback
  }
  return value
}

function num(raw: Record<string, unknown>, key: string, fallback: number, path: string, issues: string[]): number {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${path}.${key} must be a finite number, got ${describe(value)}`)
    return fallback
  }
  return value
}

function positiveInt(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string,
  issues: string[],
): number {
  const value = num(raw, key, fallback, path, issues)
  if (value <= 0 || !Number.isInteger(value)) {
    issues.push(`${path}.${key} must be a positive integer, got ${value}`)
    return fallback
  }
  return value
}

function str(raw: Record<string, unknown>, key: string, fallback: string, path: string, issues: string[]): string {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    issues.push(`${path}.${key} must be a string, got ${describe(value)}`)
    return fallback
  }
  return value
}

/** Read an array of tool names, rejecting anything that is not one. */
function stringArray(
  raw: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
  path: string,
  issues: string[],
): string[] {
  const value = raw[key]
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    issues.push(`${path}.${key} must be an array of tool names, got ${describe(value)}`)
    return [...fallback]
  }
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(`${path}.${key} must contain non-empty strings, got ${describe(entry)}`)
      continue
    }
    names.push(entry.trim())
  }
  return names
}

function oneOf<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  path: string,
  issues: string[],
): T {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push(`${path}.${key} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`)
    return fallback
  }
  return value as T
}

/**
 * Apply defaults and validate. Collects every problem before throwing so one
 * boot reports all of them instead of only the first.
 */
export function normalizeConfig(input: unknown = {}): Config {
  const issues: string[] = []
  let root: Record<string, unknown> = {}
  if (input === undefined || input === null) {
    root = {}
  } else if (isRecord(input)) {
    root = input
  } else {
    issues.push(`configuration must be an object, got ${describe(input)}`)
  }

  rejectUnknown(root, ['http', 'auth', 'tools', 'agentTools', 'session', 'limits', 'approval'], 'config', issues)

  const http = section(root, 'http', 'http', issues)
  rejectUnknown(http, ['enabled', 'host', 'port', 'path', 'mountOnWebServer'], 'http', issues)
  const port = num(http, 'port', DEFAULT_HTTP.port, 'http', issues)
  if (port < 0 || !Number.isInteger(port)) {
    issues.push(`http.port must be a non-negative integer, got ${port}`)
  }
  const path = str(http, 'path', DEFAULT_HTTP.path, 'http', issues)
  if (!path.startsWith('/')) {
    issues.push(`http.path must start with "/", got ${JSON.stringify(path)}`)
  }

  const auth = section(root, 'auth', 'auth', issues)
  rejectUnknown(auth, ['token'], 'auth', issues)

  const tools = section(root, 'tools', 'tools', issues)
  rejectUnknown(tools, ['workspace', 'session', 'files', 'shell', 'agentTools'], 'tools', issues)

  const agentTools = section(root, 'agentTools', 'agentTools', issues)
  rejectUnknown(agentTools, ['allow', 'deny'], 'agentTools', issues)

  const session = section(root, 'session', 'session', issues)
  rejectUnknown(session, ['agentPreset', 'provider', 'model', 'promptTimeoutMs'], 'session', issues)

  const limits = section(root, 'limits', 'limits', issues)
  rejectUnknown(limits, ['maxReadBytes', 'shellTimeoutMs', 'agentToolTimeoutMs'], 'limits', issues)

  const approval = section(root, 'approval', 'approval', issues)
  rejectUnknown(approval, ['policy'], 'approval', issues)

  // Every reader below records into `issues` rather than throwing, so the
  // result must be built before the check — otherwise a bad field value would
  // be silently replaced by its default and the config accepted.
  const fallback = defaultConfig()
  const config: Config = {
    http: {
      enabled: bool(http, 'enabled', fallback.http.enabled, 'http', issues),
      host: str(http, 'host', fallback.http.host, 'http', issues),
      port,
      path,
      mountOnWebServer: bool(http, 'mountOnWebServer', fallback.http.mountOnWebServer, 'http', issues),
    },
    auth: { token: str(auth, 'token', fallback.auth.token, 'auth', issues) },
    tools: {
      workspace: bool(tools, 'workspace', fallback.tools.workspace, 'tools', issues),
      session: bool(tools, 'session', fallback.tools.session, 'tools', issues),
      files: bool(tools, 'files', fallback.tools.files, 'tools', issues),
      shell: bool(tools, 'shell', fallback.tools.shell, 'tools', issues),
      agentTools: bool(tools, 'agentTools', fallback.tools.agentTools, 'tools', issues),
    },
    agentTools: {
      // An empty `allow` means "use the built-in list", so a config that sets
      // only `deny` still starts from the defaults rather than from nothing.
      allow: (() => {
        const names = stringArray(agentTools, 'allow', [], 'agentTools', issues)
        return names.length > 0 ? names : [...fallback.agentTools.allow]
      })(),
      deny: stringArray(agentTools, 'deny', fallback.agentTools.deny, 'agentTools', issues),
    },
    session: {
      agentPreset: str(session, 'agentPreset', fallback.session.agentPreset, 'session', issues),
      provider: str(session, 'provider', fallback.session.provider, 'session', issues),
      model: str(session, 'model', fallback.session.model, 'session', issues),
      promptTimeoutMs: positiveInt(session, 'promptTimeoutMs', fallback.session.promptTimeoutMs, 'session', issues),
    },
    limits: {
      maxReadBytes: positiveInt(limits, 'maxReadBytes', fallback.limits.maxReadBytes, 'limits', issues),
      shellTimeoutMs: positiveInt(limits, 'shellTimeoutMs', fallback.limits.shellTimeoutMs, 'limits', issues),
      agentToolTimeoutMs: positiveInt(limits, 'agentToolTimeoutMs', fallback.limits.agentToolTimeoutMs, 'limits', issues),
    },
    approval: {
      policy: oneOf(approval, 'policy', APPROVAL_POLICIES, fallback.approval.policy, 'approval', issues),
    },
  }

  if (issues.length > 0) throw new ConfigValidationError(issues)
  return config
}

/**
 * The plugin's config schema, in the shape Cordis consumes.
 *
 * Schemastery — not a hand-written Standard Schema — because the harness reads
 * this object's `toJSON()` and its `meta.volatile` markers to project the
 * settings form; see the module doc. Every leaf is volatile so the panel can
 * edit it and the Loader can commit the new value into the running plugin
 * without a remount.
 */
export const Config = Schema.object({
  http: Schema.object({
    enabled: Schema.boolean().default(DEFAULT_HTTP.enabled).volatile()
      .description('Serve the MCP endpoint from a listener this plugin owns.'),
    host: Schema.string().default(DEFAULT_HTTP.host).volatile()
      .description('Listen host for the plugin-owned listener.'),
    port: Schema.number().default(DEFAULT_HTTP.port).volatile()
      .description('Listen port; 0 asks the OS for a free port.'),
    path: Schema.string().default(DEFAULT_HTTP.path).volatile()
      .description('Endpoint pathname, for example /mcp.'),
    mountOnWebServer: Schema.boolean().default(DEFAULT_HTTP.mountOnWebServer).volatile()
      .description("Also serve the endpoint through DSH's own web server."),
  }).description('Where the endpoint listens.'),
  auth: Schema.object({
    // No `.default('')`: see the module doc. An absent value is what tells the
    // settings panel that no token is pinned.
    token: Schema.string().role('secret').volatile()
      .description('Pin the bearer token. Empty reads $DSH_HOME/dsh-as-mcp/token.'),
  }).description('Bearer-token admission.'),
  tools: Schema.object({
    workspace: Schema.boolean().default(DEFAULT_TOOLS.workspace).volatile()
      .description('Expose workspace_create and workspace_list.'),
    session: Schema.boolean().default(DEFAULT_TOOLS.session).volatile()
      .description('Expose the session tools, which drive a DSH agent.'),
    files: Schema.boolean().default(DEFAULT_TOOLS.files).volatile()
      .description('Expose file_read, file_write, and file_list.'),
    shell: Schema.boolean().default(DEFAULT_TOOLS.shell).volatile()
      .description('Expose shell_run, which executes commands as this DSH instance.'),
    agentTools: Schema.boolean().default(DEFAULT_TOOLS.agentTools).volatile()
      .description("Expose dsh_tool_list and dsh_tool_call, which run this instance's own agent tools."),
  }).description('Which tool groups the endpoint advertises.'),
  agentTools: Schema.object({
    allow: Schema.array(Schema.string()).default([...DEFAULT_AGENT_TOOLS.allow]).volatile()
      .description('Tool names dsh_tool_call may invoke. A non-empty list replaces the built-in default.'),
    deny: Schema.array(Schema.string()).default([...DEFAULT_AGENT_TOOLS.deny]).volatile()
      .description('Names removed from the permitted set, for subtracting from the default.'),
  }).description('Which harness tools dsh_tool_call may reach.'),
  session: Schema.object({
    agentPreset: Schema.string().default(DEFAULT_SESSION.agentPreset).volatile()
      .description('Agent preset for turns this plugin starts; empty inherits.'),
    provider: Schema.string().default(DEFAULT_SESSION.provider).volatile()
      .description('Model provider route; must be paired with model.'),
    model: Schema.string().default(DEFAULT_SESSION.model).volatile()
      .description('Model id; must be paired with provider.'),
    promptTimeoutMs: Schema.number().default(DEFAULT_SESSION.promptTimeoutMs).volatile()
      .description('How long session_prompt waits for its turn to settle.'),
  }).description('Defaults for turns this plugin starts.'),
  limits: Schema.object({
    maxReadBytes: Schema.number().default(DEFAULT_LIMITS.maxReadBytes).volatile()
      .description('Bytes file_read returns before truncating.'),
    shellTimeoutMs: Schema.number().default(DEFAULT_LIMITS.shellTimeoutMs).volatile()
      .description('Default timeout for shell_run.'),
    agentToolTimeoutMs: Schema.number().default(DEFAULT_LIMITS.agentToolTimeoutMs).volatile()
      .description('Default timeout for dsh_tool_call.'),
  }).description('Bounds on one external call.'),
  approval: Schema.object({
    policy: Schema.union([Schema.const('inherit'), Schema.const('allow')])
      .default(DEFAULT_APPROVAL.policy)
      .volatile()
      .description('How sessions this plugin starts answer approval requests.'),
  }).description('Approval behaviour for plugin-started sessions.'),
})

/**
 * Whether a value is a schemastery `Volatile` reference.
 *
 * The marker is cosmokit's write symbol rather than the `get` method alone, so
 * an ordinary object that happens to expose `get` is never mistaken for one.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function isVolatile(value: unknown): value is { get(): unknown } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { get?: unknown }).get === 'function'
    && VOLATILE_WRITE in value
}

/**
 * Resolve the config Cordis hands `apply()` into plain values.
 *
 * A `.volatile()` field arrives as a `Volatile` box rather than a value, and the
 * Loader commits settings edits *into that box* without remounting the plugin —
 * so reading through it here is what makes an edit in the panel reach the next
 * request. This mirrors `plainConfig` in `@deepseek-ai/dsh-settings`, which is
 * the same unwrapping the harness does before projecting a form.
 *
 * @param value - a parsed config, possibly holding volatile references.
 * @returns the same shape with every reference read out.
 */
export function plainConfig(value: unknown): unknown {
  if (isVolatile(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map((entry) => plainConfig(entry))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, plainConfig(child)]),
    )
  }
  return value
}

/** Empty strings in YAML mean "unset", so collapse them once at load time. */
export function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
