#!/usr/bin/env node
/**
 * Live checks for the worktree / session-organization surface and the harness's
 * two tool-execution contracts.
 *
 * `tools/live-checks.mjs` cannot cover these: it asserts the cheap protocol and
 * session contracts against any profile, while a worktree check needs a real Git
 * checkout, the harness's `worktrees` service (the forge bundle in DSH Desktop /
 * Web), and a session agent it may resume. This script creates all of that itself
 * — a throwaway repository, a workspace, sessions and worktrees — so a fresh boot
 * is enough and nothing depends on machine state.
 *
 * Run it against a **throwaway profile**: it deletes the workspace registration it
 * created but the harness has no session delete, so the sessions it made stay in
 * the profile's history (archive them, or drop the profile). The scratch
 * repository is removed unless `--keep`.
 *
 * Usage:
 *   node tools/live-worktree-checks.mjs --url http://127.0.0.1:8790/mcp
 *   node tools/live-worktree-checks.mjs --url <url> --token-file ~/.dsh/dsh-as-mcp/token
 *   node tools/live-worktree-checks.mjs --url <url> --repo /tmp/existing-checkout --keep
 *
 * @module dsh-as-mcp/tools/live-worktree-checks
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** The six tools this release added; a deployment without them is too old to check. */
const NEW_TOOLS = [
  'worktree_create',
  'worktree_restore',
  'session_archive',
  'session_unarchive',
  'session_pin',
  'session_unpin',
]

/** Parse `--flag value` arguments and reject unknown ones. */
function parseArgs(argv) {
  const options = { keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep') {
      options.keep = true
      continue
    }
    if (!['--url', '--token', '--token-file', '--repo'].includes(arg)) {
      throw new Error(`unknown argument ${arg}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    options[arg.slice(2)] = value
    index += 1
  }
  return options
}

/** The bearer token, from the flag, a file, or the plugin's default location. */
function resolveToken(options) {
  if (options.token !== undefined) return options.token
  const file = options['token-file']
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-as-mcp', 'token')
  return readFileSync(file, 'utf8').trim()
}

/** Run one git command in a repository and return trimmed stdout. */
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A tiny JSON-RPC client: one request per call, either framing accepted. */
function createClient(url, token) {
  let nextId = 1
  return async function rpc(method, params) {
    const id = nextId++
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} from ${url}: ${body.slice(0, 200)}`
          + ' (check --token/--token-file, or set DSH_HOME so the plugin token is found)',
      )
    }
    const framed = response.headers.get('content-type')?.includes('text/event-stream') === true
    const messages = framed
      ? body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
      : [JSON.parse(body)]
    const reply = messages.find((message) => message.id === id)
    if (reply === undefined) throw new Error(`${method}: no reply for id ${id}: ${body.slice(0, 300)}`)
    if (reply.error !== undefined) throw new Error(`${method} failed: ${reply.error.message}`)
    return reply.result
  }
}

/** Pull the text payload out of a tool result. */
function toolText(result) {
  const text = result?.content?.find((block) => block.type === 'text')?.text
  if (typeof text !== 'string') throw new Error(`tool answered no text: ${JSON.stringify(result).slice(0, 300)}`)
  return text
}

