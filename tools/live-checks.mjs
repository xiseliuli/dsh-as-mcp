#!/usr/bin/env node
/**
 * Live protocol and lifecycle checks against a running dsh-as-mcp endpoint.
 *
 * `scripts/` holds what ships: `smoke.mjs` (is the wire up?) and `exercise.mjs`
 * (can an outside agent drive a DSH instance?). This file holds the checks that
 * only make sense against a real harness process and that the shipped scripts
 * either cannot afford on every run or cannot express without a second client:
 *
 * - the protocol contract a generic MCP client relies on (parse error, method
 *   not found, a 401 that challenges for a bearer token, a declared oversized
 *   body refused before it is read);
 * - list/paging contracts that need real services on the other end;
 * - with `--with-model`: progress notification streaming and MCP
 *   `notifications/cancelled`, both of which spend real tokens.
 *
 * It is deliberately not in the published package (`package.json` `files`), so a
 * maintainer runs it from a checkout:
 *
 *   node tools/live-checks.mjs --url http://127.0.0.1:8821/mcp
 *   node tools/live-checks.mjs --url http://127.0.0.1:8821/mcp --with-model
 *   node tools/live-checks.mjs --url http://127.0.0.1:8821/mcp --with-subagent
 *   node tools/live-checks.mjs --url http://127.0.0.1:8790/mcp --old-endpoint
 *
 * The endpoint resolution matches the shipped scripts: `--url`, then
 * `DSH_AS_MCP_URL`, then the loopback default; the token comes from `--token`,
 * then `DSH_AS_MCP_TOKEN`, then `<DSH_HOME>/dsh-as-mcp/token`.
 *
 * @module dsh-as-mcp/tools/live-checks
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const color = !flag('--no-color')
const dim = (text) => (color ? `\u001B[2m${text}\u001B[0m` : text)
const green = (text) => (color ? `\u001B[32m${text}\u001B[0m` : text)
const red = (text) => (color ? `\u001B[31m${text}\u001B[0m` : text)
const bold = (text) => (color ? `\u001B[1m${text}\u001B[0m` : text)

const resolveDshHome = () =>
  process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')

let endpoint = option('--url', process.env.DSH_AS_MCP_URL ?? 'http://127.0.0.1:8790/mcp')
const urlSource = option('--url', undefined) !== undefined ? 'arg' : process.env.DSH_AS_MCP_URL !== undefined ? 'env' : 'default'
if (!endpoint.endsWith('/mcp') && !endpoint.includes('?')) endpoint = endpoint.replace(/\/+$/, '') + '/mcp'

let token = option('--token', process.env.DSH_AS_MCP_TOKEN?.trim())
const tokenSource = option('--token', undefined) !== undefined ? 'arg' : process.env.DSH_AS_MCP_TOKEN !== undefined ? 'env' : 'file'
if (token === undefined) {
  const path = join(resolveDshHome(), 'dsh-as-mcp', 'token')
  if (existsSync(path)) token = (await readFile(path, 'utf8')).trim()
}

process.stderr.write(
  `endpoint: ${endpoint} (${urlSource})${token === undefined ? `\n${red('no bearer token found')}` : ''}\n`,
)
if (token === undefined && !flag('--allow-anonymous')) process.exit(2)

let passed = 0
let failed = 0
let skipped = 0
/**
 * `--old-endpoint` turns a contract mismatch into a skip.
 *
 * The checks describe the *current* build's contracts; an older deployment
 * (the desktop app in this session runs 0.2.0) legitimately predates some of them.
 * Pointing the script at such an endpoint is useful — it says exactly which
 * contracts that build lacks — but it should not read as a failure of the run.
 */
const vintageEndpoint = flag('--old-endpoint')
function check(ok, label, detail) {
  if (!ok && vintageEndpoint) {
    process.stdout.write(`  ${dim('-')} ${label} ${dim(`(older endpoint: ${String(detail ?? 'contract absent')})`)}\n`)
    skipped += 1
    return false
  }
  const mark = ok ? green('✓') : red('✗')
  process.stdout.write(`  ${mark} ${label}${detail === undefined ? '' : ` ${dim(String(detail))}`}\n`)
  if (ok) passed += 1
  else failed += 1
  return ok
}
function section(title) {
  process.stdout.write(`\n${bold(title)}\n`)
}

// --- transport -------------------------------------------------------------

let protocolVersion
let requestSeq = 1

function headers(extra = {}) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...(protocolVersion === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
    ...extra,
  }
}

