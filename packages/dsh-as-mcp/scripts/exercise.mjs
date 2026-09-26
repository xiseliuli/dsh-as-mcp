#!/usr/bin/env node
/**
 * Full acceptance run against a live dsh-as-mcp endpoint.
 *
 * `smoke.mjs` answers "does this speak MCP". This answers the harder question:
 * can an outside agent actually drive a DSH instance through it — create a
 * workspace, start a session, make the DSH agent write code, read that code back
 * off disk, and run it? Every step asserts a real effect, not just a 200.
 *
 * It also exercises the failure paths deliberately, because a bridge that works
 * when everything is present but returns an opaque 500 when something is missing
 * is not usable from another agent: an unknown tool must be reported as an
 * unknown tool, and a missing session must say so.
 *
 *   node scripts/exercise.mjs [--url http://127.0.0.1:8790/mcp] [--token <value>]
 *                             [--dir <scratch>] [--keep] [--no-color]
 *
 * Exits non-zero on the first failed expectation, after reporting every step.
 *
 * @module dsh-as-mcp/scripts/exercise
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)

function flag(name) {
  return argv.includes(`--${name}`)
}

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`--${name} needs a value\n`)
    process.exit(2)
  }
  return value
}

const endpoint = option('url', 'http://127.0.0.1:8790/mcp')
const keep = flag('keep')
const useColor = process.stdout.isTTY === true && !flag('no-color')

const dim = (text) => (useColor ? `\u001b[2m${text}\u001b[0m` : text)
const green = (text) => (useColor ? `\u001b[32m${text}\u001b[0m` : text)
const red = (text) => (useColor ? `\u001b[31m${text}\u001b[0m` : text)
const bold = (text) => (useColor ? `\u001b[1m${text}\u001b[0m` : text)

let passed = 0
let failed = 0

function check(ok, label, detail) {
  const mark = ok ? green('✓') : red('✗')
  process.stdout.write(`${mark} ${label.padEnd(34)}${detail === undefined ? '' : dim(String(detail))}\n`)
  if (ok) passed += 1
  else failed += 1
  return ok
}

function section(title) {
  process.stdout.write(`\n${bold(title)}\n`)
}

// --- transport -------------------------------------------------------------

let token = option('token', undefined)
let protocolVersion
let nextId = 1
let sessionHeader

if (token === undefined) {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const path = join(home, 'dsh-as-mcp', 'token')
  if (existsSync(path)) token = (await readFile(path, 'utf8')).trim()
}

async function post(body, headers = {}) {
  return await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(protocolVersion === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
      ...(sessionHeader === undefined ? {} : { 'mcp-session-id': sessionHeader }),
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function rpc(method, params) {
  const id = nextId++
  const response = await post({ jsonrpc: '2.0', id, method, params })
  const session = response.headers.get('mcp-session-id')
  if (session !== null) sessionHeader = session

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail.trim().slice(0, 200)}` : ''}`)
  }
  const body = await response.text()
  const payload = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)))
        .find((entry) => entry.id === id)
    : JSON.parse(body)

  if (payload === undefined) throw new Error(`no reply for id ${id}`)
  if (payload.error) throw new Error(`JSON-RPC ${payload.error.code}: ${payload.error.message}`)
  return payload.result
}

/**
 * Call a tool, returning `{ ok, payload, error }` rather than throwing.
 *
 * Two different layers report failure and both matter here: a tool that ran and
 * failed comes back as `isError` content, while a name the server does not know
 * is a JSON-RPC error and never reaches a tool at all.
 */
async function tool(name, args = {}) {
  let result
  try {
    result = await rpc('tools/call', { name, arguments: args })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const text = result?.content?.[0]?.text ?? ''
  if (result?.isError === true) return { ok: false, error: text }
  try {
    return { ok: true, payload: JSON.parse(text) }
  } catch {
    return { ok: true, payload: text }
  }
}

/** Call a tool that is expected to succeed. */
async function must(name, args = {}) {
  const outcome = await tool(name, args)
  if (!outcome.ok) throw new Error(`${name} failed: ${outcome.error}`)
  return outcome.payload
}

// --- run -------------------------------------------------------------------

process.stdout.write(`${bold('dsh-as-mcp acceptance run')}\n${dim(endpoint)}\n`)
if (token === undefined) {
  process.stdout.write(`${red('no bearer token found')} — pass --token or create the token file\n`)
  process.exit(2)
}

section('handshake')
{
  const result = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-as-mcp-exercise', version: '1.0.0' },
  })
  check(result?.serverInfo?.name === 'dsh-as-mcp', 'initialize', `${result?.serverInfo?.name} ${result?.serverInfo?.version}`)
  protocolVersion = result?.protocolVersion
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const unauthorized = await post(
    { jsonrpc: '2.0', id: 999, method: 'tools/list', params: {} },
    { authorization: 'Bearer definitely-not-the-token' },
  )
  check(unauthorized.status === 401, 'a wrong token is refused', `${unauthorized.status}`)
}

