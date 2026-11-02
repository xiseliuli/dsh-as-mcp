import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_OWNED_SESSIONS,
  loadOwnedSessions,
  ownershipFile,
  saveOwnedSessions,
} from '../src/dsh/ownership.js'

const scratch: string[] = []

function scratchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-ownership-'))
  scratch.push(dir)
  return join(dir, 'owned.json')
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('owned-session record', () => {
  it('round-trips ids, newest last', () => {
    const file = scratchFile()
    expect(saveOwnedSessions(['session-a', 'session-b'], file)).toBe(true)
    expect(loadOwnedSessions(file)).toEqual(['session-a', 'session-b'])
  })

  it('reads a missing or corrupt file as nothing owned, never as an error', () => {
    const file = scratchFile()
    expect(loadOwnedSessions(file)).toEqual([])
    writeFileSync(file, '{not json')
    expect(loadOwnedSessions(file)).toEqual([])
    writeFileSync(file, JSON.stringify({ version: 2, sessions: ['x'] }))
    expect(loadOwnedSessions(file)).toEqual([])
    writeFileSync(file, JSON.stringify({ version: 1, sessions: ['ok', 7, ''] }))
    expect(loadOwnedSessions(file)).toEqual(['ok'])
  })

  it('keeps the newest ids when the record grows past the cap', () => {
    const file = scratchFile()
    const ids = Array.from({ length: MAX_OWNED_SESSIONS + 5 }, (_, index) => `session-${index}`)
    saveOwnedSessions(ids, file)
    const loaded = loadOwnedSessions(file)
    expect(loaded).toHaveLength(MAX_OWNED_SESSIONS)
    expect(loaded[0]).toBe('session-5')
    expect(loaded.at(-1)).toBe(`session-${MAX_OWNED_SESSIONS + 4}`)
    // The on-disk shape is the documented one.
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version: number }
    expect(parsed.version).toBe(1)
  })

  it('defaults to the token directory under DSH_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-home-'))
    scratch.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      expect(ownershipFile()).toBe(join(home, 'dsh-as-mcp', 'owned.json'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