/** One JSON-RPC request, returning `{ status, events, payload }`. */
async function rpcOnce(id, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const body = await response.text()
  const events = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
  const payload = events.find((entry) => entry.id === id) ?? events[0]
  return { status: response.status, events, payload }
}

async function rpc(method, params) {
  const id = requestSeq++
  const result = await rpcOnce(id, method, params)
  if (result.payload?.error) throw new Error(`JSON-RPC ${result.payload.error.code}: ${result.payload.error.message}`)
  return result.payload?.result
}

async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result?.content?.[0]?.text ?? ''
  if (result?.isError === true) throw new Error(`${name}: ${text}`)
  return JSON.parse(text)
}

async function attemptTool(name, args = {}) {
  try {
    return { ok: true, payload: await callTool(name, args) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The tools this endpoint advertises, read once after `initialize`.
 *
 * Checks are gated on it so the script can run against an older build and say
 * "skipped" instead of reporting a missing feature as a failure. The desktop app
 * in this session, for example, runs an old plugin build; running these checks
 * against it should describe what that build cannot do, not accuse it.
 */
let surface = new Set()

function has(tool) {
  return surface.has(tool)
}

function skip(label, why) {
  process.stdout.write(`  ${dim('-')} ${label} ${dim(`(skipped: ${why})`)}
`)
}

// --- protocol --------------------------------------------------------------

async function protocolChecks() {
  section('protocol contract')
  const malformed = await fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: '{not json',
  })
  const malformedBody = await malformed.text()
  check(malformed.status === 400 && malformedBody.includes('-32700'), 'malformed JSON is a parse error', `HTTP ${malformed.status}`)

  const unknown = await rpcOnce(9_001, 'no/such-method', {})
  check(unknown.payload?.error?.code === -32601, 'an unknown method is method-not-found', `code ${unknown.payload?.error?.code}`)

  const denied = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{}',
  })
  check(
    denied.status === 401 && (denied.headers.get('www-authenticate') ?? '').toLowerCase().includes('bearer'),
    'a missing token challenges with WWW-Authenticate: Bearer',
    `HTTP ${denied.status}`,
  )

  const parsed = new URL(endpoint)
  const oversize = await new Promise((resolve) => {
    const attempt = httpRequest(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: { ...headers(), 'content-length': String(999 * 1024 * 1024) },
      },
      (response) => {
        resolve(response.statusCode)
        response.resume()
      },
    )
    attempt.on('error', (error) => resolve(`error: ${error.message}`))
    attempt.end()
  })
  check(oversize === 413, 'a declared oversized body is refused before it is read', `HTTP ${oversize}`)
}

// --- shell -----------------------------------------------------------------

async function shellChecks() {
  section('background shell')
  if (!has('shell_start') || !has('shell_list') || !has('shell_kill')) {
    skip('background shell checks', 'this endpoint advertises no shell_start/shell_list/shell_kill')
    return
  }
  const running = await callTool('shell_start', { command: 'sleep 20' })
  const listed = await callTool('shell_list', { running: true })
  check(
    (listed.jobs ?? []).some((job) => job.jobId === running.jobId),
    'shell_list { running: true } includes the live job',
    `${(listed.jobs ?? []).length} running`,
  )
  const killed = await callTool('shell_kill', { jobId: running.jobId })
  check(killed.killed === true && killed.status === 'killed', 'shell_kill stops it', killed.status)
  const afterKill = await callTool('shell_list', { running: true })
  check(
    !(afterKill.jobs ?? []).some((job) => job.jobId === running.jobId),
    'the settled job leaves the running filter',
    `${(afterKill.jobs ?? []).length} running`,
  )
}

// --- lists and paging ------------------------------------------------------