section('surface')
{
  const { tools } = await rpc('tools/list')
  const names = tools.map((entry) => entry.name).sort()
  // Sorted, because `names` is sorted above — so this list must be in collation
  // order, not registration order.
  const expected = [
    'dsh_info',
    'dsh_tool_call',
    'dsh_tool_list',
    'file_list',
    'file_read',
    'file_write',
    'session_cancel',
    'session_create',
    'session_list',
    'session_messages',
    'session_prompt',
    'shell_run',
    'workspace_create',
    'workspace_list',
  ]
  check(
    JSON.stringify(names) === JSON.stringify(expected),
    'tools/list exposes all 14 tools',
    `${names.length} tools`,
  )
  check(
    tools.every((entry) => typeof entry.description === 'string' && entry.description.length > 20),
    'every tool is described',
  )

  const info = await must('dsh_info')
  check(info.listening === true, 'endpoint reports itself listening', info.endpoint)
  check(
    info.listenError === null || info.listenError === undefined,
    'no bind error',
    info.listenError ?? 'none',
  )
  // The token must not come back in a tool result: this is a live credential, and
  // whatever calls this tool writes the payload into a transcript.
  check(
    typeof info.tokenSource === 'string' && !JSON.stringify(info).includes(token),
    'dsh_info withholds the token value',
    `source: ${info.tokenSource}`,
  )
  check(
    info.settingsRegistered === true,
    'settings namespace is registered',
    info.settingsRegistered ? 'panel available' : 'panel unavailable',
  )
  // Both of these are objects keyed by name, not lists.
  const groups = info.enabledToolGroups ?? {}
  const wanted = ['workspace', 'session', 'files', 'shell', 'agentTools']
    .filter((group) => groups[group] !== true)
  check(wanted.length === 0, 'all five tool groups are enabled', Object.keys(groups).join(', '))
  const services = info.harnessServices ?? {}
  for (const service of ['workspaceRegistry', 'sessionController', 'agents', 'fs', 'shell', 'tools']) {
    check(services[service] === true, `harness service: ${service}`)
  }
}

// A FIXED scratch path, not a fresh temp directory per run. Registering a
// workspace is permanent — the harness offers no unregister — so `mkdtemp` here
// would leave one dead entry in the user's DSH workspace list per run, each
// pointing at a directory that no longer exists. A stable path means
// `workspace_create` is idempotent across runs and exactly one registration ever
// appears. The directory itself is deleted first so the "create a missing
// directory" path is still exercised every time.
const scratch = option('dir', join(tmpdir(), 'dsh-as-mcp-exercise'))
const projectPath = join(scratch, 'demo-project')
await rm(projectPath, { recursive: true, force: true })
const codePath = join(projectPath, 'fizzbuzz.mjs')
let workspaceId
let sessionId

