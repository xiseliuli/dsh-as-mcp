import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { APPROVAL_POLICIES, ConfigValidationError, normalizeConfig, type Config } from '../src/config.js'
import { defaultConfig } from '../src/defaults.js'
import {
  SETTINGS_NAMESPACE,
  buildSettingsSchema,
  installSettings,
  loadSchemastery,
  type SettingsProviderLike,
  type SettingsSectionHooks,
} from '../src/settings.js'
import { silentLog, testConfig } from './harness.js'

/** Poll until `ready()` holds, so the asynchronous schema import can settle. */
async function until(ready: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** One captured `installSection` call. */
interface Registration {
  readonly ns: string
  readonly schema: unknown
  readonly entry: Config
  readonly hooks: SettingsSectionHooks<Config>
}

/**
 * A settings provider that records what it was asked to install.
 *
 * It mimics the real service's contract for the parts this plugin depends on:
 * adopt the registrant's schema, take the composition entry as the base layer,
 * and re-point the source through `setSource`.
 */
function stubProvider(): { provider: SettingsProviderLike; registrations: Registration[] } {
  const registrations: Registration[] = []
  return {
    registrations,
    provider: {
      installSection<T>(owner: Context, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>) {
        expect(owner).toBeInstanceOf(Context)
        registrations.push({
          ns,
          schema,
          entry: entry as Config,
          hooks: hooks as SettingsSectionHooks<Config>,
        })
        hooks.setSource(() => entry)
        hooks.onChange()
      },
    },
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function newContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

describe('buildSettingsSchema', () => {
  it('resolves exactly the configuration the composition normalizer produces', async () => {
    // The drift guard: a default that lived in only one of the two paths would
    // make the same knob read differently from the file and from the panel.
    const z = await loadSchemastery()
    expect(z).toBeDefined()
    const schema = buildSettingsSchema(z!) as unknown as (input: unknown) => Config
    expect(schema({})).toEqual(normalizeConfig({}))
    expect(schema({})).toEqual(defaultConfig())
  })

  it('keeps the user layer on top of the defaults', async () => {
    const z = await loadSchemastery()
    const schema = buildSettingsSchema(z!) as unknown as (input: unknown) => Config
    const resolved = schema({ tools: { shell: false }, http: { port: 1234 } })
    expect(resolved.tools.shell).toBe(false)
    // Sibling defaults survive a partial section.
    expect(resolved.tools.files).toBe(true)
    expect(resolved.http.port).toBe(1234)
    expect(resolved.http.host).toBe(defaultConfig().http.host)
  })

  it('accepts every approval policy the config type allows', async () => {
    const z = await loadSchemastery()
    const schema = buildSettingsSchema(z!) as unknown as (input: unknown) => Config
    for (const policy of APPROVAL_POLICIES) {
      expect(schema({ approval: { policy } }).approval.policy).toBe(policy)
    }
  })

  it('refuses a value the plugin could not serve', async () => {
    const z = await loadSchemastery()
    const schema = buildSettingsSchema(z!) as unknown as (input: unknown) => Config
    expect(() => schema({ http: { port: 'not-a-port' } })).toThrow()
    expect(() => schema({ approval: { policy: 'maybe' } })).toThrow()
  })
})

describe('installSettings', () => {
  it('registers our namespace with the composition config as the base layer', async () => {
    const ctx = newContext()
    const entry = testConfig()
    const { provider, registrations } = stubProvider()
    ctx.provide('settings', provider)

    const binding = installSettings({ ctx, entry, log: silentLog, onChange: () => {} })
    await until(() => registrations.length > 0, 'registration')

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.ns).toBe(SETTINGS_NAMESPACE)
    expect(registrations[0]?.entry).toEqual(entry)
    await until(() => binding.registered(), 'binding.registered()')
    expect(binding.current()).toEqual(entry)
  })

  it('re-reports the configuration after the provider re-points the source', async () => {
    const ctx = newContext()
    const { provider, registrations } = stubProvider()
    ctx.provide('settings', provider)
    const changes: number[] = []

    const binding = installSettings({
      ctx,
      entry: testConfig(),
      log: silentLog,
      onChange: () => changes.push(changes.length),
    })
    await until(() => registrations.length > 0, 'registration')

    // What the real service does when the user section is committed.
    const next = testConfig({ files: false }, 4321)
    registrations[0]?.hooks.setSource(() => next)
    registrations[0]?.hooks.onChange()

    expect(binding.current().tools.files).toBe(false)
    expect(binding.current().http.port).toBe(4321)
    // Registration itself reports a change, and so does the commit.
    expect(changes.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses a write it could not act on, at the write', async () => {
    const ctx = newContext()
    const { provider, registrations } = stubProvider()
    ctx.provide('settings', provider)
    installSettings({ ctx, entry: testConfig(), log: silentLog, onChange: () => {} })
    await until(() => registrations.length > 0, 'registration')

    const validate = registrations[0]?.hooks.validate
    expect(validate).toBeDefined()
    expect(() => validate!(testConfig())).not.toThrow()
    expect(() => validate!({ ...testConfig(), http: { ...testConfig().http, port: -1 } }))
      .toThrow(ConfigValidationError)
    expect(() => validate!({ ...testConfig(), approval: { policy: 'nope' } } as unknown as Config)).toThrow()
  })

  it('registers when the settings service arrives after the plugin', async () => {
    // This is the shape the bug actually took on a real install: at apply time
    // there is no provider, because a service mounts after the plugins that use
    // it. Sampling the context once meant the namespace was never registered and
    // the only symptom was a panel that never appeared.
    const ctx = newContext()
    const binding = installSettings({ ctx, entry: testConfig(), log: silentLog, onChange: () => {} })
    expect(binding.registered()).toBe(false)
    // Until it arrives, the composition entry is still the answer.
    expect(binding.current().http.port).toBe(testConfig().http.port)

    const { provider, registrations } = stubProvider()
    ctx.provide('settings', provider)

    await until(() => registrations.length > 0, 'late registration')
    expect(binding.registered()).toBe(true)
    expect(registrations[0]?.ns).toBe(SETTINGS_NAMESPACE)
  })

  it('falls back to the composition entry when no provider is mounted', () => {
    const ctx = newContext()
    const entry = testConfig({ files: false, shell: true }, 5555)
    // No provider at all: the registration callback never runs, and the binding
    // must still answer with the composition entry.
    const binding = installSettings({ ctx, entry, log: silentLog, onChange: () => {} })

    // No provider must never cost the plugin its configuration.
    expect(binding.registered()).toBe(false)
    expect(binding.current()).toEqual(entry)
  })

  it('releases back to the composition entry', async () => {
    const ctx = newContext()
    const entry = testConfig()
    const { provider, registrations } = stubProvider()
    ctx.provide('settings', provider)
    const binding = installSettings({ ctx, entry, log: silentLog, onChange: () => {} })
    await until(() => registrations.length > 0, 'registration')

    registrations[0]?.hooks.setSource(() => testConfig({ files: false }))
    expect(binding.current().tools.files).toBe(false)
    binding.release()
    // Back to the composition entry, which is the only thing release may fall to.
    expect(binding.current().tools.files).toBe(entry.tools.files)
  })

  it('survives a provider whose installSection throws', async () => {
    const ctx = newContext()
    const warnings: string[] = []
    const provider: SettingsProviderLike = {
      installSection() {
        throw new Error('provider exploded')
      },
    }
    ctx.provide('settings', provider)
    const binding = installSettings({
      ctx,
      entry: testConfig(),
      log: { ...silentLog, warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) },
      onChange: () => {},
    })

    // The failure is reported, not thrown into apply() — a settings problem must
    // never be able to stop the plugin, or DSH itself, from loading.
    await until(() => warnings.length > 0, 'the warning')
    expect(warnings.join('\n')).toContain('provider exploded')
    expect(binding.registered()).toBe(false)
    expect(binding.current()).toEqual(testConfig())
  })
})
