import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { Config, ConfigValidationError, normalizeConfig, optional, plainConfig } from '../src/config.js'
import { DEFAULT_AGENT_TOOLS } from '../src/defaults.js'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** One `- insert: [...]` row from the bundle patch. */
interface PatchRow {
  id: string
  name: string
  config: unknown
}

async function readPatchRows(): Promise<PatchRow[]> {
  const text = await readFile(patchPath, 'utf8')
  const layers = parseYaml(text) as { insert?: PatchRow[] }[]
  return layers.flatMap((layer) => layer.insert ?? [])
}

/**
 * Run a raw config through Cordis itself, then through the plugin's normalizer.
 *
 * `resolveConfig` is the exact function the loader calls on a plugin's `Config`,
 * so these assertions test the harness's validation path rather than a
 * hand-rolled one. Its result carries a `Volatile` box per leaf — the harness's
 * "editable without a remount" mechanism — so it is unwrapped the same way
 * `apply()` unwraps it before the strict normalizer sees plain values.
 */
function load(raw: unknown) {
  return normalizeConfig(plainConfig(resolveConfig({ Config } as never, raw)))
}

describe('cordis.patch.yml', () => {
  it('is a patch list whose single row targets this package', async () => {
    const rows = await readPatchRows()
    expect(rows).toHaveLength(1)
    // `name` must be the bare package name: pnpm resolves it from the profile
    // directory, and a subpath would have to exist as a real file there.
    expect(rows[0]?.name).toBe('dsh-as-mcp')
    expect(rows[0]?.id).toBe('dsh-as-mcp')
  })

  it('parses against the plugin schema, through Cordis', async () => {
    const rows = await readPatchRows()
    // If the patch file and the schema ever drift, this is a boot-time failure
    // with a confusing message. Catch it here instead.
    const config = load(rows[0]?.config ?? {})
    expect(config).toEqual({
      http: { enabled: true, host: '127.0.0.1', port: 8790, path: '/mcp', mountOnWebServer: false },
      auth: { token: '' },
      tools: { workspace: true, session: true, files: true, shell: true, agentTools: true },
      // The patch spells out `agentTools` too. An empty `allow` means "keep the
      // built-in list", so the row and the schema still agree on the default.
      agentTools: { allow: [...DEFAULT_AGENT_TOOLS.allow], deny: [] },
      session: { agentPreset: '', provider: '', model: '', promptTimeoutMs: 900_000 },
      limits: { maxReadBytes: 1_048_576, shellTimeoutMs: 120_000, agentToolTimeoutMs: 120_000 },
      approval: { policy: 'inherit' },
    })
  })

  it('leaves auth.token out of the row, so the panel does not start out claiming one is set', async () => {
    // `@deepseek-ai/dsh-settings` answers "is this secret set?" with
    // `value !== undefined` (`lib/types/redact.js`), over the resolved config.
    // An explicitly empty string is a *present* value, so shipping `token: ''`
    // made every panel report "已设置" from the moment the plugin loaded and made
    // the row's own clear button look inert. Absent and empty mean the same thing
    // to this plugin — inherit the token file — so the row omits it entirely.
    const rows = await readPatchRows()
    const config = rows[0]?.config as { auth?: { token?: unknown } } | undefined
    expect(config?.auth?.token).toBeUndefined()
    // The normalizer still hands the plugin the empty string it acts on.
    expect(load(rows[0]?.config ?? {}).auth.token).toBe('')
  })
})

