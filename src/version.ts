import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The MCP server name advertised in the `initialize` result. */
export const SERVER_NAME = 'dsh-as-mcp'

/** Used only when the manifest cannot be read; never a silent constant in the normal path. */
const FALLBACK_VERSION = '0.0.0'

/**
 * The plugin version advertised in the MCP `initialize` result.
 *
 * Read from package.json rather than restated here, so bumping the release
 * cannot leave the handshake advertising a stale version. The manifest sits one
 * directory above this module both in `src/` and in the built `lib/`; an
 * unreadable manifest falls back instead of failing the import, and a test
 * asserts the fallback is not what normally loads.
 */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version !== ''
      ? manifest.version
      : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

export const VERSION = packageVersion()
