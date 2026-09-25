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
} as const satisfies ToolToggles

/** {@link SessionConfig} defaults: inherit the DSH agent route, 15-minute turns. */
export const DEFAULT_SESSION = {
  agentPreset: '',
  provider: '',
  model: '',
  promptTimeoutMs: 15 * 60_000,
} as const satisfies SessionConfig

/** {@link LimitsConfig} defaults: 1 MiB reads, 2-minute commands. */
export const DEFAULT_LIMITS = {
  maxReadBytes: 1024 * 1024,
  shellTimeoutMs: 120_000,
} as const satisfies LimitsConfig

/** {@link ApprovalConfig} defaults: never widen the harness policy implicitly. */
export const DEFAULT_APPROVAL = { policy: 'inherit' } as const satisfies ApprovalConfig

/** Every default, as one configuration. */
export function defaultConfig(): Config {
  return {
    http: { ...DEFAULT_HTTP },
    auth: { ...DEFAULT_AUTH },
    tools: { ...DEFAULT_TOOLS },
    session: { ...DEFAULT_SESSION },
    limits: { ...DEFAULT_LIMITS },
    approval: { ...DEFAULT_APPROVAL },
  }
}
