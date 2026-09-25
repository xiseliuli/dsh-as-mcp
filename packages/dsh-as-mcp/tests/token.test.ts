import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { TokenSource, maskToken, resolveToken } from '../src/mcp/token.js'

/** Point DSH_HOME at a scratch directory for the duration of one test. */
function withHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-token-'))
  homes.push(home)
  process.env.DSH_HOME = home
  return home
}

const homes: string[] = []
const originalHome = process.env.DSH_HOME

afterEach(() => {
  for (const home of homes.splice(0)) {
    // Restore write permission before removing, so a chmod-ed case still cleans up.
    try {
      chmodSync(join(home, 'dsh-as-mcp'), 0o700)
    } catch {
      // Directory may never have been created.
    }
    rmSync(home, { recursive: true, force: true })
  }
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
})

describe('resolveToken', () => {
  it('generates a token on first run, mode 0600', () => {
    const home = withHome()
    const resolved = resolveToken('')
    expect(resolved.source).toBe<TokenSource>('generated')
    expect(resolved.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(resolved.file).toBe(join(home, 'dsh-as-mcp', 'token'))
    expect(readFileSync(resolved.file, 'utf8').trim()).toBe(resolved.token)
    expect(statSync(resolved.file).mode & 0o777).toBe(0o600)
  })

  it('reuses the token it generated last time', () => {
    withHome()
    const first = resolveToken('')
    const second = resolveToken('')
    expect(second.source).toBe<TokenSource>('file')
    expect(second.token).toBe(first.token)
  })

  it('lets a configured token win over the file', () => {
    withHome()
    resolveToken('')
    const configured = resolveToken('pinned-by-operator')
    expect(configured.source).toBe<TokenSource>('config')
    expect(configured.token).toBe('pinned-by-operator')
  })

  it('never throws when the home cannot be written, and says so', () => {
    // `/dev/null/...` cannot hold a directory: mkdir fails with ENOTDIR.
    process.env.DSH_HOME = '/dev/null/dsh-home'
    const resolved = resolveToken('')
    // The endpoint must stay authenticated even when it cannot persist the secret.
    expect(resolved.source).toBe<TokenSource>('ephemeral')
    expect(resolved.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  it('mints a distinct ephemeral token per process rather than a shared constant', () => {
    process.env.DSH_HOME = '/dev/null/dsh-home'
    expect(resolveToken('').token).not.toBe(resolveToken('').token)
  })
})

describe('maskToken', () => {
  it('keeps a fingerprint and drops the secret', () => {
    const token = 'hSsj-fqhYf9WwmGYTfEzZgA-vIB-d4RixbXUYOLXluo'
    const masked = maskToken(token)
    expect(masked).toBe('hSsj…(43 chars)')
    // The whole point: what it returns cannot be presented to the endpoint.
    expect(masked).not.toContain(token)
    expect(token.startsWith(masked.slice(0, 4))).toBe(true)
  })

  it('is distinguishable between tokens and honest about an empty one', () => {
    expect(maskToken('aaaa1111')).not.toBe(maskToken('bbbb2222'))
    expect(maskToken('')).toBe('(empty)')
  })

  it('does not throw on a token shorter than the prefix', () => {
    expect(maskToken('ab')).toBe('ab…(2 chars)')
  })
})