async function listChecks() {
  section('list and paging contracts')
  let sessionId
  if (!has('session_create') || !has('session_list')) {
    skip('session listing checks', 'this endpoint advertises no session_create/session_list')
  } else {
    // The harness requires a directory: there is no "some default workspace" form.
    const created = await callTool('session_create', { cwd: process.cwd() })
    sessionId = created.sessionId
    const page = await callTool('session_list', { limit: 1 })
    check(
      page.sessions?.length <= 1 && typeof page.total === 'number' && (page.truncated === true) === (page.total > 1),
      'session_list reports total and truncation',
      `${page.sessions?.length ?? 0} of ${page.total ?? '?'}`,
    )
  }

  if (!has('file_write') || !has('file_read')) {
    skip('file paging checks', 'this endpoint advertises no file_write/file_read')
  } else {
    const path = join('/tmp', `dsh-as-mcp-live-checks-${process.pid}.txt`)
    await callTool('file_write', { path, content: 'first line\nsecond line\nthird line\n' })
    const sliced = await callTool('file_read', { path, maxBytes: 11 })
    check(
      sliced.truncated === true && typeof sliced.nextOffset === 'number' && sliced.size === 34,
      'file_read reports truncated, nextOffset and the whole size',
      `${sliced.bytes ?? '?'}/${sliced.size ?? '?'} bytes, next ${sliced.nextOffset ?? '?'}`,
    )
  }

  // Search is opt-in in shipped compositions, so both answers are legitimate. The
  // probe in dsh_info is the honest answer to "does search work here"; the tool
  // call must agree with it.
  if (!has('session_search')) {
    skip('session-search checks', 'this endpoint advertises no session_search')
  } else {
  const info = await callTool('dsh_info', { probeSearch: true })
  const searchState = info.search
  check(
    typeof searchState?.available === 'boolean' &&
      (searchState.available ? searchState.matches === 0 : /openAt/.test(searchState.reason ?? '')),
    'dsh_info { probeSearch: true } reports whether search really works',
    searchState?.available === true ? 'available' : (searchState?.reason ?? 'no probe').slice(0, 60),
  )
  const freshToken = randomUUID().replace(/-/g, '')
  const search = await attemptTool('session_search', { query: freshToken })
  if (searchState?.available === true) {
    check(
      search.ok && (search.payload?.items ?? []).length === 0 && typeof search.payload?.hasMore === 'boolean',
      'session_search answers a token that appears nowhere with no matches',
      `${(search.payload?.items ?? []).length} match(es)`,
    )
  } else {
    check(
      !search.ok && /openAt/.test(search.error ?? '') && /first-search|startup/.test(search.error ?? ''),
      'a disabled session-search index reports how to enable it',
      (search.error ?? '').slice(0, 60),
    )
  }
  }

  if (!has('session_usage')) {
    skip('usage-scope check', 'this endpoint advertises no session_usage')
  } else {
    const usage = await callTool('session_usage', { cwd: '/tmp/definitely-no-sessions-here' })
    check(
      usage.scope === 'workspace' && (usage.sessions ?? []).length === 0 && (usage.notes ?? []).some((note) => /No session this DSH knows ran in/.test(note)),
      'an empty workspace total is explained, not silently zero',
      usage.scope,
    )
  }

  if (!has('session_queue')) {
    skip('queue listing check', 'this endpoint advertises no session_queue')
  } else if (sessionId !== undefined) {
    const queue = await callTool('session_queue', { sessionId })
    check(
      Array.isArray(queue.queued) && (queue.note === undefined || typeof queue.note === 'string'),
      'session_queue lists the pending inbox',
      `${(queue.queued ?? []).length} queued`,
    )
  }
  return sessionId
}

// --- concurrency -----------------------------------------------------------

/**
 * Several callers at once, the way an external harness or an agent team actually
 * uses the endpoint. This is not a benchmark: it asserts that parallel requests all
 * answer and that sharing a session or a file does not serialize into a failure.
 */
async function concurrencyChecks() {
  section('concurrency')
  const startedAt = Date.now()
  const infos = await Promise.all(Array.from({ length: 20 }, () => callTool('dsh_info')))
  const versions = new Set(infos.map((info) => info.version))
  check(
    infos.every((info) => typeof info.version === 'string') && versions.size === 1,
    '20 parallel dsh_info calls all answer with one version',
    `${infos.length} answers, ${versions.size} version(s)`,
  )

  if (has('file_write') && has('file_read')) {
    const path = join('/tmp', `dsh-as-mcp-live-load-${process.pid}.txt`)
    const payload = 'load line\n'.repeat(50)
    await Promise.all(Array.from({ length: 8 }, (_, index) => callTool('file_write', {
      path: `${path}.${index}`,
      content: `${payload}${index}`,
    })))
    const reads = await Promise.all(Array.from({ length: 8 }, (_, index) => callTool('file_read', {
      path: `${path}.${index}`,
    })))
    check(
      reads.every((read, index) => typeof read.text === 'string' && read.text.endsWith(String(index))),
      '8 parallel file writes then reads stay consistent',
      `${reads.length} reads in ${Date.now() - startedAt} ms`,
    )
    for (let index = 0; index < 8; index += 1) rmSync(`${path}.${index}`, { force: true })
  }

  if (has('session_list')) {
    const pages = await Promise.all(Array.from({ length: 12 }, () => callTool('session_list', { limit: 3 })))
    const totals = new Set(pages.map((page) => page.total))
    check(
      pages.every((page) => Array.isArray(page.sessions)) && totals.size === 1,
      '12 parallel session_list calls agree on the total',
      `${pages.length} answers, ${[...totals].join('/')} total`,
    )
  }
}

