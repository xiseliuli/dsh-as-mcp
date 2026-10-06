import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

import { GROUPS, formatList, parseList, readPath } from '../src/client/fields.js'
import { normalizeConfig } from '../src/config.js'
import { en, zh } from '../src/client/locales.js'

const run = promisify(execFile)
const ROOT = join(__dirname, '..')

/**
 * The nine specifiers a browser half may `require`.
 *
 * This is the whole seed table — `packages/client/web/src/platform.ts:8-18` —
 * and `PRELOADED_CLIENT_EXTERNALS` is empty, so anything else must be inlined.
 * A require outside this list throws inside the factory and takes the entire
 * bundle down, which is why it is asserted here rather than discovered at boot.
 */
const SEEDED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

let bundle = ''
let manifest: {
  name: string
  scripts: Record<string, string>
  exports: Record<string, unknown>
  dsh?: { client?: { platform?: string } }
}

beforeAll(async () => {
  manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as typeof manifest
  // Run the *declared* build script rather than the client script directly: the
  // node bundler cleans lib/ before it emits, so the order between the two halves
  // is load-bearing and only the real script exercises it. A test that called
  // build-client.mjs alone would happily recreate the artifact after the wipe and
  // prove nothing.
  await run('sh', ['-c', manifest.scripts.build as string], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${join(ROOT, 'node_modules', '.bin')}:${process.env.PATH ?? ''}` },
  })
  bundle = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
}, 180_000)

describe('the build ships both halves', () => {
  it('leaves the node bundle and the client bundle side by side', async () => {
    // Regression: tsdown wipes lib/ before emitting, so building the client
    // first leaves a tree that packs without lib/client.js — a plugin whose panel
    // silently never appears, with nothing in the build log to say so.
    await expect(stat(join(ROOT, 'lib/index.js'))).resolves.toBeTruthy()
    await expect(stat(join(ROOT, 'lib/client.js'))).resolves.toBeTruthy()
  })

  it('builds the client after the node bundle', () => {
    const build = manifest.scripts.build as string
    expect(build.indexOf('tsdown')).toBeGreaterThanOrEqual(0)
    expect(build.indexOf('build-client.mjs')).toBeGreaterThan(build.indexOf('tsdown'))
  })
})

describe('the client half is declared', () => {
  it('advertises a web client face pointing at a file that exists', async () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    const declaration = manifest.exports['./client'] as { default?: string } | undefined
    expect(declaration?.default).toBe('./lib/client.js')
    await expect(stat(join(ROOT, 'lib/client.js'))).resolves.toBeTruthy()
  })

  it('registers under the package name, which is what the loader matches', () => {
    // `arrive()` throws `bundle <url> loaded without registering "<id>"` on any
    // mismatch, so the id is not cosmetic.
    expect(bundle).toContain(`window.__ModuleLoader__.load({ id: "${manifest.name}", factory:`)
    expect(bundle.match(/__ModuleLoader__\.load\(/g)).toHaveLength(1)
  })

  it('carries the CommonJS preamble the loader requires', () => {
    // Without this the build succeeds and every boot throws
    // `ReferenceError: module is not defined` at materialization.
    expect(bundle).toContain('var module = { exports: {} }; var exports = module.exports;')
    expect(bundle).toContain('return module.exports;')
  })
})

describe('the client bundle is self-contained', () => {
  it('requires only seeded specifiers', () => {
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
    expect(required.length).toBeGreaterThan(0)
    for (const specifier of required) {
      expect(SEEDED, `${specifier} is not in the platform seed table`).toContain(specifier)
    }
  })

  it('requires React from the platform rather than shipping a second copy', () => {
    // `react` must be a seed require, never a bundled copy: two React instances
    // break hooks in ways that surface far from the cause.
    expect(bundle).toContain('require("react")')
    expect(manifest).not.toHaveProperty('dependencies.react')
  })

  it('emits no sibling stylesheet, which nothing would ever fetch', async () => {
    // The shell serves only `exports["./client"]` and its map, so an esbuild CSS
    // file would be a silent loss of every style.
    await expect(stat(join(ROOT, 'lib/client.css'))).rejects.toBeTruthy()
  })

  it('ships a sourcemap the host can parse', async () => {
    const raw = await readFile(join(ROOT, 'lib/client.js.map'), 'utf8')
    const map = JSON.parse(raw) as { version: number; sources: string[]; names: string[]; mappings: string }
    // A malformed map makes the HOST throw while composing the boot graph.
    expect(map.version).toBe(3)
    expect(Array.isArray(map.sources)).toBe(true)
    expect(Array.isArray(map.names)).toBe(true)
    expect(typeof map.mappings).toBe('string')
  })
})

describe('the dictionaries cover the panel', () => {
  /** Every locale key the section can ask for, gathered from its own source. */
  async function usedKeys(): Promise<string[]> {
    const keys = new Set<string>()
    for (const group of GROUPS) {
      keys.add(group.title)
      keys.add(group.description)
      for (const field of group.fields) {
        keys.add(field.label)
        if (field.hint !== undefined) keys.add(field.hint)
        for (const option of field.options ?? []) keys.add(option.label)
      }
    }
    const section = await readFile(join(ROOT, 'src/client/section.tsx'), 'utf8')
    const index = await readFile(join(ROOT, 'src/client/index.tsx'), 'utf8')
    for (const source of [section, index]) {
      for (const match of source.matchAll(/\bt\('([a-zA-Z][\w.]*)'\)/g)) keys.add(match[1] as string)
    }
    return [...keys].sort()
  }

  it('has a non-empty string for every key, in both locales', async () => {
    const keys = await usedKeys()
    expect(keys.length).toBeGreaterThan(30)
    for (const key of keys) {
      // A missing key renders as the raw key, which is how a panel ships looking
      // half-translated. Catching it here costs one assertion.
      expect(zh[key], `zh is missing "${key}"`).toBeTypeOf('string')
      expect(en[key], `en is missing "${key}"`).toBeTypeOf('string')
      expect(zh[key]?.length ?? 0).toBeGreaterThan(0)
      expect(en[key]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('keeps the two dictionaries in step', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})

describe('every declared field points at something real', () => {
  it('resolves each path against a fully-defaulted config', () => {
    // The panel renders from this list and the host writes to it. A path with a
    // typo — `limits.shellTimeout` for `shellTimeoutMs` — renders an empty
    // control that silently discards the operator's edit, which is invisible in
    // review and invisible in the UI. Nineteen paths make that a real risk.
    const config = normalizeConfig({})
    for (const group of GROUPS) {
      for (const field of group.fields) {
        expect(readPath(config, field.path), `no value at ${field.path.join('.')}`).not.toBeUndefined()
      }
    }
  })

  it('exposes the agent-tool allow-list, which was YAML-only', () => {
    const paths = GROUPS.flatMap((group) => group.fields.map((field) => field.path.join('.')))
    expect(paths).toContain('tools.agentTools')
    expect(paths).toContain('agentTools.allow')
    expect(paths).toContain('agentTools.deny')
  })
})

describe('the list editor round-trips a host string[]', () => {
  it('splits on commas and newlines, and trims', () => {
    expect(parseList('read, write ,bash')).toEqual(['read', 'write', 'bash'])
    expect(parseList('read\nwrite')).toEqual(['read', 'write'])
  })

  it('treats blank input as the empty list, which is the "use the default" spelling', () => {
    expect(parseList('')).toEqual([])
    expect(parseList('  , \n ')).toEqual([])
  })

  it('formats an absent value as empty rather than "undefined"', () => {
    expect(formatList(undefined)).toBe('')
    expect(formatList([])).toBe('')
    expect(formatList(['read', 'bash'])).toBe('read, bash')
  })

  it('is stable, so an untouched field writes nothing', () => {
    // `DraftInput` only commits when the displayed string changes; if formatting
    // were lossy, every blur would rewrite the setting.
    const names = ['read', 'bash', 'web_search']
    expect(parseList(formatList(names))).toEqual(names)
  })
})
