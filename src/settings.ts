/**
 * The DSH settings surface this plugin participates in.
 *
 * DSH 0.2.0-rc.2 replaced the settings API this plugin was originally written
 * against, and the replacement is not a rename:
 *
 * - `settings.installSection(owner, ns, schema, entry, hooks)` no longer exists
 *   (`installSection` appears nowhere in the 0.2.0-rc.2 build). A settings
 *   namespace is now **projected** from the Loader entry's own `Config`, keyed
 *   by the entry id, and a write edits the profile patch and is applied through
 *   the normal Loader path.
 * - Only fields marked `meta.volatile` reach the form
 *   (`@deepseek-ai/dsh-settings`'s `volatileForm()`), and a write is committed
 *   into the running `Volatile` reference **without a remount**. That is why
 *   `config.ts` marks every leaf `.volatile()` and why `apply()` resolves its
 *   configuration through `plainConfig()` on every read.
 *
 * There is therefore nothing left to register. What remains is the one thing a
 * plugin that ships its own page still has to say — "do not also generate a page
 * from my schema" — which the harness documents as
 * `configure({ auto: false }, ctx.fiber)` inside an optional
 * `ctx.inject(['settings'], ...)` child. Registering it on the service's
 * *arrival* keeps this plugin independent of settings: a composition that never
 * mounts the service never runs the callback, and this plugin still loads.
 */

import type { Context } from '@deepseek-ai/cordis'

import { serviceOf, type DshLogger } from './dsh/types.js'

/**
 * The namespace this plugin owns.
 *
 * It is also the Loader entry id (`describe()` keys a form by
 * `entry.options.id`) and the section id in the settings panel.
 */
export const SETTINGS_NAMESPACE = 'dsh-as-mcp'

/** The settings-provider surface this plugin consumes. */
export interface SettingsProviderLike {
  /**
   * Claim this plugin instance's page policy. `auto: false` stops the client
   * from generating a second, schema-derived page beside this plugin's own.
   */
  configure(presentation: { auto?: boolean }, owner: unknown): () => void
}

/** Whether this profile projects the plugin's configuration into a settings form. */
export interface SettingsAvailability {
  /** @returns whether the settings service is present and has been told about this page. */
  available(): boolean
}

/**
 * Claim the settings page policy, and report whether the profile serves one.
 *
 * @param options.ctx - the plugin context the claim is scoped to.
 * @param options.log - logger for the degradation notice.
 * @returns a live view of whether the settings service is serving this plugin.
 */
export function installSettingsPagePolicy(options: {
  readonly ctx: Context
  readonly log: DshLogger
}): SettingsAvailability {
  const { ctx, log } = options
  let available = false

  // `ctx.inject` is the optional-consumer form: it does not make this plugin
  // depend on settings, it runs this callback when (and only when) a provider is
  // available, and re-runs it if the provider is replaced. A row can land
  // anywhere in the composition, so reading the service once at apply time can
  // legitimately find nothing even though the provider is mounted.
  ctx.inject(['settings'], (settingsCtx: Context) => {
    const settings = serviceOf<SettingsProviderLike>(settingsCtx, 'settings')
    if (settings === undefined || typeof settings.configure !== 'function') return
    try {
      settingsCtx.effect(
        () => settings.configure({ auto: false }, ctx.fiber),
        'dsh-as-mcp: settings page policy',
      )
      available = true
    } catch (error) {
      log.warn(
        '[dsh-as-mcp] could not claim the settings page policy: %s',
        error instanceof Error ? error.message : String(error),
      )
      return
    }
    return () => {
      available = false
    }
  })

  return { available: () => available }
}
