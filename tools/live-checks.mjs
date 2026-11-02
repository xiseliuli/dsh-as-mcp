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
import { existsSync } from 'node:fs'
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
function check(ok, label, detail) {
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
  // The harness requires a directory: there is no "some default workspace" form.
  const created = await callTool('session_create', { cwd: process.cwd() })
  const sessionId = created.sessionId
  const page = await callTool('session_list', { limit: 1 })
  check(
    page.sessions?.length <= 1 && typeof page.total === 'number' && (page.truncated === true) === (page.total > 1),
    'session_list reports total and truncation',
    `${page.sessions?.length ?? 0} of ${page.total ?? '?'}`,
  )

  const path = join('/tmp', `dsh-as-mcp-live-checks-${process.pid}.txt`)
  await callTool('file_write', { path, content: 'first line\nsecond line\nthird line\n' })
  const sliced = await callTool('file_read', { path, maxBytes: 11 })
  check(
    sliced.truncated === true && typeof sliced.nextOffset === 'number' && sliced.size === 34,
    'file_read reports truncated, nextOffset and the whole size',
    `${sliced.bytes ?? '?'}/${sliced.size ?? '?'} bytes, next ${sliced.nextOffset ?? '?'}`,
  )

  // Search is opt-in in shipped compositions, so both answers are legitimate: the
  // match list (a fresh token appears nowhere, so it must be empty) or the
  // disabled-index explanation naming the configuration to change.
  const freshToken = randomUUID().replace(/-/g, '')
  const search = await attemptTool('session_search', { query: freshToken })
  if (search.ok) {
    check(
      (search.payload?.items ?? []).length === 0 && typeof search.payload?.hasMore === 'boolean',
      'session_search answers a token that appears nowhere with no matches',
      `${(search.payload?.items ?? []).length} match(es)`,
    )
  } else {
    check(
      /openAt/.test(search.error ?? '') && /first-search|startup/.test(search.error ?? ''),
      'a disabled session-search index reports how to enable it',
      (search.error ?? '').slice(0, 60),
    )
  }

  const usage = await callTool('session_usage', { cwd: '/tmp/definitely-no-sessions-here' })
  check(
    usage.scope === 'workspace' && (usage.sessions ?? []).length === 0 && (usage.notes ?? []).some((note) => /No session this DSH knows ran in/.test(note)),
    'an empty workspace total is explained, not silently zero',
    usage.scope,
  )
  return sessionId
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
  await protocolChecks()
  await shellChecks()
  const sessionId = await listChecks()
  if (flag('--with-model')) {
    await progressCheck(sessionId)
    await cancellationCheck()
  } else {
    process.stdout.write(`\n${dim('skipping the checks that spend tokens: pass --with-model to run them')}\n`)
  }
} catch (error) {
  check(false, 'run aborted', error instanceof Error ? error.message : String(error))
}

process.stdout.write(`\n${failed === 0 ? green('ALL GOOD') : red('FAILURES')} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
