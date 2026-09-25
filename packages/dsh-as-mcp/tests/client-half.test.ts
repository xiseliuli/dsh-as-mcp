import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

import { GROUPS } from '../src/client/fields.js'
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
let manifest: { name: string; exports: Record<string, unknown>; dsh?: { client?: { platform?: string } } }

beforeAll(async () => {
  // Build on demand: a test that reads a stale artifact proves nothing, and an
  // unbuilt tree should fail here rather than at the user's next restart.
  await run(process.execPath, ['scripts/build-client.mjs'], { cwd: ROOT })
  bundle = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
  manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as typeof manifest
}, 120_000)

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

  it('inlines React rather than shipping a second copy', () => {
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
