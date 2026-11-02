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

const home = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-test-home-'))
process.env.DSH_HOME = home

process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // Leaving a temp directory behind is not worth failing a test run over.
  }
})
