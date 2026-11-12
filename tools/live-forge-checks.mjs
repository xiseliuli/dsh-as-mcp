#!/usr/bin/env node
/**
 * Live checks for the read-only forge surface.
 *
 * The forge reads are `ctx.forgePanel`/`ctx.forgeSession` calls scoped by a live
 * session handle, so they need a boot with the forge bundle mounted, a real Git
 * checkout, and a session the harness holds live. A stub cannot prove any of those:
 * the panel reader shells out to git, the bindings come from the forge services, and
 * `ctx.sessions.get` answers only for a session that is currently entered.
 *
 * What this script does, against `tools/isolated-harness.mjs` booted **with
 * `--bundle @deepseek-ai/dsh-experimental-forge-bundle`**:
 *
 *   1. makes a throwaway Git repository with one commit;
 *   2. creates a session in it (the session is live from the moment it is created);
 *   3. writes and edits a file, then reads the working-tree diff — both the file
 *      listing and one file's patch text — and the branch list;
 *   4. reads the session's bound change requests, which is a real (empty) forge read:
 *      no GitHub credentials are needed and nothing is written.
 *
 *   node tools/live-forge-checks.mjs --url http://127.0.0.1:PORT/mcp \
 *     --token-file /tmp/dsh-live-XXXX/dsh-as-mcp/token
 *
 * The scratch repository is removed unless `--keep`.
 *
 * @module dsh-as-mcp/tools/live-forge-checks
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The tool count this build registers. */
const TOOL_COUNT = 50
/** A tracked file the check edits, so the diff has a known path. */
const EDITED_FILE = 'tracked.txt'

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

