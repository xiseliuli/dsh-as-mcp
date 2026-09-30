/**
 * Plugin configuration: contract, defaults, and validation.
 *
 * Defaults themselves live in `defaults.ts`, because the settings-service schema
 * must resolve the very same values.
 *
 * Cordis validates a plugin's entry config through **Standard Schema**:
 *
 * ```js
 * const result = runtime.Config["~standard"].validate(config)
 * if ("then" in result) throw new TypeError("Async config validation is not supported")
 * if (result.issues) throw new ValidationError(result.issues)
 * else return result.value
 * ```
 *
 * That is the whole contract — `~standard` is a public spec, and it is
 * deliberately *not* schemastery-specific. Hand-writing it here rather than
 * depending on `@deepseek-ai/schemastery` keeps this package free of every
 * `@deepseek-ai/*` dependency, which matters because DSH treats each declared
 * `@deepseek-ai/dsh-*` peer range as a compatibility gate and an optional peer
 * that fails to install is a load-time import error rather than a warning.
 *
 * The normalizer is intentionally strict about unknown keys: the shipped
 * `cordis.patch.yml` spells out every key, so a typo in a user's override means
 * their intent is silently not applied. Failing at boot with the exact key is
 * far cheaper to diagnose.
 */

import { DEFAULT_HTTP, defaultConfig } from './defaults.js'

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

/** One reported problem, in Standard Schema's shape. */
interface StandardIssue {
  readonly message: string
  readonly path?: readonly (string | number)[]
}

/** Raised when a config value cannot be normalized. */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError'

  constructor(readonly issues: readonly string[]) {
    super(`invalid dsh-as-mcp configuration:\n  - ${issues.join('\n  - ')}`)
  }
}

/** A callable schema that also satisfies Standard Schema, as Cordis expects. */
export interface ConfigSchema {
  /** Normalize and validate, throwing {@link ConfigValidationError} on failure. */
  (input?: unknown): Config
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    validate(input: unknown): { value: Config; issues?: undefined } | { value?: undefined; issues: readonly StandardIssue[] }
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
  rejectUnknown(limits, ['maxReadBytes', 'shellTimeoutMs'], 'limits', issues)

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
 * Callable like a schemastery schema (`Config({})`) as well as validatable
 * through Standard Schema, so the harness and tests share one code path.
 */
export const Config: ConfigSchema = Object.assign(
  (input?: unknown): Config => normalizeConfig(input),
  {
    '~standard': {
      version: 1 as const,
      vendor: 'dsh-as-mcp',
      validate(input: unknown) {
        try {
          return { value: normalizeConfig(input) }
        } catch (error) {
          if (error instanceof ConfigValidationError) {
            return { issues: error.issues.map((message) => ({ message })) }
          }
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    },
  },
)

/** Empty strings in YAML mean "unset", so collapse them once at load time. */
export function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