const results = { pass: 0, fail: 0 }
function check(name, condition, detail = '') {
  if (condition) {
    results.pass += 1
    console.log(`PASS  ${name}`)
  } else {
    results.fail += 1
    console.log(`FAIL  ${name}${detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const url = options.url ?? process.env.DSH_AS_MCP_URL
  if (url === undefined) throw new Error('pass --url (or set DSH_AS_MCP_URL) to the MCP endpoint')
  const rpc = createClient(url, resolveToken(options))

  const tool = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args })
    return { isError: result?.isError === true, text: toolText(result), json: JSON.parse(toolText(result)) }
  }

  // A scratch repository: one committed file is all the worktree service needs.
  const suffix = randomBytes(3).toString('hex')
  const repo = options.repo ?? mkdtempSync(join(tmpdir(), 'dsh-worktree-'))
  const cleanup = options.repo === undefined
  if (options.repo === undefined) {
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'live-check@test.local'])
    git(repo, ['config', 'user.name', 'live check'])
    writeFileSync(join(repo, 'README.md'), '# live-check repository\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-qm', 'init'])
  }
  const canonicalRepo = git(repo, ['rev-parse', '--show-toplevel'])

  console.log(`endpoint: ${url}`)
  console.log(`repository: ${canonicalRepo}`)

  const createdSessions = []
  const createdWorkspaces = []

  try {
    // --- the tools themselves ------------------------------------------------
    const listed = await rpc('tools/list', {})
    const names = new Set((listed.tools ?? []).map((entry) => entry.name))
    for (const name of NEW_TOOLS) check(`tools/list advertises ${name}`, names.has(name))
    check('tools/list count matches the released surface', names.size >= 38, `${names.size} tools`)

    const info = await tool('dsh_info', {})
    check('worktrees service is mounted', info.json.harnessServices?.worktrees === true)
    check('session agent resolution is available', info.json.harnessServices?.agentResolve === true)
    check('session projections are readable', info.json.harnessServices?.sessionViews === true)
    check('archive/pin operations exist', info.json.harnessServices?.sessionArchive === true
      && info.json.harnessServices?.sessionPin === true)
    check('toolAvailability counts every advertised tool',
      info.json.toolAvailability?.unavailable?.length === 0,
      info.json.toolAvailability?.unavailable)

    // --- one workspace group, one session per worktree ----------------------
    const { json: workspace } = await tool('workspace_create', { path: canonicalRepo, title: 'live worktree check' })
    const workspaceId = workspace.workspace.id
    createdWorkspaces.push(workspaceId)
    const branch = `live-check-${suffix}`
    const created = await tool('session_create', { workspaceId, worktree: { name: branch } })
    const session = created.json
    createdSessions.push(session.sessionId)
    check('session_create returns a worktree record', typeof session.worktree?.path === 'string', session)
    check('session reply keeps the workspace directory as cwd', session.cwd === canonicalRepo, session.cwd)
    check('session reply reports the worktree as workingDirectory', session.workingDirectory === session.worktree?.path)
    check('worktree branch is the requested name', session.worktree?.branch === branch, session.worktree?.branch)
    check('baseCommit is a full commit object name', /^[0-9a-f]{40}$/.test(session.worktree?.baseCommit ?? ''))
    check('repositoryRoot is the source checkout', session.worktree?.repositoryRoot === canonicalRepo)
    check('worktreeError is absent on success', session.worktreeError === undefined)

    const worktreePath = session.worktree.path
    check('git registers the new worktree', git(canonicalRepo, ['worktree', 'list', '--porcelain']).includes(`worktree ${worktreePath}`))
    check('git has the new branch', git(canonicalRepo, ['rev-parse', '--verify', `refs/heads/${branch}`]) !== '')
    check('the checkout was written', git(canonicalRepo, ['-C', worktreePath, 'status', '--short']) === '')

    const { json: workspaces } = await tool('workspace_list', {})
    const attached = workspaces.workspaces.find((entry) => entry.id === workspaceId)?.sessionCount
    check('the session stays attached to its workspace group', attached === 1, `sessionCount ${attached}`)

    const { json: status } = await tool('session_status', { sessionId: session.sessionId })
    check('session_status reports the live working directory', status.workingDirectory === worktreePath, status.workingDirectory)

    const { json: rows } = await tool('session_list', { includeWorktree: true, limit: 20 })
    const row = rows.sessions.find((entry) => entry.sessionId === session.sessionId)
    check('session_list includeWorktree folds the live directory', row?.workingDirectory === worktreePath, row)
    check('session_list rows carry archived/pinned flags', row?.archived === false && row?.pinned === false, row)

    // --- a second worktree, then restore it ---------------------------------
    const second = await tool('worktree_create', { sessionId: session.sessionId, name: `live-check2-${suffix}` })
    check('worktree_create entered a second checkout', typeof second.json.path === 'string', second.json)
    if (typeof second.json.path === 'string') {
      const { json: moved } = await tool('session_status', { sessionId: session.sessionId })
      check('session_status follows the second checkout', moved.workingDirectory === second.json.path, moved.workingDirectory)
      rmSync(second.json.path, { recursive: true, force: true })
      const restored = await tool('worktree_restore', {
        sessionId: session.sessionId,
        path: second.json.path,
        branch: second.json.branch,
        baseCommit: second.json.baseCommit,
        repositoryRoot: second.json.repositoryRoot,
      })
      check('worktree_restore answers the recorded path', restored.json.path === second.json.path, restored.json)
      check('worktree_restore recreated the files', git(canonicalRepo, ['-C', second.json.path, 'status', '--short']) === '')
    }

    // --- the harness's own tool pipeline (0.2.2 batch contract) -------------
    const read = await tool('dsh_tool_call', {
      sessionId: session.sessionId,
      name: 'read',
      args: { file_path: join(canonicalRepo, 'README.md') },
    })
    check('dsh_tool_call runs a permitted tool', read.isError === false && read.json.ok === true, read.json)
    check('dsh_tool_call does not report "Tool batch execution failed"',
      !String(read.json?.text ?? '').includes('Tool batch execution failed'), read.json?.text)

    // --- archive / pin round trip -------------------------------------------
    const archived = await tool('session_archive', { sessionId: session.sessionId, stopActivity: true })
    check('session_archive reports archived', archived.json.archived === true, archived.json)
    const afterArchive = await tool('session_list', { limit: 50 })
    check('the archived flag is visible in session_list',
      afterArchive.json.sessions.find((entry) => entry.sessionId === session.sessionId)?.archived === true)
    const unarchived = await tool('session_unarchive', { sessionId: session.sessionId })
    check('session_unarchive reports unarchived', unarchived.json.archived === false, unarchived.json)
    const pinned = await tool('session_pin', { sessionId: session.sessionId })
    check('session_pin reports pinned', pinned.json.pinned === true, pinned.json)
    const unpinned = await tool('session_unpin', { sessionId: session.sessionId })
    check('session_unpin reports unpinned', unpinned.json.pinned === false, unpinned.json)

    // --- a cwd-only session stays ungrouped, and failures keep the session --
    const bare = await tool('session_create', { cwd: canonicalRepo, worktree: true })
    createdSessions.push(bare.json.sessionId)
    check('a cwd-only session can still get a worktree', typeof bare.json.worktree?.path === 'string', bare.json)
    const { json: regrouped } = await tool('workspace_list', {})
    check('the cwd-only session did not join the workspace group',
      regrouped.workspaces.find((entry) => entry.id === workspaceId)?.sessionCount === 1)
    const duplicate = await tool('session_create', { workspaceId, worktree: { name: branch } })
    createdSessions.push(duplicate.json.sessionId)
    check('a failed worktree request keeps the session', typeof duplicate.json.sessionId === 'string', duplicate.json)
    check('a failed worktree request reports worktreeError', typeof duplicate.json.worktreeError === 'string', duplicate.json.worktreeError)
    check('a failed worktree request reports no worktree record', duplicate.json.worktree === undefined)
  } finally {
    // Remove only the registration: the directory, its worktrees and the session
    // logs stay (the harness has no session delete; a throwaway profile is the
    // intended host for this script).
    for (const workspaceId of createdWorkspaces) {
      await tool('workspace_delete', { workspaceId }).catch(() => {})
    }
    if (cleanup) rmSync(repo, { recursive: true, force: true })
    else console.log(`repository kept in place: ${canonicalRepo}`)
    if (createdSessions.length > 0) {
      console.log(`${createdSessions.length} session(s) were created in this profile: ${createdSessions.join(', ')}`)
    }
  }

  console.log(`\nRESULT pass=${results.pass} fail=${results.fail}`)
  if (results.fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`live-worktree-checks failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