describe('config loading through Cordis', () => {
  it('fills every section from an empty config', () => {
    const config = load({})
    expect(config.http.port).toBe(8790)
    expect(config.http.path).toBe('/mcp')
    expect(config.http.host).toBe('127.0.0.1')
    expect(config.http.enabled).toBe(true)
    // Off by default: the standalone listener already covers every surface, and
    // mounting on the browser-facing web server changes that composition.
    expect(config.http.mountOnWebServer).toBe(false)
    expect(config.approval.policy).toBe('inherit')
    expect(config.session.promptTimeoutMs).toBe(900_000)
    // Its own knob, not a reuse of the shell timeout: an operator tuning one
    // must not silently move the other's default.
    expect(config.limits.agentToolTimeoutMs).toBe(120_000)
  })

  it('keeps sibling defaults when a nested section is partially set', () => {
    // The regression this guards: a schema that replaces a section wholesale
    // leaves `http.host` undefined and the listener binds to nothing.
    const config = load({ http: { port: 9000 } })
    expect(config.http.port).toBe(9000)
    expect(config.http.host).toBe('127.0.0.1')
    expect(config.http.path).toBe('/mcp')
    expect(config.tools.shell).toBe(true)
  })

  it('accepts a config with no value at all', () => {
    expect(load(undefined).http.port).toBe(8790)
  })

  it('reports every problem at once, not just the first', () => {
    // Schemastery answers a type error with its own single-issue message, so the
    // all-at-once property belongs to the normalizer — the layer that decides
    // whether this plugin can act on the configuration at all.
    let error: unknown
    try {
      normalizeConfig({ http: { port: 'nine' }, approval: { policy: 'yolo' } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConfigValidationError)
    const message = (error as Error).message
    expect(message).toContain('http.port')
    expect(message).toContain('approval.policy')
  })

  it('names the offending path when the schema rejects a value first', () => {
    // Whichever layer speaks first, a boot failure must point at the key.
    expect(() => load({ http: { port: 'nine' } })).toThrow(/http\.port/)
  })

  it('names a mistyped key instead of silently ignoring it', () => {
    // The shipped patch file spells out every key, so an unknown key means the
    // user's override is not being applied — the one failure worth failing on.
    // Schemastery preserves unknown keys, so the normalizer still sees them.
    expect(() => load({ http: { prot: 9000 } })).toThrow(/http\.prot is not a dsh-as-mcp option/)
  })

  it('rejects a non-object config', () => {
    expect(() => load('nope')).toThrow(/object/)
  })

  it('rejects a negative port and a path without a leading slash', () => {
    expect(() => load({ http: { port: -1 } })).toThrow(/non-negative integer/)
    expect(() => load({ http: { path: 'mcp' } })).toThrow(/must start with "\/"/)
  })
})

describe('the schema Cordis consumes', () => {
  it('is schemastery, which is what the settings service requires', () => {
    // Two harness checks decide whether this plugin's entry ever reaches a
    // settings form: `SettingsForms.schema()` wants `toJSON` on the schema, and
    // `volatileForm()` wants `meta.volatile` on the fields. A hand-written
    // Standard Schema satisfied neither, and the panel was silently absent.
    expect(Config['~standard'].version).toBe(1)
    expect(Config['~standard'].vendor).toBe('schemastery')
    expect(typeof Config.toJSON).toBe('function')
  })

  it('validates synchronously, which is all Cordis accepts', () => {
    const result = Config['~standard'].validate({})
    expect(result).not.toBeInstanceOf(Promise)
    expect('then' in result).toBe(false)
    expect(normalizeConfig(plainConfig((result as { value: unknown }).value)).http.port).toBe(8790)
  })

  it('hands each leaf over as a volatile reference, so the Loader can commit edits', () => {
    const result = Config['~standard'].validate({ http: { port: 1234 } }) as { value: { http: { port: unknown } } }
    const box = result.value.http.port as { get?: () => unknown }
    expect(typeof box.get).toBe('function')
    expect(box.get?.()).toBe(1234)
  })

  it('returns issues rather than throwing, so Cordis can raise its own error', () => {
    const result = Config['~standard'].validate({ approval: { policy: 'yolo' } }) as {
      value?: unknown
      issues?: readonly { message: string }[]
    }
    expect(result.value).toBeUndefined()
    expect(result.issues?.[0]?.message).toContain('policy')
  })
})

describe('normalizeConfig', () => {
  it('throws ConfigValidationError carrying the individual issues', () => {
    try {
      normalizeConfig({ tools: { shell: 'yes' } })
      expect.unreachable('normalizeConfig should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect((error as ConfigValidationError).issues[0]).toContain('tools.shell must be a boolean')
    }
  })
})

describe('optional()', () => {
  it('collapses a blank string to undefined so config falls back to the harness default', () => {
    expect(optional('')).toBeUndefined()
    expect(optional('   ')).toBeUndefined()
    expect(optional(undefined)).toBeUndefined()
    expect(optional('gpt-5')).toBe('gpt-5')
  })
})
