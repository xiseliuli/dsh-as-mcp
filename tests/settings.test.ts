import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { APPROVAL_POLICIES, Config, normalizeConfig, plainConfig, type Config as ConfigShape } from '../src/config.js'
import { defaultConfig } from '../src/defaults.js'
import { SETTINGS_NAMESPACE, installSettingsPagePolicy } from '../src/settings.js'
import { silentLog } from './harness.js'

/**
 * Resolve a raw config through the schema Cordis itself consumes.
 *
 * The result holds `Volatile` boxes for every leaf — that is the harness's
 * "editable without a remount" mechanism — so it is unwrapped the same way
 * `apply()` unwraps it before comparing.
 */
function resolve(raw: unknown): ConfigShape {
  const result = Config['~standard'].validate(raw)
  if ('issues' in result && result.issues !== undefined) throw new Error(String(result.issues))
  return normalizeConfig(plainConfig((result as { value: unknown }).value))
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One claimed page policy. */
interface Claim {
  readonly presentation: { auto?: boolean }
  readonly owner: unknown
}

/**
 * A settings provider that records the page policies claimed from it.
 *
 * DSH 0.2.0-rc.2 has no `installSection`: a namespace is projected from the
 * entry's own `Config`, and the only call a plugin that ships its own page still
 * makes is `configure({ auto: false }, fiber)`. This stub mirrors that much.
 */
function stubProvider(options: { readonly throws?: boolean } = {}): {
  provider: unknown
  claims: Claim[]
} {
  const claims: Claim[] = []
  return {
    claims,
    provider: {
      configure(presentation: { auto?: boolean }, owner: unknown) {
        if (options.throws === true) throw new Error('policy already claimed')
        claims.push({ presentation, owner })
        return () => {}
      },
    },
  }
}

/** Poll until `ready()` holds: `ctx.inject` callbacks run on a later tick. */
async function until(ready: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A context carrying the plugin's own fiber, as the harness would supply it. */
function pluginContext(): Context {
  const root = new Context()
  contexts.push(root)
  return root
}

describe('Config, as the harness reads it', () => {
  it('is a schemastery schema, which is what the settings service projects', () => {
    // The regression this pins: a hand-written Standard Schema has no `toJSON`,
    // so `SettingsForms.schema(entry)` returned undefined, `describe()` skipped
    // the entry, and the panel could never appear — with nothing in any log.
    expect(typeof Config.toJSON).toBe('function')
    expect(Config['~standard'].vendor).toBe('schemastery')
  })

  it('marks every leaf volatile, because only volatile fields reach the form', () => {
    // `volatileForm()` keeps a field only when it, or an ancestor, carries
    // `meta.volatile`; anything else is invisible to the panel and unwritable
    // through it. A new field added without `.volatile()` would silently vanish
    // from the page, so the whole shape is asserted here.
    const volatilePaths = (node: { dict?: Record<string, unknown>; meta?: { volatile?: boolean } }, path: string[] = []): string[] => {
      if (node.meta?.volatile === true) return [path.join('.')]
      return Object.entries(node.dict ?? {}).flatMap(([key, child]) =>
        volatilePaths(child as { dict?: Record<string, unknown>; meta?: { volatile?: boolean } }, [...path, key]))
    }
    const marked = volatilePaths(Config as never).sort()
    expect(marked).toEqual([
      'agentTools.allow',
      'agentTools.deny',
      'approval.policy',
      'auth.token',
      'http.enabled',
      'http.host',
      'http.mountOnWebServer',
      'http.path',
      'http.port',
      'limits.agentToolTimeoutMs',
      'limits.maxReadBytes',
      'limits.shellTimeoutMs',
      'session.agentPreset',
      'session.model',
      'session.promptTimeoutMs',
      'session.provider',
      'tools.agentTools',
      'tools.files',
      'tools.session',
      'tools.shell',
      'tools.workspace',
    ])
  })

  it('resolves exactly the configuration the composition normalizer produces', () => {
    // The drift guard: a default that lived in only one of the two paths would
    // make the same knob read differently from the file and from the panel.
    expect(resolve({})).toEqual(normalizeConfig({}))
    expect(resolve({})).toEqual(defaultConfig())
  })

  it('keeps the user layer on top of the defaults', () => {
    const resolved = resolve({ tools: { shell: false }, http: { port: 1234 } })
    expect(resolved.tools.shell).toBe(false)
    // Sibling defaults survive a partial section.
    expect(resolved.tools.files).toBe(true)
    expect(resolved.http.port).toBe(1234)
    expect(resolved.http.host).toBe(defaultConfig().http.host)
  })

  it('resolves an unpinned token to undefined, which is what the panel reads as "not set"', () => {
    // `@deepseek-ai/dsh-settings`'s `redactSecrets()` answers "is a secret set?"
    // with `value !== undefined` (`lib/types/redact.js`), over the *plain*
    // config — the same `plainConfig` unwrapping the plugin does. A schema
    // default would therefore make every panel claim a token is pinned from the
    // moment the plugin loads: the badge read "已设置" whatever the user did, and
    // pinning one produced no visible change at all. Absent is the honest
    // answer, and this test is what keeps a future `.default('')` from silently
    // restoring the lie.
    const resolved = Config['~standard'].validate({}) as { value: unknown }
    expect((plainConfig(resolved.value) as { auth: { token?: unknown } }).auth.token).toBeUndefined()

    const pinned = Config['~standard'].validate({ auth: { token: 'pinned-value' } }) as { value: unknown }
    expect((plainConfig(pinned.value) as { auth: { token: string } }).auth.token).toBe('pinned-value')
  })

  it('still hands the plugin the empty string when nothing is pinned', () => {
    // The absent value is a signal for the panel, not a behaviour change:
    // `normalizeConfig` is what the plugin acts on, and "" is its "inherit".
    expect(resolve({}).auth.token).toBe('')
    expect(normalizeConfig({}).auth.token).toBe('')
  })

  it('accepts every approval policy the config type allows', () => {
    for (const policy of APPROVAL_POLICIES) {
      expect(resolve({ approval: { policy } }).approval.policy).toBe(policy)
    }
  })

  it('refuses a value the plugin could not serve', () => {
    expect(() => resolve({ http: { port: 'not-a-port' } })).toThrow()
    expect(() => resolve({ approval: { policy: 'maybe' } })).toThrow()
  })
})

describe('plainConfig', () => {
  it('reads a volatile reference out of the resolved config', () => {
    // `apply()` depends on this: the Loader commits a settings edit into the box
    // rather than remounting the plugin, so a value that is never read out is a
    // panel edit that does nothing.
    const resolved = Config['~standard'].validate({ http: { port: 4321 } }) as { value: { http: { port: unknown } } }
    expect(typeof (resolved.value.http.port as { get?: unknown }).get).toBe('function')
    const plain = plainConfig(resolved.value) as ConfigShape
    expect(plain.http.port).toBe(4321)
  })

  it('leaves an ordinary config untouched, which is what tests and bare contexts pass', () => {
    const raw = defaultConfig()
    expect(plainConfig(raw)).toEqual(raw)
  })
})

describe('SETTINGS_NAMESPACE', () => {
  it('is the bare package name, which is the Loader row id and the form key', () => {
    // `SettingsForms.describe()` keys a form by `entry.options.id`, and the row
    // this plugin ships is inserted as `- id: dsh-as-mcp`. A namespace that
    // disagreed with the row id would produce a form nobody could ever open.
    expect(SETTINGS_NAMESPACE).toBe('dsh-as-mcp')
  })
})

describe('installSettingsPagePolicy', () => {
  it('reports unavailable while no settings service is mounted', () => {
    const ctx = pluginContext()
    const availability = installSettingsPagePolicy({ ctx, log: silentLog })
    expect(availability.available()).toBe(false)
  })

  it('claims the page policy for this plugin instance once the service arrives', async () => {
    const ctx = pluginContext()
    const { provider, claims } = stubProvider()
    ctx.provide('settings', provider)

    const availability = installSettingsPagePolicy({ ctx, log: silentLog })
    await until(() => claims.length > 0, 'page policy claim')

    expect(claims).toHaveLength(1)
    // `auto: false` is the whole point: this plugin ships its own page, so the
    // schema-generated one must not be produced beside it.
    expect(claims[0]?.presentation).toEqual({ auto: false })
    expect(claims[0]?.owner).toBe(ctx.fiber)
    expect(availability.available()).toBe(true)
  })

  it('claims the policy when the provider is mounted after the plugin', async () => {
    // A composition is an ordered list and a third-party row can land anywhere in
    // it, so reading the service once at apply time can legitimately find nothing
    // even though the provider is mounted. `ctx.inject` is what makes the claim
    // land either way; the failure it prevents is a panel that never appears.
    const ctx = pluginContext()
    const availability = installSettingsPagePolicy({ ctx, log: silentLog })
    expect(availability.available()).toBe(false)

    const { provider, claims } = stubProvider()
    ctx.provide('settings', provider)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(claims).toHaveLength(1)
    expect(availability.available()).toBe(true)
  })

  it('loads the plugin anyway when the provider refuses the claim', async () => {
    // A provider that throws must not take the MCP endpoint down with it: the
    // endpoint is the point, the panel is a convenience.
    const ctx = pluginContext()
    const { provider } = stubProvider({ throws: true })
    ctx.provide('settings', provider)

    const availability = installSettingsPagePolicy({ ctx, log: silentLog })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(availability.available()).toBe(false)
  })

  it('stops reporting available when the provider is withdrawn', async () => {
    const ctx = pluginContext()
    const { provider, claims } = stubProvider()
    ctx.provide('settings', provider)

    const availability = installSettingsPagePolicy({ ctx, log: silentLog })
    await until(() => claims.length > 0, 'page policy claim')
    expect(availability.available()).toBe(true)

    await ctx.fiber.dispose()
    expect(availability.available()).toBe(false)
  })
})