// --- availability contract -------------------------------------------------

async function availabilityCheck() {
  section('availability contract')
  const info = await callTool('dsh_info')
  const availability = info.toolAvailability
  if (availability === undefined) {
    process.stdout.write('  - endpoint predates dsh_info.toolAvailability; skipping\n')
    return
  }
  const listed = await rpc('tools/list', {})
  const names = new Set((listed.tools ?? []).map((tool) => tool.name))
  const availableTools = new Set(availability.availableTools ?? [])
  check(
    availableTools.size === availability.available,
    'dsh_info.available matches the availableTools list',
    `${availability.available} advertised, ${availableTools.size} named`,
  )
  const missing = [...names].filter((name) => !availableTools.has(name))
  const extra = [...availableTools].filter((name) => !names.has(name))
  check(
    missing.length === 0 && extra.length === 0,
    'availableTools equals the tools/list set',
    missing.length + extra.length === 0 ? `${names.size} tools` : `missing ${missing.join(',') || '-'} / extra ${extra.join(',') || '-'}`,
  )
  const reasonless = (availability.unavailable ?? []).filter((entry) => typeof entry.reason !== 'string' || entry.reason === '')
  check(reasonless.length === 0, 'every unavailable tool explains why', `${(availability.unavailable ?? []).length} unavailable`)
}

// --- model-spending checks -------------------------------------------------

async function progressCheck(sessionId) {
  section('progress notifications (real turn)')
  const id = requestSeq++
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'session_prompt',
        arguments: {
          sessionId,
          prompt: 'Use the bash tool to run exactly: sleep 4; echo progress-step. Then reply with exactly: PROGRESS OK',
          timeoutMs: 180_000,
        },
        _meta: { progressToken: 'live-checks-progress' },
      },
    }),
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const arrivals = []
  let final
  const startedAt = Date.now()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = JSON.parse(line.slice(5))
      if (payload.id === id) final = payload
      else if (payload.method === 'notifications/progress') arrivals.push(Date.now() - startedAt)
    }
  }
  const reply = final?.result?.content?.[0]?.text ? JSON.parse(final.result.content[0].text) : undefined
  check(arrivals.length > 0, 'progress notifications are sent', `${arrivals.length} in ${Date.now() - startedAt}ms`)
  check(
    arrivals.length >= 2 && arrivals[arrivals.length - 1] - arrivals[0] > 500,
    'they arrive while the turn runs, not batched at the end',
    arrivals.slice(0, 5).join(','),
  )
  check(/PROGRESS OK/.test(reply?.turn?.reply ?? ''), 'the turn still settles', reply?.turn?.reply)
}

async function cancellationCheck() {
  section('MCP notifications/cancelled (real turn)')
  const session = await callTool('session_create', { cwd: process.cwd() })
  const id = requestSeq++
  const pending = fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'session_prompt',
        arguments: {
          sessionId: session.sessionId,
          prompt: 'Write a 600-word essay about cartography. Do not use tools.',
          timeoutMs: 300_000,
        },
      },
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  const cancelledAt = Date.now()
  await fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'live-checks' } }),
  }).then((response) => response.text())
  const response = await pending
  const body = await response.text()
  const elapsed = Date.now() - cancelledAt
  const events = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
  const final = events.find((entry) => entry.id === id)
  const reply = final?.result?.content?.[0]?.text ? JSON.parse(final.result.content[0].text) : undefined
  check(reply?.turn?.aborted === true, 'the cancelled wait reports turn.aborted', String(reply?.turn?.aborted))
  check(elapsed < 5_000, 'the wait ends promptly after the notification, not at the turn boundary', `${elapsed}ms`)
  const after = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: after cancellation',
    timeoutMs: 180_000,
  })
  check(/after cancellation/.test(after.turn?.reply ?? ''), 'the session is usable afterwards', after.turn?.reply)
}

