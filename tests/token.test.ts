import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { TokenSource, describeTokenSource, maskToken, resolveToken, tokenMatches } from '../src/mcp/token.js'

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

  it('creates the token directory 0700, not world-readable', () => {
    const home = withHome()
    resolveToken('')
    // The directory holds a credential; the default 0755 would advertise its
    // existence and metadata to every local user even with a 0600 file inside.
    expect(statSync(join(home, 'dsh-as-mcp')).mode & 0o777).toBe(0o700)
  })

  it('does not read or write through a symlink at the token path', () => {
    const home = withHome()
    mkdirSync(join(home, 'dsh-as-mcp'), { recursive: true })
    const victim = join(home, 'innocent.txt')
    writeFileSync(victim, 'do not touch\n')
    symlinkSync(victim, join(home, 'dsh-as-mcp', 'token'))

    const resolved = resolveToken('')

    // The endpoint must not adopt the link target as its secret, and minting a
    // replacement must not follow the link and overwrite the target either.
    expect(resolved.source).toBe<TokenSource>('ephemeral')
    expect(readFileSync(victim, 'utf8')).toBe('do not touch\n')
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

describe('tokenMatches', () => {
  it('matches only an identical token', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true)
    expect(tokenMatches('abc123', 'abc124')).toBe(false)
    expect(tokenMatches('abc123', 'abc12')).toBe(false)
    expect(tokenMatches('abc123', undefined)).toBe(false)
  })

  it('never matches an empty expectation', () => {
    // Without this guard the XOR loop reports '' === '' as a match, which would
    // turn a caller-side mistake into an endpoint with no admission at all. The
    // resolver never returns an empty token, so this is defence in depth — and it
    // is the one guard whose absence would be silent.
    expect(tokenMatches('', '')).toBe(false)
    expect(tokenMatches('', 'anything')).toBe(false)
  })
})

describe('describeTokenSource', () => {
  const file = '/home/u/.dsh/dsh-as-mcp/token'

  it('names the file only for the sources that actually read it', () => {
    expect(describeTokenSource({ source: 'file', file })).toContain(file)
    expect(describeTokenSource({ source: 'generated', file })).toContain(file)
  })

  it('does not claim the file was read when the token is ephemeral', () => {
    // The bug this pins: both log sites rendered any non-`config` source as
    // "read from <file>", so a symlinked token path produced a line asserting the
    // credential had been read from a path that was deliberately not read. An
    // operator chasing a 401 would go read someone else's file.
    const prose = describeTokenSource({ source: 'ephemeral', file })
    expect(prose).not.toMatch(/read from/)
    expect(prose).toMatch(/NOT persisted/)
    // The path still has to appear: it is what the operator must go fix.
    expect(prose).toContain(file)
  })

  it('distinguishes config from settings, which are different sources', () => {
    // `settings` is not a TokenSource — it is what effectiveToken reports for a
    // panel value — so a switch that forgot it would silently fall to the default.
    expect(describeTokenSource({ source: 'config', file })).toMatch(/plugin config/)
    expect(describeTokenSource({ source: 'settings', file })).toMatch(/settings panel/)
  })

  it('never returns an empty string, so a log line cannot lose its reason', () => {
    expect(describeTokenSource({ source: 'something-new', file })).not.toBe('')
  })
})
