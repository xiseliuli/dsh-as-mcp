/**
 * The DSH settings-service namespace behind the settings panel.
 *
 * DSH's settings service lets a plugin register one namespace whose user layer a
 * configuration UI edits, and resolves it as *schema defaults → composition base
 * → user section*. Registering here is what puts these knobs in the settings
 * panel, and it is also what makes them live: the plugin reads its configuration
 * through a getter at each use, so an edit takes effect on the next request
 * rather than at the next restart.
 *
 * Two deliberate choices:
 *
 * - **The schema is built lazily and its absence is not an error.** The settings
 *   service requires a schemastery schema, but this package declares no
 *   `@deepseek-ai/*` dependency, so the module is imported on demand and a
 *   profile that cannot resolve it simply keeps its composition configuration —
 *   the plugin works either way.
 * - **`validate` re-uses {@link normalizeConfig}.** The schema decides what the
 *   panel may render; the normalizer decides what the plugin can actually act
 *   on. Running the normalizer in `validate` means a write the plugin could not
 *   serve is refused at the write, instead of being stored and then silently
 *   replaced by the composition entry on the next read.
 */

import type { Context } from '@deepseek-ai/cordis'

import { normalizeConfig, type Config } from './config.js'
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_APPROVAL,
  DEFAULT_AUTH,
  DEFAULT_HTTP,
  DEFAULT_LIMITS,
  DEFAULT_SESSION,
  DEFAULT_TOOLS,
} from './defaults.js'
import { serviceOf, type DshLogger } from './dsh/types.js'

/** The namespace this plugin owns; also the section id in the settings panel. */
export const SETTINGS_NAMESPACE = 'dsh-as-mcp'

/** The module id the settings service's schema comes from. */
const SCHEMASTERY_MODULE = '@deepseek-ai/schemastery'

/**
 * The slice of schemastery's surface these schemas use.
 *
 * Structural rather than imported, so the optional module never becomes a
 * compile-time dependency of this package.
 */
interface SchemaNode {
  default(value: unknown): SchemaNode
  role(name: string): SchemaNode
  description(text: string): SchemaNode
}

/** A schemastery module, as far as this file needs it. */
export interface SchemasteryLike {
  object(shape: Record<string, unknown>): SchemaNode
  boolean(): SchemaNode
  number(): SchemaNode
  string(): SchemaNode
  const(value: string): SchemaNode
  union(choices: readonly SchemaNode[]): SchemaNode
  array(inner: SchemaNode): SchemaNode
}

/** Hooks `installSection` accepts around one consumer-owned section. */
export interface SettingsSectionHooks<T> {
  /** Refuse a resolved section the plugin could not act on. */
  validate?: (value: T) => void
  /** Adopt a new source for the resolved value (the user layer, or the entry). */
  setSource(source: () => T): void
  /** Called once on install and after each committed change. */
  onChange(): void
}

/** The settings-provider surface this plugin consumes. */
export interface SettingsProviderLike {
  installSection<T>(
    owner: Context,
    ns: string,
    schema: unknown,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ): void
}

let schemaModule: Promise<SchemasteryLike | undefined> | undefined

/**
 * Import schemastery once per process.
 *
 * A resolution failure is a supported outcome, not an error: it means this
 * profile has no settings schema available, so the panel entry cannot exist.
 */
export function loadSchemastery(): Promise<SchemasteryLike | undefined> {
  schemaModule ??= import(/* @vite-ignore */ SCHEMASTERY_MODULE)
    .then((module: { default?: unknown }) => (module.default ?? module) as SchemasteryLike)
    .catch(() => undefined)
  return schemaModule
}

/**
 * Build the settings schema.
 *
 * Every field mirrors {@link Config} and takes its default from the shared
 * constants, so the schema and the composition normalizer cannot disagree.
 * `auth.token` is a `role('secret')` field: a configuration surface receives
 * `{ path, set }` for it rather than its value.
 */