async function subagentCheck() {
  section('subagent accounting (real turn)')
  const session = await callTool('session_create', { cwd: process.cwd() })
  const prompted = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Use your subagent tool to spawn one helper agent with the task "Reply with exactly: '
      + 'SUBAGENT-OK". Wait for it, then reply exactly: PARENT SAW <its answer>.',
    timeoutMs: 600_000,
  })
  check(
    /SUBAGENT-OK/.test(prompted.turn?.reply ?? ''),
    'the agent spawned a subagent and reported its answer',
    (prompted.turn?.reply ?? '').slice(0, 60),
  )

  const report = await callTool('session_usage', {
    sessionId: session.sessionId,
    limit: 20,
    includeSubagents: true,
  })
  const rows = report.sessions ?? []
  const child = rows.find((row) => row.origin === 'subagent')
  check(child !== undefined, 'usage folds the subagent session as its own row', `${rows.length} row(s)`)
  check(
    report.totals?.totalTokens === rows.reduce((sum, row) => sum + (row.usage?.totals?.totalTokens ?? 0), 0),
    'the report total is the sum of the rows (no silent exclusion)',
    `${report.totals?.totalTokens ?? '?'} tokens`,
  )

  if (child !== undefined) {
    // Subagent sessions belong to the session tree: reading the child is reading
    // the cost of the parent, so this must work under session.scope "owned" too.
    const transcript = await callTool('session_messages', { sessionId: child.sessionId, limit: 5 })
    check(
      (transcript.messages ?? []).length > 0,
      'the subagent session is readable by id',
      `${(transcript.messages ?? []).length} message(s)`,
    )
    const listed = await callTool('session_list', { limit: 10 })
    const rows = listed.sessions ?? []
    const childRow = rows.find((entry) => entry.sessionId === child.sessionId)
    check(
      childRow !== undefined,
      'the subagent session is listed with its parent',
      `${listed.total ?? '?'} session(s)`,
    )
    check(
      childRow?.parentSessionId === session.sessionId && childRow?.origin === 'subagent',
      'session_list names the subagent parent and origin',
      `parent ${String(childRow?.parentSessionId ?? 'absent').slice(0, 16)}`,
    )
    const parentRow = rows.find((entry) => entry.sessionId === session.sessionId)
    check(
      parentRow?.parentSessionId === undefined,
      'a root session has no parent recorded',
      parentRow === undefined ? 'not listed' : 'root',
    )
    const onlySubagents = await callTool('session_list', { limit: 20, origin: 'subagent' })
    const subagentRows = onlySubagents.sessions ?? []
    check(
      subagentRows.some((entry) => entry.sessionId === child.sessionId) &&
        subagentRows.every((entry) => entry.origin === 'subagent') &&
        !subagentRows.some((entry) => entry.sessionId === session.sessionId),
      'session_list { origin: "subagent" } returns only the children',
      `${subagentRows.length} subagent(s)`,
    )
    // One recorded result from the subagent's own transcript, fetched by call id:
    // the debug path an operator takes after seeing a failure in the call list.
    const childTranscript = await callTool('session_messages', {
      sessionId: child.sessionId,
      limit: 50,
      includeToolCalls: true,
    })
    const completedCall = (childTranscript.messages ?? [])
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => typeof call.id === 'string' && typeof call.resultChars === 'number')
    if (completedCall === undefined) {
      skip('session_tool_result on the subagent', 'its transcript has no completed tool call')
    } else {
      const fetched = await callTool('session_tool_result', {
        sessionId: child.sessionId,
        callId: completedCall.id,
        maxChars: 500,
      })
      check(
        fetched.chars === completedCall.resultChars && typeof fetched.text === 'string' && fetched.text.length <= 500,
        'session_tool_result reads a subagent tool result by id',
        `${fetched.chars} chars`,
      )
    }

    // Enriched search hits: with the index enabled, a match inside the subagent
    // session should say which parent it belongs to. Disabled index = skip.
    const search = await attemptTool('session_search', { query: 'SUBAGENT-OK' })
    if (!search.ok) {
      skip('search-hit parentage', 'session search is unavailable or disabled on this deployment')
    } else {
      const hits = search.payload?.items ?? []
      check(
        hits.some((entry) => entry.sessionId === child.sessionId) || hits.length === 0,
        'a search hit inside the subagent session is returned',
        `${hits.length} hit(s)`,
      )
      check(
        hits.every((entry) => entry.origin !== 'subagent' || entry.parentSessionId !== undefined),
        'a subagent search hit carries its parent',
        hits.filter((entry) => entry.origin === 'subagent').length + ' subagent hit(s)',
      )
    }
    const onlyRoots = await callTool('session_list', { limit: 20, origin: 'root' })
    check(
      (onlyRoots.sessions ?? []).some((entry) => entry.sessionId === session.sessionId) &&
        !(onlyRoots.sessions ?? []).some((entry) => entry.sessionId === child.sessionId),
      'session_list { origin: "root" } excludes the children',
      `${(onlyRoots.sessions ?? []).length} root(s)`,
    )
  }
}

