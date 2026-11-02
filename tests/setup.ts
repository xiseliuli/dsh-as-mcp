/**
 * Per-run isolation for `$DSH_HOME`.
 *
 * `session.scope: "owned"` remembers created sessions in
 * `$DSH_HOME/dsh-as-mcp/owned.json`. Without this, a test that creates a session
 * would write that record into the developer's real home directory and later
 * tests (or runs) would inherit ids they never created — two kinds of bug for one
 * line of setup.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-test-home-'))
process.env.DSH_HOME = home

// The ownership record is durable by design, which makes it shared state between
// tests in one run. Wipe it before each test so every test starts from "nothing is
// owned"; a test about persistence writes its own record and reads it back.
beforeEach(() => {
  try {
    rmSync(join(home, 'dsh-as-mcp', 'owned.json'), { force: true })
  } catch {
    // Not existing is the normal case.
  }
})

process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // Leaving a temp directory behind is not worth failing a test run over.
  }
})