/** Run one git command in the scratch repository and return trimmed stdout. */
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
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
  const repo = mkdtempSync(join(tmpdir(), 'dsh-forge-live-'))
  let sessionId

  console.log(`endpoint ${url}`)
  console.log(`repo     ${repo}\n`)

  try {
    // A repository with one commit, so `uncommitted` has a baseline to diff against.
    git(repo, ['init', '--initial-branch=main'])
    git(repo, ['config', 'user.email', 'live@example.com'])
    git(repo, ['config', 'user.name', 'Live Check'])
    writeFileSync(join(repo, EDITED_FILE), 'first line\nsecond line\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'baseline'])

    await runner.check('dsh_info reports the live-session and forge probes', async () => {
      const info = await client.callTool('dsh_info', {})
      const services = info.harnessServices ?? {}
      for (const probe of ['sessions', 'forgeSession', 'forgePanel']) {
        if (services[probe] !== true) throw new Error(`harnessServices.${probe}=${JSON.stringify(services[probe])}`)
      }
      const unavailable = (info.toolAvailability?.unavailable ?? []).map((entry) => entry.tool)
      for (const tool of ['forge_changes', 'forge_local_diff', 'forge_branches']) {
        if (unavailable.includes(tool)) throw new Error(`${tool} reported unavailable`)
      }
      return 'sessions/forgeSession/forgePanel all present'
    })

    await runner.check('tools/list advertises the three forge tools', async () => {
      const { payload } = await client.rpc('tools/list', {})
      const names = (payload?.result?.tools ?? []).map((tool) => tool.name)
      if (names.length !== TOOL_COUNT) throw new Error(`expected ${TOOL_COUNT} tools, got ${names.length}`)
      for (const tool of ['forge_changes', 'forge_local_diff', 'forge_branches']) {
        if (!names.includes(tool)) throw new Error(`${tool} missing from tools/list`)
      }
      return `${names.length} tools`
    })

    const created = await client.callTool('session_create', { cwd: repo })
    sessionId = created.sessionId
    console.log(`PASS  session_create creates a live session in the scratch checkout — ${sessionId}`)

    await runner.check('forge_branches lists the checkout branches and the current one', async () => {
      const reply = await client.callTool('forge_branches', { sessionId })
      if (reply.current !== 'main') throw new Error(`current=${JSON.stringify(reply.current)}`)
      if (!(reply.branches ?? []).includes('main')) throw new Error(`branches=${JSON.stringify(reply.branches)}`)
      return `current=main, branches=${JSON.stringify(reply.branches)}`
    })

    await runner.check('forge_local_diff reports an edited tracked file and a new untracked file', async () => {
      // A tracked edit through the endpoint's own file tool, plus a new file created
      // directly, so the listing has both a modification and an addition.
      await client.callTool('file_edit', {
        path: join(repo, EDITED_FILE),
        oldText: 'second line',
        newText: 'second line changed',
      })
      writeFileSync(join(repo, 'added.txt'), 'brand new\n')
      const diff = await client.callTool('forge_local_diff', { sessionId })
      if (diff.scope !== 'uncommitted') throw new Error(`scope=${String(diff.scope)}`)
      const files = diff.files ?? []
      const edited = files.find((file) => file.path === EDITED_FILE)
      if (edited === undefined) throw new Error(`edited file missing from ${JSON.stringify(files.map((file) => file.path))}`)
      if (edited.additions < 1 || edited.deletions < 1) {
        throw new Error(`edited file counts: +${edited.additions}/-${edited.deletions}`)
      }
      const added = files.find((file) => file.path === 'added.txt')
      if (added === undefined) throw new Error('untracked file missing from the listing')
      if (added.untracked !== true) throw new Error(`added.txt untracked=${String(added.untracked)}`)
      return `${files.length} file(s): ${files.map((file) => `${file.path}(${file.status})`).join(', ')}`
    })

    await runner.check('forge_local_diff returns one file patch text for a given path', async () => {
      const patch = await client.callTool('forge_local_diff', { sessionId, path: EDITED_FILE })
      if (typeof patch.text !== 'string' || patch.text === '') throw new Error('no patch text returned')
      if (!patch.text.includes('second line changed')) {
        throw new Error(`patch text does not contain the edit: ${patch.text.slice(0, 200)}`)
      }
      // A patch of a small text edit is far below the cap, so nothing is truncated.
      if (patch.textTruncated === true) throw new Error('a small patch was reported truncated')
      return `${patch.text.length} chars of patch text`
    })

    await runner.check('forge_local_diff bounds the patch text and says so', async () => {
      const full = await client.callTool('forge_local_diff', { sessionId, path: EDITED_FILE })
      const limit = Math.max(1, Math.floor(full.text.length / 2))
      const cut = await client.callTool('forge_local_diff', {
        sessionId,
        path: EDITED_FILE,
        maxChars: limit,
      })
      if (cut.text.length !== limit) throw new Error(`text length ${cut.text.length}, expected ${limit}`)
      if (cut.textTruncated !== true) throw new Error('a cut patch was not flagged textTruncated')
      return `${full.text.length} chars cut to ${limit} with textTruncated set`
    })

    await runner.check('forge_local_diff reports the staged view separately', async () => {
      git(repo, ['add', EDITED_FILE])
      const staged = await client.callTool('forge_local_diff', { sessionId, scope: 'staged' })
      const paths = (staged.files ?? []).map((file) => file.path)
      if (!paths.includes(EDITED_FILE)) throw new Error(`staged view lacks the added file: ${JSON.stringify(paths)}`)
      const unstaged = await client.callTool('forge_local_diff', { sessionId, scope: 'unstaged' })
      const unstagedPaths = (unstaged.files ?? []).map((file) => file.path)
      if (unstagedPaths.includes(EDITED_FILE)) {
        throw new Error('the staged file also appears in the unstaged view')
      }
      return `staged=[${paths.join(',')}] unstaged=[${unstagedPaths.join(',')}]`
    })

    await runner.check('forge_changes reports the session bindings (empty without a forge sign-in)', async () => {
      const reply = await client.callTool('forge_changes', { sessionId })
      if (reply.sessionId !== sessionId) throw new Error(`sessionId=${String(reply.sessionId)}`)
      if (!Array.isArray(reply.changes)) throw new Error('changes is not an array')
      // No change request was opened for this scratch repository, so the honest
      // answer is an empty list — not an error, and not a fabricated binding.
      if (reply.changes.length !== 0) {
        throw new Error(`expected no bindings, got ${JSON.stringify(reply.changes.map((entry) => entry.url))}`)
      }
      return 'no bindings, and the read itself succeeded'
    })
  } finally {
    if (sessionId !== undefined) {
      await client.callTool('session_archive', { sessionId }).catch(() => {})
    }
    if (options.keep !== true) {
      const resolved = resolve(repo)
      if (resolved.startsWith(resolve(tmpdir()) + '/')) rmSync(resolved, { recursive: true, force: true })
    } else {
      console.log(`\nkept repo ${repo}`)
    }
    const failed = runner.summary()
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
