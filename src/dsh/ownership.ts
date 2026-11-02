/**
 * The durable record of which sessions this endpoint owns.
 *
 * `session.scope: "owned"` is only useful if it still knows what it created after
 * the plugin process has restarted. The ids live in a small JSON file next to the
 * token (`$DSH_HOME/dsh-as-mcp/owned.json`), created `0600` in a `0700` directory
 * for the same reason the token is: it is not a credential, but it is a record
 * that decides what the endpoint may touch, so it should not be world-readable.
 *
 * The file is **advisory**: a caller holding the bearer token already has the
 * user's authority, and anything that can write this file can write the session
 * store too. Its job is continuity, not containment. Reading is deliberately
 * fail-closed in the only way that matters — a missing or corrupt file means "no
 * sessions are owned", which hides sessions rather than exposing them.
 *
 * @module dsh-as-mcp/dsh/ownership
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveDshHome } from '../mcp/token.js'

/** Upper bound on remembered ids; older ones fall off a FIFO. */
export const MAX_OWNED_SESSIONS = 1_000

/** The ownership record this plugin reads and writes. */
export function ownershipFile(): string {
  return join(resolveDshHome(), 'dsh-as-mcp', 'owned.json')
}

/**
 * Read the remembered ids.
 *
 * Any unreadable or malformed record yields `[]` — an empty ownership set is the
 * safe answer, because it can only ever remove access, never grant it.
 *
 * @param file - Override for tests; defaults to {@link ownershipFile}.
 * @returns Session ids, oldest first.
 */
export function loadOwnedSessions(file: string = ownershipFile()): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: unknown
      sessions?: unknown
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return []
    return parsed.sessions.filter((id): id is string => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

/**
 * Replace the record with `ids`, atomically and owner-only.
 *
 * A tmp file plus rename so a crash mid-write cannot leave a half-JSON file that
 * would read back as "nothing is owned". Failures are reported, not thrown: a
 * read-only DSH home must not make `session_create` fail after the harness has
 * already created the session.
 *
 * @param ids - Session ids to remember.
 * @param file - Override for tests; defaults to {@link ownershipFile}.
 * @returns Whether the record was written.
 */
export function saveOwnedSessions(ids: readonly string[], file: string = ownershipFile()): boolean {
  const remembered = [...ids].slice(-MAX_OWNED_SESSIONS)
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, sessions: remembered })}\n`, { mode: 0o600 })
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}
