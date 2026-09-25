/**
 * The browser half.
 *
 * Contributes one entry to the settings panel. It holds no state of its own: the
 * values it renders come from the same namespace the host registered, so what the
 * panel shows is what the endpoint reads on its next request.
 *
 * @module dsh-as-mcp/client
 */

import type { Config } from '../config.js'
import type { EndpointStatus } from '../status.js'
import type { ClientContext } from './contract.js'
import { NS, en, zh } from './locales.js'
import { McpSection, type SectionStore } from './section.js'
import './styles.js'

/**
 * Cordis service names this bundle needs before it can register.
 *
 * These are *services*, not packages — a separate list from any
 * `dsh.client.inject` of package names. `settingsScope` is required rather than
 * optional: without the settings UI there is no panel to contribute to.
 */
export const inject = ['slots', 'locale', 'settingsScope']

/** Where the generated token lives, when the host has not told us otherwise. */
const FALLBACK_TOKEN_FILE = '~/.dsh/dsh-as-mcp/token'

/** The host's read-only status route. */
const STATUS_PATH = '/api/dsh-as-mcp/status'

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
    // cost the other, and a raw key still renders as a word in the fallback path.
    console.warn('[dsh-as-mcp] locale.register failed; falling back to built-in strings:', error)
  }

  const scope = ctx.settingsScope.bind<Config>({ namespace: NS })
  const mirror = ctx.settingsScope.describe()

  const store: SectionStore = {
    subscribe: (listener) => scope.subscribe(listener),
    getSnapshot: () => scope.getSnapshot(),
    mutate: (ops, revision) => scope.mutate(ops, revision),
    secretIsSet: () => {
      // The bound scope's snapshot drops the `secrets` sidecar, so the only
      // place to learn that a token is pinned is the raw describe mirror. The
      // literal itself never crosses the wire.
      const view = mirror.getSnapshot().view
      const namespace = view?.namespaces.find((entry) => entry.ns === NS)
      return namespace?.secrets.some((secret) => secret.path.join('.') === 'auth.token' && secret.set) ?? false
    },
    readStatus: async () => {
      try {
        const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) return undefined
        return (await response.json()) as EndpointStatus
      } catch {
        // A host that mounts no status route is not an error worth rendering:
        // the configuration half of the panel is fully functional without it.
        return undefined
      }
    },
  }

  // `slots.inject` rather than a bare `register`, so a late-declared or
  // re-declared slot is followed instead of missed — the settings shell declares
  // this hole, and this bundle must not assume it is already there.
  ctx.slots.inject('settings.section', () =>
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
    ),
  )
}
