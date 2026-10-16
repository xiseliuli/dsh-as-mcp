/**
 * The browser half.
 *
 * Contributes one entry to the settings panel. It holds no state of its own: the
 * values it renders come from the same Host entry the endpoint reads, so what the
 * panel shows is what the endpoint will use on its next request.
 *
 * @module dsh-as-mcp/client
 */

import type { Config } from '../config.js'
import { STATUS_ROUTE, type EndpointStatus } from '../status.js'
import type { ClientContext } from './contract.js'
import { NS, en, zh } from './locales.js'
import { McpSection, type SectionStore } from './section.js'
import './styles.js'

/**
 * Cordis service names this bundle needs before it can register.
 *
 * These are *services*, not packages — a separate list from any
 * `dsh.client.inject` of package names. `configForms` is the settings domain's
 * service and is the only thing that can build this page's data layer, so
 * waiting for it is correct rather than costly: a composition without the
 * settings domain has no `settings.section` slot to fill either.
 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * The Host plugin entry id whose configuration this page edits.
 *
 * `SettingsForms.describe()` keys a form by `entry.options.id`, which for this
 * plugin is its Loader row id — the bare package name. Spelled here rather than
 * imported from `../settings.js`, because a browser bundle must not pull the Host
 * half (and schemastery with it) into the page; the test suite asserts the two
 * spellings agree.
 */
const SETTINGS_ENTRY = 'dsh-as-mcp'

/** Where the generated token lives, when the host has not told us otherwise. */
const FALLBACK_TOKEN_FILE = '~/.dsh/dsh-as-mcp/token'

/**
 * Build the bound store over the Host entry's shared configuration form.
 * @param ctx - the browser plugin context.
 */
function buildStore(ctx: ClientContext): SectionStore {
  const form = ctx.configForms.get<Config>(SETTINGS_ENTRY)
  // The form's own snapshot carries no secret slots: the literal never crosses
  // the settings wire, and "is one set?" is answered by the describe mirror
  // instead. The panel reads the live value from the host's status route when it
  // needs to hand one out (the Copy button); see `section.tsx`.
  const mirror = ctx.configForms.describe()

  return {
    subscribe: (listener) => form.subscribe(listener),
    getSnapshot: () => form.getSnapshot(),
    mutate: async (ops, revision) => {
      // The Host answers with a boolean; the section's contract is a rejection,
      // so a refused write has to become one for the panel to report it.
      if (!(await form.mutate(ops, revision))) {
        throw new Error('dsh-as-mcp: the host refused the settings write')
      }
    },
    secretIsSet: () => {
      const view = mirror.getSnapshot().view
      const namespace = view?.namespaces.find((entry) => entry.ns === SETTINGS_ENTRY)
      return namespace?.secrets.some((secret) => secret.path.join('.') === 'auth.token' && secret.set) ?? false
    },
    readStatus: async () => {
      try {
        const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } })
        if (!response.ok) return undefined
        return (await response.json()) as EndpointStatus
      } catch {
        // A host that mounts no status route is not an error worth rendering:
        // the configuration half of the panel is fully functional without it.
        return undefined
      }
    },
  }
}

/**
 * Mount the section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.effect(() => {
      const offZh = ctx.locale.register(NS, 'zh', zh)
      const offEn = ctx.locale.register(NS, 'en', en)
      return () => {
        offZh()
        offEn()
      }
    }, 'dsh-as-mcp: dictionaries')
  } catch (error) {
    // Dictionaries are a nicety; the section is the point. Losing one must not
    // cost the other, and the component falls back to readable built-in strings.
    console.warn('[dsh-as-mcp] locale.register failed; falling back to built-in strings:', error)
  }

  const store = buildStore(ctx)

  // `whileServed` gates the page on the Host actually serving this entry's form,
  // so a deployment whose settings service does not project it shows no trace of
  // the page — and a namespace that stops being served withdraws it. `slots.inject`
  // inside it follows a late-declared or re-declared slot rather than missing it:
  // the settings shell declares that hole, and this bundle must not assume it is
  // already there.
  ctx.effect(
    () => ctx.configForms.whileServed([SETTINGS_ENTRY], () => ctx.slots.inject('settings.section', () => (
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'mcp',
          order: 40,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
          inject: () => ({ store, tokenFile: FALLBACK_TOKEN_FILE }),
        },
        McpSection,
      )
    ))),
    'dsh-as-mcp: settings section',
  )
}
