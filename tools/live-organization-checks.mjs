#!/usr/bin/env node
/**
 * Live checks for file and workspace organization.
 *
 * These are the writes a human makes when tidying up: rename a workspace, drag a
 * session into a group, reorder it inside that group, and delete or move a file.
 * A stub proves the request building; only a real boot proves that the harness's own
 * registry and filesystem seam accept them — the workspace object it hands back is
 * where `setTitle`/`attachSession`/`insertSessionBefore` live, and the seam's move is a
 * two-phase operation whose outcome shape matters.
 *
 * Runs against `tools/isolated-harness.mjs start`:
 *
 *   node tools/live-organization-checks.mjs --url http://127.0.0.1:PORT/mcp \
 *     --token-file /tmp/dsh-live-XXXX/dsh-as-mcp/token
 *
 * It creates a throwaway directory, one workspace, one session and two files; the
 * files are removed and the session archived afterwards (the harness has no session
 * delete, and the workspace registration is removed again).
 *
 * @module dsh-as-mcp/tools/live-organization-checks
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The tool count this build registers. */
const TOOL_COUNT = 56

/** Parse `--flag value` arguments and reject unknown ones. */
function parseArgs(argv) {
  const options = { keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep') {
      options.keep = true
      continue
    }
    if (!['--url', '--token', '--token-file'].includes(arg)) throw new Error(`unknown argument ${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    options[arg.slice(2)] = value
    index += 1
  }
  if (options.url === undefined) throw new Error('--url is required, e.g. --url http://127.0.0.1:18990/mcp')
  return options
}

/** The bearer token, from the flag, a file, or the plugin's default location. */
function resolveToken(options) {
  if (options.token !== undefined) return options.token
  const file = options['token-file']
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-as-mcp', 'token')
  return readFileSync(file, 'utf8').trim()
}

/** A tiny JSON-RPC client over one Streamable HTTP endpoint. */
function createClient(url, token) {
  let nextId = 1
  async function readReply(response) {
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    if (contentType.includes('text/event-stream')) {
      for (const frame of text.split('\n\n')) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            return JSON.parse(line.slice(5).trim())
          } catch {
            // keep scanning
          }
        }
      }
      return undefined
    }
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  async function rpc(method, params) {
    const id = nextId++
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
    })
    return { status: response.status, payload: await readReply(response) }
  }
  async function callTool(name, args) {
    const { payload } = await rpc('tools/call', { name, arguments: args })
    if (payload?.error !== undefined) throw new Error(`${name}: ${payload.error.message ?? JSON.stringify(payload.error)}`)
    if (payload?.result?.isError === true) {
      throw new Error(`${name}: ${payload.result.content?.[0]?.text ?? 'tool error'}`)
    }
    const text = payload?.result?.content?.[0]?.text
    if (text === undefined) throw new Error(`${name} returned no text content`)
    return JSON.parse(text)
  }
  return { rpc, callTool }
}

/** Install one check runner with PASS/FAIL accounting. */
function createRunner() {
  const results = []
  return {
    results,
    async check(name, body) {
      try {
        const detail = await body()
        results.push({ name, ok: true, detail })
        console.log(`PASS  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
      } catch (error) {
        results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
        console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    summary() {
      const failed = results.filter((result) => !result.ok)
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
      for (const result of failed) console.log(`  FAILED: ${result.name} — ${result.detail}`)
      return failed.length
    },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const token = resolveToken(options)
  const url = options.url
  const client = createClient(url, token)
  const runner = createRunner()
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-org-live-'))
  let workspaceId
  let sessionId

  console.log(`endpoint ${url}`)
  console.log(`scratch  ${scratch}\n`)

  try {
    await runner.check('dsh_info reports the workspace-organize probe and the new tools as available', async () => {
      const info = await client.callTool('dsh_info', {})
      const services = info.harnessServices ?? {}
      if (services.workspaceOrganize !== true) {
        throw new Error(`harnessServices.workspaceOrganize=${JSON.stringify(services.workspaceOrganize)}`)
      }
      const unavailable = (info.toolAvailability?.unavailable ?? []).map((entry) => entry.tool)
      for (const tool of ['workspace_rename', 'session_move', 'session_reorder', 'file_delete', 'file_move']) {
        if (unavailable.includes(tool)) throw new Error(`${tool} reported unavailable`)
      }
      return `${info.toolAvailability?.available} tools available`
    })

    await runner.check('tools/list advertises the five organization tools', async () => {
      const { payload } = await client.rpc('tools/list', {})
      const names = (payload?.result?.tools ?? []).map((tool) => tool.name)
      if (names.length !== TOOL_COUNT) throw new Error(`expected ${TOOL_COUNT} tools, got ${names.length}`)
      for (const tool of ['workspace_rename', 'session_move', 'session_reorder', 'file_delete', 'file_move']) {
        if (!names.includes(tool)) throw new Error(`${tool} missing from tools/list`)
      }
      return `${names.length} tools`
    })

    const workspace = await client.callTool('workspace_create', {
      path: scratch,
      title: 'live organization check',
    })
    workspaceId = workspace.workspace.id
    console.log(`PASS  workspace_create registers the scratch directory — ${workspaceId}`)

    await runner.check('workspace_rename changes the title the sidebar shows', async () => {
      const renamed = await client.callTool('workspace_rename', {
        workspaceId,
        title: 'live organization (renamed)',
      })
      if (renamed.title !== 'live organization (renamed)') throw new Error(`title=${String(renamed.title)}`)
      const listed = await client.callTool('workspace_list', {})
      const row = (listed.workspaces ?? []).find((entry) => entry.id === workspaceId)
      if (row === undefined) throw new Error('renamed workspace missing from workspace_list')
      if (row.title !== 'live organization (renamed)') throw new Error(`listed title=${String(row.title)}`)
      return 'workspace_list reports the new title'
    })

    await runner.check('session_move attaches a cwd-only session to the group and detaches it again', async () => {
      const created = await client.callTool('session_create', { cwd: scratch })
      sessionId = created.sessionId
      const attached = await client.callTool('session_move', {
        sessionId,
        workspaceId,
        action: 'attach',
      })
      if (attached.attached !== true) throw new Error(`attach reported ${JSON.stringify(attached)}`)
      const grouped = await client.callTool('workspace_list', {})
      const row = (grouped.workspaces ?? []).find((entry) => entry.id === workspaceId)
      const sessions = row?.sessionIds ?? []
      if (!sessions.includes(sessionId)) {
        throw new Error(`session missing from the group: ${JSON.stringify(sessions)}`)
      }
      const detached = await client.callTool('session_move', {
        sessionId,
        workspaceId,
        action: 'detach',
      })
      if (detached.attached !== false) throw new Error(`detach reported ${JSON.stringify(detached)}`)
      const ungrouped = await client.callTool('workspace_list', {})
      const after = (ungrouped.workspaces ?? []).find((entry) => entry.id === workspaceId)
      if ((after?.sessionIds ?? []).includes(sessionId)) {
        throw new Error('the session is still attached after detach')
      }
      return 'attach → listed in the group; detach → gone from it'
    })

    await runner.check('session_reorder moves a session in its group order', async () => {
      // Two accounted sessions, then reorder the second before the first.
      const first = sessionId
      const secondCreated = await client.callTool('session_create', { cwd: scratch })
      const second = secondCreated.sessionId
      for (const id of [first, second]) {
        await client.callTool('session_move', { sessionId: id, workspaceId, action: 'attach' })
      }
      const before = await client.callTool('workspace_list', {})
      const orderBefore = (before.workspaces ?? []).find((entry) => entry.id === workspaceId)?.sessionIds ?? []
      // Attaching prepends, so after both attaches the order is [second, first].
      // Moving `first` before `second` is therefore a real change, which the check
      // asserts rather than trusting the call's own reply.
      const moved = await client.callTool('session_reorder', {
        sessionId: first,
        workspaceId,
        beforeSessionId: second,
      })
      if (moved.before !== second) throw new Error(`before=${JSON.stringify(moved.before)}`)
      const after = await client.callTool('workspace_list', {})
      const orderAfter = (after.workspaces ?? []).find((entry) => entry.id === workspaceId)?.sessionIds ?? []
      const movedIndex = orderAfter.indexOf(first)
      const anchorIndex = orderAfter.indexOf(second)
      if (movedIndex < 0 || anchorIndex < 0) throw new Error('a session left the group during reorder')
      // The move asked for `first` before `second`, so that is what must be true.
      if (movedIndex > anchorIndex) {
        throw new Error(`reorder did not take effect: before=${JSON.stringify(orderBefore)} after=${JSON.stringify(orderAfter)}`)
      }
      if (JSON.stringify(orderBefore) === JSON.stringify(orderAfter)) {
        throw new Error(`reorder reported success but the order is unchanged: ${JSON.stringify(orderAfter)}`)
      }
      await client.callTool('session_archive', { sessionId: second }).catch(() => {})
      return `order ${JSON.stringify(orderBefore)} → ${JSON.stringify(orderAfter)}`
    })

    await runner.check('file_move renames one file, and file_delete removes it with a sha256 guard', async () => {
      const originalPath = join(scratch, 'payload.txt')
      const movedPath = join(scratch, 'payload-renamed.txt')
      writeFileSync(originalPath, 'live organization check\n')
      const moved = await client.callTool('file_move', {
        source: originalPath,
        destination: movedPath,
      })
      if (moved.sourceDeleted !== true) throw new Error(`move reported ${JSON.stringify(moved)}`)
      if (moved.operation !== 'create') throw new Error(`operation=${String(moved.operation)}`)
      const readBack = await client.callTool('file_read', { path: movedPath, sha256: true })
      const sha = readBack.sha256
      if (typeof sha !== 'string') throw new Error('file_read did not report a sha256')
      // A wrong guard must refuse and leave the file in place.
      let refused = ''
      try {
        await client.callTool('file_delete', { path: movedPath, expectedSha256: 'f'.repeat(64) })
      } catch (error) {
        refused = String(error.message)
      }
      if (!/refusing to delete/.test(refused)) throw new Error(`a wrong sha256 was not refused: ${refused.slice(0, 120)}`)
      const deleted = await client.callTool('file_delete', { path: movedPath, expectedSha256: sha })
      if (deleted.deleted !== true) throw new Error(`delete reported ${JSON.stringify(deleted)}`)
      const listed = await client.callTool('file_list', { path: scratch })
      if ((listed.entries ?? []).some((entry) => entry.name === 'payload-renamed.txt')) {
        throw new Error('the file still exists after delete')
      }
      return 'move → read+hash → guarded delete'
    })

    await runner.check('file_delete refuses a directory instead of deleting a tree', async () => {
      const nested = join(scratch, 'nested')
      await client.callTool('file_write', { path: join(nested, 'deep.txt'), content: 'x\n' })
      let refused = ''
      try {
        await client.callTool('file_delete', { path: nested })
      } catch (error) {
        refused = String(error.message)
      }
      if (!/is a directory/.test(refused)) throw new Error(`a directory delete was not refused: ${refused.slice(0, 120)}`)
      return 'directory refused with the shell_run hint'
    })
  } finally {
    if (workspaceId !== undefined) {
      await client.callTool('workspace_delete', { workspaceId }).catch(() => {})
    }
    if (sessionId !== undefined) {
      await client.callTool('session_archive', { sessionId }).catch(() => {})
    }
    if (options.keep !== true) {
      const resolved = resolve(scratch)
      if (resolved.startsWith(resolve(tmpdir()) + '/')) rmSync(resolved, { recursive: true, force: true })
    } else {
      console.log(`\nkept scratch ${scratch}`)
    }
    const failed = runner.summary()
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