export function buildSettingsSchema(z: SchemasteryLike): SchemaNode {
  return z.object({
    http: z.object({
      enabled: z.boolean().default(DEFAULT_HTTP.enabled)
        .description('Serve the MCP endpoint from a listener this plugin owns.'),
      host: z.string().default(DEFAULT_HTTP.host)
        .description('Listen host for the plugin-owned listener.'),
      port: z.number().default(DEFAULT_HTTP.port)
        .description('Listen port; 0 asks the OS for a free port.'),
      path: z.string().default(DEFAULT_HTTP.path)
        .description('Endpoint pathname, for example /mcp.'),
      mountOnWebServer: z.boolean().default(DEFAULT_HTTP.mountOnWebServer)
        .description("Also serve the endpoint through DSH's own web server."),
    }).description('Where the endpoint listens.'),
    auth: z.object({
      token: z.string().role('secret').default(DEFAULT_AUTH.token)
        .description('Pin the bearer token. Empty reads $DSH_HOME/dsh-as-mcp/token.'),
    }).description('Bearer-token admission.'),
    tools: z.object({
      workspace: z.boolean().default(DEFAULT_TOOLS.workspace)
        .description('Expose workspace_create and workspace_list.'),
      session: z.boolean().default(DEFAULT_TOOLS.session)
        .description('Expose the session tools, which drive a DSH agent.'),
      files: z.boolean().default(DEFAULT_TOOLS.files)
        .description('Expose file_read, file_write, and file_list.'),
      shell: z.boolean().default(DEFAULT_TOOLS.shell)
        .description('Expose shell_run, which executes commands as this DSH instance.'),
      agentTools: z.boolean().default(DEFAULT_TOOLS.agentTools)
        .description("Expose dsh_tool_list and dsh_tool_call, which run this instance's own agent tools."),
    }).description('Which tool groups the endpoint advertises.'),
    agentTools: z.object({
      allow: z.array(z.string()).default([...DEFAULT_AGENT_TOOLS.allow])
        .description('Tool names dsh_tool_call may invoke. A non-empty list replaces the built-in default.'),
      deny: z.array(z.string()).default([...DEFAULT_AGENT_TOOLS.deny])
        .description('Names removed from the permitted set, for subtracting from the default.'),
    }).description('Which harness tools dsh_tool_call may reach.'),
    session: z.object({
      agentPreset: z.string().default(DEFAULT_SESSION.agentPreset)
        .description('Agent preset for turns this plugin starts; empty inherits.'),
      provider: z.string().default(DEFAULT_SESSION.provider)
        .description('Model provider route; must be paired with model.'),
      model: z.string().default(DEFAULT_SESSION.model)
        .description('Model id; must be paired with provider.'),
      promptTimeoutMs: z.number().default(DEFAULT_SESSION.promptTimeoutMs)
        .description('How long session_prompt waits for its turn to settle.'),
    }).description('Defaults for turns this plugin starts.'),
    limits: z.object({
      maxReadBytes: z.number().default(DEFAULT_LIMITS.maxReadBytes)
        .description('Bytes file_read returns before truncating.'),
      shellTimeoutMs: z.number().default(DEFAULT_LIMITS.shellTimeoutMs)
        .description('Default timeout for shell_run.'),
      agentToolTimeoutMs: z.number().default(DEFAULT_LIMITS.agentToolTimeoutMs)
        .description('Default timeout for dsh_tool_call.'),
    }).description('Bounds on one external call.'),
    approval: z.object({
      policy: z.union([z.const('inherit'), z.const('allow')])
        .default(DEFAULT_APPROVAL.policy)
        .description('How sessions this plugin starts answer approval requests.'),
    }).description('Approval behaviour for plugin-started sessions.'),
  })
}

/** A live view of the plugin's configuration. */
export interface SettingsBinding {
  /** The configuration to act on right now. */
  current(): Config
  /** Whether the settings namespace is registered. */
  registered(): boolean
  /** Stop reading settings and fall back to the composition entry. */
  release(): void
}

/**
 * Register the settings namespace and return a live configuration reader.
 *
 * Returns before registration completes: the schema import is asynchronous, and
 * the plugin must not delay startup on an optional surface. Until it lands,
 * {@link SettingsBinding.current} reads the composition entry — the same value
 * registration would resolve when the user layer is empty.
 *
 * @param options.ctx - the plugin context the registration is scoped to.
 * @param options.entry - the composition configuration, used as base and fallback.
 * @param options.settings - the settings provider, or `undefined` when absent.
 * @param options.log - logger for the degradation notice.
 * @param options.onChange - called when the resolved configuration may have changed.
 */
export function installSettings(options: {
  readonly ctx: Context
  readonly entry: Config
  readonly log: DshLogger
  readonly onChange: () => void
}): SettingsBinding {
  const { ctx, entry, log, onChange } = options
  let source: () => Config = () => entry
  let registered = false

  // Registered on the service's *arrival* rather than by reading it once.
  //
  // A composition is an ordered list and a third-party row can land anywhere in
  // it, so `ctx.get('settings')` at apply time can legitimately return nothing
  // even though the provider is mounted — that is exactly what happened on the
  // first real install, and the only symptom was a panel that never appeared.
  // `ctx.inject` is the optional-consumer form: it does not make this plugin
  // depend on settings, it runs this callback when (and only when) a provider is
  // available, and re-runs it if the provider is replaced.
  //
  // The injected context is also the `owner`, so the registration's lifetime is
  // the provider's, with no separate disposer to get wrong.
  ctx.inject(['settings'], (settingsCtx: Context) => {
    const settings = serviceOf<SettingsProviderLike>(settingsCtx, 'settings')
    if (settings === undefined) return

    void (async () => {
      const z = await loadSchemastery()
      if (z === undefined) {
        log.warn(
          `[dsh-as-mcp] ${SCHEMASTERY_MODULE} is not resolvable here, so this profile gets no `
          + 'settings entry — the plugin still runs from its composition configuration',
        )
        return
      }
      settings.installSection<Config>(settingsCtx, SETTINGS_NAMESPACE, buildSettingsSchema(z), entry, {
        // A write the plugin cannot serve is refused now, at the writer, rather
        // than stored and then ignored on the next read.
        validate: (value) => {
          normalizeConfig(value)
        },
        setSource: (current) => {
          source = () => {
            try {
              return normalizeConfig(current())
            } catch (error) {
              log.warn(
                '[dsh-as-mcp] ignoring a stored settings section that no longer validates: %s',
                error instanceof Error ? error.message : String(error),
              )
              return entry
            }
          }
        },
        onChange,
      })
      registered = true
      onChange()
      log.info(`[dsh-as-mcp] settings namespace "${SETTINGS_NAMESPACE}" registered`)
    })().catch((error: unknown) => {
      log.warn(
        '[dsh-as-mcp] could not register the settings namespace: %s',
        error instanceof Error ? error.message : String(error),
      )
    })
  })

  return {
    current: () => source(),
    registered: () => registered,
    release: () => {
      source = () => entry
    },
  }
}