try {
  section('workspaces')
  {
    const created = await must('workspace_create', { path: projectPath, title: 'MCP exercise' })
    workspaceId = created.workspace?.id ?? created.id
    check(typeof workspaceId === 'string' && workspaceId !== '', 'workspace_create', workspaceId)
    check(existsSync(projectPath), 'the directory was created on disk', projectPath)

    const again = await must('workspace_create', { path: projectPath })
    const againId = again.workspace?.id ?? again.id
    check(againId === workspaceId, 're-creating the same path is idempotent', againId)

    const listed = await must('workspace_list')
    check(
      (listed.workspaces ?? []).some((entry) => entry.id === workspaceId),
      'the workspace appears in workspace_list',
    )
  }

  section('sessions')
  {
    const created = await must('session_create', { workspaceId })
    sessionId = created.sessionId ?? created.session?.id ?? created.id
    check(typeof sessionId === 'string' && sessionId !== '', 'session_create', sessionId)

    const listed = await must('session_list', { limit: 50 })
    check(
      (listed.sessions ?? []).some((entry) => (entry.sessionId ?? entry.id) === sessionId),
      'the session appears in session_list',
      `${(listed.sessions ?? []).length} sessions`,
    )
  }

  section('the DSH agent writes code')
  {
    const prompt = [
      `Create the file ${codePath} containing a Node script that prints FizzBuzz for 1 to 15,`,
      'one value per line (multiples of 3 print Fizz, of 5 print Buzz, of both print FizzBuzz).',
      'Then run it and confirm it works. Do not print anything else.',
    ].join(' ')
    const outcome = await must('session_prompt', { sessionId, prompt, timeoutMs: 300_000 })
    const turn = outcome.turn ?? {}
    check(
      turn.timedOut !== true,
      'the turn settled before the timeout',
      typeof turn.turnEndReason === 'string' ? turn.turnEndReason : JSON.stringify(turn.turnEndReason),
    )
    check(typeof turn.reply === 'string' && turn.reply.trim() !== '', 'the agent replied', `${(turn.reply ?? '').length} chars`)
    check((turn.toolCalls ?? []).length > 0, 'the agent used its own tools', `${(turn.toolCalls ?? []).length} calls`)
    const names = [...new Set((turn.toolCalls ?? []).map((call) => call.name))]
    check(names.length > 0, 'tool calls are named', names.join(', '))
    check(existsSync(codePath), 'the file really exists on disk', codePath)
  }

  section("reading the agent's work back through MCP")
  {
    const written = await must('file_read', { path: codePath })
    const text = written.content ?? written.text ?? ''
    check(text.length > 0, 'file_read returns the file', `${text.length} bytes`)
    check(
      /fizzbuzz/i.test(text) || /Fizz/.test(text),
      'the content looks like the requested program',
    )
    check(written.truncated !== true, 'the read was not truncated')

    const listed = await must('file_list', { path: projectPath })
    const entries = listed.entries ?? listed.files ?? []
    check(
      entries.some((entry) => (typeof entry === 'string' ? entry : entry.name) === 'fizzbuzz.mjs'),
      'file_list sees the file',
      `${entries.length} entries`,
    )
  }

  section('the plugin writes its own file')
  {
    const path = join(projectPath, 'from-mcp.txt')
    await must('file_write', { path, content: 'written over MCP\n', createDirectories: true })
    const read = await must('file_read', { path })
    check((read.content ?? read.text ?? '') === 'written over MCP\n', 'file_write then file_read round-trips')
    check((await readFile(path, 'utf8')) === 'written over MCP\n', 'the bytes match on disk')
  }

  section('shell')
  {
    const result = await must('shell_run', {
      command: `node ${JSON.stringify(codePath)}`,
      cwd: projectPath,
      timeoutMs: 60_000,
    })
    const stdout = result.stdout ?? ''
    const lines = stdout.trim().split('\n')
    check(result.exitCode === 0, 'the generated program exits 0', `exit ${result.exitCode}`)
    check(
      JSON.stringify(lines) ===
        JSON.stringify(['1', '2', 'Fizz', '4', 'Buzz', 'Fizz', '7', '8', 'Fizz', 'Buzz', '11', 'Fizz', '13', '14', 'FizzBuzz']),
      'FizzBuzz 1..15 is correct',
      `${lines.length} lines`,
    )
  }

  section('transcript')
  {
    const messages = await must('session_messages', { sessionId, limit: 50 })
    const list = messages.messages ?? []
    check(list.length > 0, 'session_messages returns the transcript', `${list.length} messages`)
    check(
      list.some((entry) => typeof entry.text === 'string' && entry.text.includes('FizzBuzz')),
      'the transcript contains the prompt',
    )
    check(
      list.some((entry) => entry.role === 'assistant'),
      'the transcript contains the reply',
    )
  }

  section('failure paths are legible')
  {
    const unknown = await tool('no_such_tool', {})
    check(!unknown.ok, 'an unknown tool is refused', (unknown.error ?? '').slice(0, 60))

    const missing = await tool('file_read', { path: join(projectPath, 'nope.txt') })
    check(!missing.ok, 'a missing file is refused', (missing.error ?? '').slice(0, 60))

    const bogus = await tool('session_prompt', { sessionId: 'not-a-session', prompt: 'hi', timeoutMs: 5_000 })
    check(!bogus.ok, 'an unknown session is refused', (bogus.error ?? '').slice(0, 60))

    const invalid = await tool('workspace_create', {})
    check(!invalid.ok, 'a missing required argument is refused', (invalid.error ?? '').slice(0, 60))

    const bad = await tool('shell_run', { command: 'exit 3' })
    check(bad.ok, 'a failing command still returns a result', `exit ${bad.payload?.exitCode}`)
    check(bad.payload?.exitCode === 3, 'its exit code is reported', `${bad.payload?.exitCode}`)
  }

  section('agent tools')
  {
    // A session is mandatory. DSH registers tools into the scope of the context
    // that registers them, and every tool package ships inside an agent preset, so
    // the global layer is empty: an unscoped listing is `[]` and an unscoped call
    // answers `unknown tool`. Asking without one must therefore FAIL LOUDLY rather
    // than report an empty toolbox, which would read as "nothing is permitted".
    const unscoped = await tool('dsh_tool_list', {})
    check(!unscoped.ok, 'dsh_tool_list without a session is refused', (unscoped.error ?? '').slice(0, 70))
    check(
      (unscoped.error ?? '').includes('sessionId is required'),
      'and says why, instead of returning an empty list',
    )

    const listed = await must('dsh_tool_list', { sessionId })
    const names = (listed.tools ?? []).map((entry) => entry.name)
    check(names.length > 0, 'dsh_tool_list reports a permitted set', `${names.length} tools`)
    check(names.includes('read'), 'a deterministic tool is permitted', 'read')

    // The security property of this group, checked live rather than only in unit
    // tests: the escape hatches must be absent from the LISTING as well as refused
    // on call. `run_code` is the one that matters most — it runs a program that can
    // invoke any other tool by name, so exposing it would void the allow-list.
    const forbidden = [
      'run_code', 'cordis_run', 'cordis_define', 'cordis_undefine',
      'workflow', 'ralph', 'spawn_teammate', 'wait_agent',
      'ask_user_question', 'create_goal', 'update_goal', 'schedule_create',
    ]
    const leaked = forbidden.filter((name) => names.includes(name))
    check(leaked.length === 0, 'the escape hatches are not listed', leaked.join(', ') || 'none listed')

    // A real write/read pair through the real pipeline, which is what makes this
    // more than a listing test: pre-policy, guards and the fs seam all ran.
    const target = join(projectPath, 'agent-tool.txt')
    const wrote = await tool('dsh_tool_call', {
      name: 'write',
      args: { file_path: target, content: 'via dsh_tool_call' },
      sessionId,
    })
    check(wrote.ok, 'dsh_tool_call runs a permitted tool', (wrote.error ?? 'ok').slice(0, 60))
    check(existsSync(target), 'the file exists on disk', target)

    const read = await tool('dsh_tool_call', { name: 'read', args: { file_path: target }, sessionId })
    check(read.ok, 'the result comes back through the same tool', (read.error ?? 'ok').slice(0, 60))
    check(
      typeof read.payload?.text === 'string' && read.payload.text.includes('via dsh_tool_call'),
      'its text is returned to the caller',
    )

    // Refused on call even though the harness itself registers it.
    const escape = await tool('dsh_tool_call', { name: 'run_code', args: { code: 'return 1' }, sessionId })
    check(!escape.ok, 'run_code is refused on call, not merely hidden', (escape.error ?? '').slice(0, 60))

    const unknown = await tool('dsh_tool_call', { name: 'definitely_not_a_tool', args: {}, sessionId })
    check(!unknown.ok, 'an unknown tool name is refused', (unknown.error ?? '').slice(0, 60))

    const ghost = await tool('dsh_tool_list', { sessionId: 'not-a-real-session' })
    check(ghost.ok, 'an unresolvable session is reported, not thrown', (ghost.error ?? 'ok').slice(0, 40))
    check(
      typeof ghost.payload?.scopeError === 'string',
      'and carries a scopeError naming the cause',
      (ghost.payload?.scopeError ?? 'none').slice(0, 60),
    )
  }
} catch (error) {
  check(false, 'run aborted', error instanceof Error ? error.message : String(error))
} finally {
  // The project directory is removed either way; the workspace registration is
  // left in place so the next run reuses it rather than adding another.
  if (!keep) await rm(projectPath, { recursive: true, force: true })
  else process.stdout.write(`\n${dim(`artifacts kept at ${projectPath}`)}\n`)
}

process.stdout.write(
  `\n${failed === 0 ? green('ALL GOOD') : red('FAILURES')} — ${passed} passed, ${failed} failed\n`,
)
if (keep && failed > 0) process.stdout.write(dim(`artifacts: ${scratch}\n`))
process.exit(failed === 0 ? 0 : 1)
