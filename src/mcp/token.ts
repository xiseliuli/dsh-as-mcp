import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Where the token came from, so the operator can tell a fresh secret from a configured one. */
export type TokenSource = 'config' | 'file' | 'generated' | 'ephemeral'

/** A resolved bearer token and its provenance. */
export interface ResolvedToken {
  readonly token: string
  readonly source: TokenSource
  /** The file the token is read from and persisted to. */
  readonly file: string
}

/**
 * Prose for where a token came from, shared by every log line that reports one.
 *
 * One helper rather than a ternary per call site, because the sources are not a
 * two-way split and two sites already drifted: both rendered any non-`config`
 * source as "read from <file>", so `ephemeral` produced a line asserting the
 * credential had been read from the token path. Nothing is read from that path
 * in that case — it is not a regular file, which is the whole reason the token
 * is ephemeral — so the line sent an operator debugging a 401 to a file holding
 * someone else's bytes.
 *
 * `settings` is not a {@link TokenSource}: it is what `effectiveToken` reports
 * when the value was pinned in the settings panel, and it must be named here
 * too or it would fall through to the default.
 */
export function describeTokenSource(token: { readonly source: string; readonly file: string }): string {
  switch (token.source) {
    case 'config':
      return 'pinned in the plugin config'
    case 'settings':
      return 'pinned in the settings panel'
    case 'file':
      return `read from ${token.file}`
    case 'generated':
      return `generated and persisted at ${token.file}`
    case 'ephemeral':
      return `minted for this process only and NOT persisted; ${token.file} is not a regular file and was left alone`
    default:
      return `reported as "${token.source}"`
  }
}

/**
 * Resolve `$DSH_HOME`.
 *
 * Mirrors the harness's own `resolveDshHome()`: an explicit environment value
 * wins, otherwise `~/.dsh`. Reading the environment keeps this plugin free of a
 * dependency on `@deepseek-ai/dsh-home-paths`.
 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Resolve the endpoint's bearer token.
 *
 * A configured token always wins. Otherwise the token is read from
 * `<DSH_HOME>/dsh-as-mcp/token`, and generated (mode 0600) on first run so that
 * the endpoint is never accidentally unauthenticated.
 *
 * Never throws. This runs inside the plugin's `apply()`, so a throw here would
 * fail DSH's own boot; an unwritable home degrades to a per-process token
 * (`source: 'ephemeral'`) that the caller reports instead.
 */
export function resolveToken(configured: string): ResolvedToken {
  const file = join(resolveDshHome(), 'dsh-as-mcp', 'token')

  const fromConfig = configured.trim()
  if (fromConfig !== '') return { token: fromConfig, source: 'config', file }

  // A foreign object at the token path — a symlink above all — is not ours to
  // trust: reading it would adopt whatever it points at as the endpoint's
  // secret, and writing it would follow the link and overwrite the target.
  // Mint an ephemeral token instead and leave the object alone.
  try {
    if (!lstatSync(file).isFile()) {
      return { token: randomBytes(32).toString('base64url'), source: 'ephemeral', file }
    }
  } catch {
    // Absent: fall through and read or mint one.
  }

  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing !== '') return { token: existing, source: 'file', file }
  } catch {
    // First run, or an unreadable file: fall through and mint one.
  }

  const token = randomBytes(32).toString('base64url')
  try {
    // Mode 0700: the directory holds a credential, and the default 0755 would
    // make its existence and metadata world-readable even though the file
    // itself is 0600. With `recursive`, the mode applies to what is created.
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
  } catch {
    // A read-only or otherwise unwritable DSH home must not stop DSH from
    // booting. The endpoint stays authenticated, but only for this process:
    // a client has to be handed this token explicitly.
    return { token, source: 'ephemeral', file }
  }
  return { token, source: 'generated', file }
}

/**
 * A token's public fingerprint: enough to confirm that the token in use is the
 * one the endpoint holds, useless for presenting it.
 *
 * The log line that announces the endpoint is the one place a token could leak
 * into a file, and DSH's own logger does happen to mask it today — verified by
 * logging the raw value and grepping the whole log tree for it. Relying on that
 * is relying on a host behaviour this plugin does not control, and a host is
 * free to stop masking. Masking here makes the property local and keeps the
 * debugging value: a prefix mismatch still tells an operator they hold the wrong
 * token.
 */
export function maskToken(token: string): string {
  if (token === '') return '(empty)'
  const prefix = token.slice(0, 4)
  return `${prefix}…(${token.length} chars)`
}

/** Constant-time-ish comparison so a wrong token does not leak its prefix length. */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  // An empty expectation never matches, not even an empty presentation. The
  // XOR loop below would otherwise report `'' === ''` as a match, which turns a
  // caller-side mistake into an open endpoint. `resolveToken` never returns an
  // empty token today, so this is defence in depth — but it is the one guard
  // whose absence would be silent.
  if (expected === '') return false
  if (presented === undefined) return false
  if (presented.length !== expected.length) return false
  let mismatch = 0
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ presented.charCodeAt(index)
  }
  return mismatch === 0
}

/** Extract a bearer token from an `Authorization` header or a `?token=` query value. */
export function presentedToken(
  authorization: string | string[] | undefined,
  queryToken: string | null,
): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization
  if (header !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match?.[1] !== undefined) return match[1].trim()
  }
  return queryToken ?? undefined
}
