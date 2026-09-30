import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { VERSION } from '../src/version.js'

describe('VERSION', () => {
  it('matches the package version, so initialize never advertises a stale release', async () => {
    // The advertised version is read from the manifest at load time precisely so
    // it cannot drift from a release bump; this catches the fallback path (an
    // unreadable manifest answers 0.0.0) being taken silently.
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
    expect(VERSION).toBe(manifest.version)
  })
})