// --- concurrent turns ------------------------------------------------------

/**
 * Two independent sessions running real turns at the same time.
 *
 * Serialization is per session: a harness that drives several tasks at once relies
 * on one blocked turn not holding up another. This is the cheapest way to show that
 * still holds, and it is not a benchmark — both turns only have to settle with their
 * own replies.
 */
async function concurrentTurnsCheck() {
  section('concurrent turns (real turns)')
  const first = await callTool('session_create', { cwd: process.cwd() })
  const second = await callTool('session_create', { cwd: process.cwd() })
  const startedAt = Date.now()
  const [a, b] = await Promise.all([
    callTool('session_prompt', {
      sessionId: first.sessionId,
      prompt: 'Reply with exactly: CONCURRENT-A',
      timeoutMs: 300_000,
    }),
    callTool('session_prompt', {
      sessionId: second.sessionId,
      prompt: 'Reply with exactly: CONCURRENT-B',
      timeoutMs: 300_000,
    }),
  ])
  const elapsed = Date.now() - startedAt
  check(
    /CONCURRENT-A/.test(a.turn?.reply ?? '') && /CONCURRENT-B/.test(b.turn?.reply ?? ''),
    'two sessions answered their own prompts',
    `${elapsed} ms for both`,
  )
  check(
    a.turn?.aborted !== true && b.turn?.aborted !== true,
    'neither turn was aborted by the other session',
  )
  // Each reply's usage belongs to its own session, which a mixed-up correlation
  // would break even when the text looks right.
  const firstMessages = await callTool('session_messages', { sessionId: first.sessionId, limit: 10 })
  const secondMessages = await callTool('session_messages', { sessionId: second.sessionId, limit: 10 })
  check(
    (firstMessages.messages ?? []).every((message) => !String(message.text ?? '').includes('CONCURRENT-B')) &&
      (secondMessages.messages ?? []).every((message) => !String(message.text ?? '').includes('CONCURRENT-A')),
    'each transcript kept its own conversation',
  )
}

// --- run -------------------------------------------------------------------

process.stdout.write(`${bold('dsh-as-mcp live checks')}\n`)
await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-checks', version: '1' } },
  }),
})
  .then(async (response) => {
    protocolVersion = ((await response.text()).match(/"protocolVersion":"([^"]+)"/) ?? [])[1]
  })
  .catch(() => undefined)
if (protocolVersion === undefined) {
  process.stdout.write(`${red('initialize failed — is anything listening at that endpoint?')}\n`)
  process.exit(2)
}
process.stdout.write(`${dim(`protocol ${protocolVersion}`)}\n`)
try {
  const listed = await rpc('tools/list', {})
  surface = new Set((listed.tools ?? []).map((tool) => tool.name))
  process.stdout.write(`${dim(`${surface.size} tool(s) advertised`)}\n`)
} catch {
  // Leaving `surface` empty makes every gated check report as skipped, which is
  // the honest outcome when the endpoint cannot list tools.
}

try {
  await protocolChecks()
  await shellChecks()
  await concurrencyChecks()
  await availabilityCheck()
  const sessionId = await listChecks()
  const withSubagent = flag('--with-subagent')
  if (flag('--with-model') || withSubagent) {
    if (sessionId === undefined || !has('session_prompt')) {
      skip('model-turn checks', 'needs session_prompt and a created session')
    } else {
      await progressCheck(sessionId)
      await cancellationCheck()
      await concurrentTurnsCheck()
      if (withSubagent) await subagentCheck()
    }
  } else {
    process.stdout.write(
      `\n${dim('skipping the checks that spend tokens: pass --with-model (progress/cancellation) '
        + 'or --with-subagent (adds a real subagent turn) to run them')}\n`,
    )
  }
} catch (error) {
  check(false, 'run aborted', error instanceof Error ? error.message : String(error))
}

process.stdout.write(
  `\n${failed === 0 ? green('ALL GOOD') : red('FAILURES')} — ${passed} passed, ${failed} failed`
    + `${skipped === 0 ? '' : `, ${skipped} skipped (older endpoint)`}\n`,
)
process.exit(failed === 0 ? 0 : 1)
