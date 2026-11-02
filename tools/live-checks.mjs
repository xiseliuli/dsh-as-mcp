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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
const mountedOnly = process.argv.includes('--mounted-only')
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

/**
 * A second MCP client on the same endpoint, with its own initialize and request ids.
 *
 * The queue lives on the session, not on a connection, so a message one client queued
 * must be visible to and withdrawable by another. This models "the message came from a
 * different client" without needing the DSH UI's own client.
 */
function secondaryClient(url = endpoint) {
  let sequence = 50_000
  let initialized = false
  const exchange = async (method, params) => {
    const id = sequence++
    const response = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    const body = await response.text()
    const events = body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
    const payload = events.find((entry) => entry.id === id) ?? events[0]
    if (payload?.error) throw new Error(`secondary JSON-RPC ${payload.error.code}: ${payload.error.message}`)
    return payload?.result
  }
  return {
    async listTools() {
      if (!initialized) {
        await exchange('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'live-checks-secondary', version: '1' },
        })
        initialized = true
      }
      const result = await exchange('tools/list', {})
      return (result?.tools ?? []).map((tool) => tool.name)
    },
    async callTool(name, args = {}) {
      if (!initialized) {
        await exchange('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'live-checks-secondary', version: '1' },
        })
        initialized = true
      }
      const result = await exchange('tools/call', { name, arguments: args })
      const text = result?.content?.[0]?.text ?? ''
      if (result?.isError === true) throw new Error(`${name}: ${text}`)
      return JSON.parse(text)
    },
  }
}

async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result?.content?.[0]?.text ?? ''
  if (result?.isError === true) throw new Error(`${name}: ${text}`)
  return JSON.parse(text)
}

/**
 * Wait until a session reports a running turn.
 *
 * Several checks must act *while* a turn is open (cancel it, steer into it, switch its
 * model). A fixed sleep guesses how long the harness takes to start one; this polls the
 * listing's `running` filter instead and returns as soon as the turn appears. It returns
 * false when the session never shows up running — the caller proceeds, and its assertion
 * reports what it actually observed instead of blaming a timeout.
 */
async function waitUntilRunning(sessionId, timeoutMs = 20_000) {
  if (!has('session_list')) return false
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const listed = await callTool('session_list', { running: true, limit: 50 })
      if ((listed.sessions ?? []).some((row) => row.sessionId === sessionId)) return true
    } catch {
      // the listing can be briefly unavailable; the next poll decides
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
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
  const killed = await callTool('shell_kill', { jobId: running.jobId, waitMs: 2_000 })
  check(
    killed.killed === true && killed.status === 'killed',
    'shell_kill { waitMs } stops it and waits for the job to settle',
    killed.status,
  )
  const afterKill = await callTool('shell_list', { running: true })
  check(
    !(afterKill.jobs ?? []).some((job) => job.jobId === running.jobId),
    'the settled job leaves the running filter',
    `${(afterKill.jobs ?? []).length} running`,
  )

  // Two views of one job: a row in the `running` filter must also report
  // `done: false` from shell_output, and killing it must flip that.
  if (has('shell_output')) {
    const probe = await callTool('shell_start', { command: 'sleep 15' })
    try {
      const live = await callTool('shell_output', { jobId: probe.jobId })
      const filtered = await callTool('shell_list', { running: true })
      check(
        (filtered.jobs ?? []).some((job) => job.jobId === probe.jobId) && live.done === false,
        'a job in the running filter reports done:false from shell_output',
        `done ${String(live.done)}`,
      )
      await callTool('shell_kill', { jobId: probe.jobId })
      const settled = await callTool('shell_output', { jobId: probe.jobId })
      check(settled.done === true, 'after shell_kill the output reports done', String(settled.done))
    } finally {
      await callTool('shell_kill', { jobId: probe.jobId }).catch(() => {})
    }
  }

  // The retention claim: a job that writes faster than it is polled loses the
  // oldest bytes beyond the retained buffer and says so. 200 KiB written at once
  // must not come back whole, and must not come back unboundedly either.
  if (has('shell_output')) {
    const loud = await callTool('shell_start', {
      command: `node -e "process.stdout.write('x'.repeat(200000))"`,
    })
    let delivered = 0
    let pages = 0
    let sawTruncated = false
    let sawLossy = false
    let last
    for (let attempt = 0; attempt < 20; attempt += 1) {
      last = await callTool('shell_output', { jobId: loud.jobId })
      pages += 1
      delivered += Buffer.byteLength(last.output ?? '', 'utf8')
      if (last.truncated === true) sawTruncated = true
      if (last.lossy === true) sawLossy = true
      if (last.done === true && (last.pendingBytes ?? 0) === 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // The shell service's own retention dropped part of the 200 KiB before this
    // plugin ever saw it, so `lossy` must say so — the probe that found this bug
    // showed `truncated: true, lossy: false` for exactly this case.
    check(
      sawTruncated && sawLossy && delivered <= 128 * 1024 && last?.done === true,
      'a job that outruns polling is bounded and reports truncated + lossy',
      `${delivered} bytes in ${pages} page(s)`,
    )
    await callTool('shell_kill', { jobId: loud.jobId }).catch(() => {})
  }
}

// --- info coherence --------------------------------------------------------

/**
 * `dsh_info` is what a caller plans against, so its claims must agree with the
 * surface it is describing: the version is the installed build, the advertised tool
 * count matches the tools actually served, the availability list names real tools,
 * and the effective settings are echoed as booleans/values rather than prose.
 */
async function infoCoherenceChecks() {
  section('info coherence')
  const info = await callTool('dsh_info')
  const repoVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  check(
    info.version === repoVersion,
    'dsh_info reports the built version this checkout produces',
    `${info.version} (repo ${repoVersion})`,
  )
  if (mountedOnly) {
    // Served by DSH's web server with the plugin listener disabled: the URL the caller
    // reached is not one the plugin owns, so `endpoint` must say where it actually lives
    // instead of echoing the URL back.
    check(
      info.listening === false && info.listenError === null && info.mountedOnDshWebServer === true,
      'a mounted-only endpoint reports no listener and the web-server mount',
      `listening ${String(info.listening)}, mounted ${String(info.mountedOnDshWebServer)}`,
    )
    check(
      typeof info.endpoint === 'string' && info.endpoint.startsWith('/') && /web server/.test(info.endpoint),
      'a mounted-only endpoint says where it lives instead of printing a URL',
      String(info.endpoint).slice(0, 70),
    )
  } else {
    check(
      typeof info.endpoint === 'string' && info.endpoint.replace(/\/+$/, '') === endpoint.replace(/\/+$/, ''),
      'dsh_info echoes the endpoint the caller reached',
      info.endpoint,
    )
    check(info.listening === true && info.listenError === null, 'dsh_info health says the listener is up')
  }
  // The endpoint string must mean what it looks like: a dialable URL while the listener
  // is up, and explicitly not a URL when the endpoint is served elsewhere (mounted-only
  // deployments report an explanation rather than an unreachable address).
  check(
    info.listening === false
      ? !/^https?:\/\//.test(String(info.endpoint))
      : /^https?:\/\/[^/\s]+/.test(String(info.endpoint)),
    'the reported endpoint is a URL exactly when there is a listener to dial',
    String(info.endpoint).slice(0, 70),
  )

  const availability = info.toolAvailability ?? {}
  const availableTools = availability.availableTools ?? []
  check(
    availability.available === surface.size && availableTools.length === surface.size &&
      availableTools.every((name) => surface.has(name)) &&
      [...surface].every((name) => availableTools.includes(name)),
    'toolAvailability agrees with the tools actually advertised',
    `${availability.available ?? '?'} vs ${surface.size}`,
  )
  check(
    (availability.unavailable ?? []).every((entry) => typeof entry.tool === 'string' && typeof entry.reason === 'string'),
    'every unavailable tool comes with a reason',
    `${(availability.unavailable ?? []).length} unavailable`,
  )

  const groups = info.enabledToolGroups ?? {}
  check(
    Object.values(groups).every((value) => typeof value === 'boolean') &&
      ['workspace', 'session', 'files', 'shell', 'agentTools', 'usage'].every((group) => group in groups),
    'enabledToolGroups names every group as a boolean',
    Object.keys(groups).join(','),
  )

  const services = info.harnessServices ?? {}
  check(
    Object.values(services).every((value) => typeof value === 'boolean') && services['sessionController'] === true,
    'harnessServices is a boolean map and this profile reaches the session controller',
    Object.keys(services).length + ' service(s)',
  )

  check(
    typeof info.health?.node === 'string' && info.health.node.startsWith('v') &&
      typeof info.health?.rssMb === 'number' && info.health.rssMb > 0,
    'health reports the runtime and a live memory figure',
    `${info.health?.node ?? '?'}, ${info.health?.rssMb ?? '?'} MB rss`,
  )
  check(
    info.config?.session?.scope === 'all' || info.config?.session?.scope === 'owned',
    'the effective session scope is echoed',
    info.config?.session?.scope,
  )
  check(
    Array.isArray(info.notes) && info.notes.length > 0 && info.notes.every((note) => typeof note === 'string'),
    'dsh_info carries its caveats as notes',
    `${info.notes?.length ?? 0} note(s)`,
  )

  // The catalog is what session_create's arguments are chosen from, so its honesty
  // matters: a value the caller cannot read must be named in catalog.unavailable,
  // not silently missing.
  const catalog = await callTool('dsh_info', { includeModels: true }).then((full) => full.catalog ?? {})
  const providers = Array.isArray(catalog.providers) ? catalog.providers : []
  const providerIds = new Set(providers.map((provider) => provider.id))
  check(
    providers.every((provider) => typeof provider.id === 'string' && typeof provider.name === 'string'),
    'catalog.providers names every route session_create accepts',
    `${providers.length} route(s)`,
  )
  if (catalog.providerModels !== undefined) {
    check(
      Array.isArray(catalog.providerModels) &&
        catalog.providerModels.every((entry) => typeof entry.provider === 'string' &&
          Array.isArray(entry.models) &&
          entry.models.every((model) => typeof model.id === 'string' && typeof model.name === 'string')),
      'catalog.providerModels is a per-route model list',
      `${catalog.providerModels.length} route(s) with models`,
    )
    check(
      catalog.providerModels.every((entry) => providerIds.has(entry.provider)),
      'every model entry belongs to a named route',
    )
  } else {
    check(
      (catalog.unavailable ?? []).some((reason) => typeof reason === 'string' && reason.startsWith('providerModels')),
      'a missing model catalog is named in catalog.unavailable',
      `${(catalog.unavailable ?? []).length} unavailable entr(ies)`,
    )
  }
  if (catalog.agentPresets !== undefined) {
    const presets = catalog.agentPresets
    // `name`/`description` are optional in the catalog (a registry may expose ids
    // only); the id and the default pointing at a listed id are the contract.
    check(
      Array.isArray(presets) && presets.every((preset) => typeof preset.id === 'string' &&
        (preset.name === undefined || typeof preset.name === 'string')) &&
        (catalog.defaultAgentPreset === undefined || presets.some((preset) => preset.id === catalog.defaultAgentPreset)),
      'agentPresets lists preset ids and the default names one of them',
      `${presets.length} preset(s)`,
    )
  }
}

// --- shell timeout and job cap ---------------------------------------------

/**
 * `shell_run`'s timeout is a dead process, not just an early return, and the
 * background table keeps its documented bounds: the oldest *finished* job is evicted
 * to make room, while starting one more than the cap of running jobs is refused
 * rather than killing someone else's process.
 */
async function shellLimitsChecks() {
  section('shell timeout and job cap')
  if (!has('shell_run') || !has('shell_start')) {
    skip('shell timeout and job cap', 'needs shell_run and shell_start')
    return
  }
  // The command sleeps 15 s while the deadline is 0.7 s: returning before 8 s proves the
  // deadline cut the wait (the full sleep would blow past it), while 8 s leaves a slow
  // machine plenty of slack. The long sleep costs nothing — the call returns at the deadline.
  const startedAt = Date.now()
  const timedOut = await attemptTool('shell_run', { command: 'sleep 15', timeoutMs: 700 })
  const elapsed = Date.now() - startedAt
  check(
    timedOut.ok === true ? timedOut.payload?.timedOut === true && elapsed < 8_000 : /timedOut|timeout/i.test(timedOut.error ?? ''),
    'shell_run returns at its deadline with timedOut set',
    `${elapsed} ms`,
  )
  const quick = await attemptTool('shell_run', { command: 'printf hello' })
  check(
    quick.ok === true && quick.payload?.stdout === 'hello' && quick.payload?.timedOut === false,
    'a quick command returns its output and timedOut:false',
    JSON.stringify(quick.payload?.stdout),
  )

  if (!has('shell_list') || !has('shell_kill')) {
    skip('background job caps', 'needs shell_list and shell_kill')
    return
  }
  // 16 finished jobs fill the table; the 17th start must evict the oldest finished
  // one instead of refusing.
  const finished = []
  for (let index = 0; index < 16; index += 1) {
    finished.push(await callTool('shell_start', { command: 'true' }))
  }
  const overflow = await callTool('shell_start', { command: 'sleep 5' })
  const listed = await callTool('shell_list')
  const jobs = listed.jobs ?? []
  check(
    jobs.length <= 16 && jobs.some((job) => job.jobId === overflow.jobId) &&
      !jobs.some((job) => job.jobId === finished[0].jobId),
    'the oldest finished job is evicted to make room, and the new job starts',
    `${jobs.length} job(s)`,
  )
  await callTool('shell_kill', { jobId: overflow.jobId })

  // With 16 *running* jobs, one more is refused instead of silently stopping one.
  const running = []
  try {
    for (let index = 0; index < 16; index += 1) {
      running.push(await callTool('shell_start', { command: 'sleep 15' }))
    }
    const refused = await attemptTool('shell_start', { command: 'sleep 15' })
    check(
      refused.ok === false && /16 background jobs are already running/.test(refused.error ?? '') &&
        /does not silently stop/.test(refused.error ?? ''),
      'a 17th running job is refused, not silently evicted',
      refused.error?.slice(0, 60),
    )
  } finally {
    await Promise.all(running.map((job) => callTool('shell_kill', { jobId: job.jobId }).catch(() => {})))
  }
}

// --- relative paths --------------------------------------------------------

/**
 * Every file tool takes a `cwd` for relative paths; the resolution should be shared, so
 * a relative write is readable and listable through the same base, and a missing relative
 * path says which path it resolved to.
 */
async function relativePathChecks() {
  section('relative path resolution')
  if (!has('file_write') || !has('file_read') || !has('file_list')) {
    skip('relative path resolution', 'needs file_write, file_read and file_list')
    return
  }
  const dir = join('/tmp', `dsh-as-mcp-live-rel-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  try {
    await callTool('file_write', { path: 'nested/rel.txt', content: 'relative', cwd: dir })
    check(
      (await callTool('file_read', { path: 'nested/rel.txt', cwd: dir })).text === 'relative',
      'file_write and file_read resolve a relative path against cwd',
    )
    const listed = await callTool('file_list', { path: '.', cwd: dir })
    check(
      (listed.entries ?? []).some((entry) => entry.name === 'nested'),
      'file_list { path: ".", cwd } lists that directory',
      `${(listed.entries ?? []).length} entr(ies)`,
    )
    const missing = await attemptTool('file_read', { path: 'nested/missing.txt', cwd: dir })
    check(
      missing.ok === false && /missing\.txt/.test(missing.error ?? ''),
      'a missing relative path names the resolved file in its error',
      missing.error?.slice(0, 70),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- listing and image limits ----------------------------------------------

/**
 * `file_list`'s walk bounds and `file_read_image`'s detection and cap. Cheap: a temp
 * tree, a 1x1 PNG written through the shell, a text file and a sparse 9 MiB file.
 */
async function listingImageChecks() {
  section('listing and image limits')
  if (!has('file_list')) {
    skip('listing and image limits', 'this endpoint advertises no file_list')
  } else {
    const root = join('/tmp', `dsh-as-mcp-live-tree-${process.pid}`)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
    writeFileSync(join(root, 'top.txt'), 'top')
    writeFileSync(join(root, 'sub', 'inner.txt'), 'inner')
    writeFileSync(join(root, 'sub', 'deep', 'deeper.txt'), 'deeper')
    try {
      const flat = await callTool('file_list', { path: root })
      // A non-recursive listing names entries by basename; recursive entries add a
      // relative `path` (and `depth`).
      const flatNames = (flat.entries ?? []).map((entry) => entry.name)
      check(
        flatNames.includes('top.txt') && flatNames.includes('sub') && !flatNames.includes('inner.txt'),
        'a non-recursive listing shows one level with relative paths',
        `${flat.entries?.length ?? 0} entr(ies)`,
      )
      const recursive = await callTool('file_list', { path: root, recursive: true })
      check(
        (recursive.entries ?? []).some((entry) => entry.path.endsWith('deep/deeper.txt')),
        'a recursive listing reaches nested files',
        `${recursive.entries?.length ?? 0} entr(ies)`,
      )
      const shallow = await callTool('file_list', { path: root, recursive: true, maxDepth: 1 })
      check(
        !(shallow.entries ?? []).some((entry) => String(entry.path ?? '').endsWith('deeper.txt')),
        'maxDepth bounds the recursive walk',
        `${shallow.entries?.length ?? 0} entr(ies)`,
      )
      const onFile = await attemptTool('file_list', { path: join(root, 'top.txt') })
      check(onFile.ok === false && /director/i.test(onFile.error ?? ''), 'listing a file is a legible error', onFile.error?.slice(0, 50))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  if (!has('file_read_image') || !has('shell_run')) {
    skip('image detection and cap', 'needs file_read_image and shell_run')
    return
  }
  const png = join('/tmp', `dsh-as-mcp-live-1x1-${process.pid}.png`)
  const big = join('/tmp', `dsh-as-mcp-live-big-${process.pid}`)
  const text = join('/tmp', `dsh-as-mcp-live-text-${process.pid}.txt`)
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  try {
    await callTool('shell_run', {
      command: `node -e "require('node:fs').writeFileSync('${png}', Buffer.from('${pngBase64}','base64'))"`,
    })
    writeFileSync(text, 'plain text')

    const result = await rpc('tools/call', { name: 'file_read_image', arguments: { path: png } })
    // The reply is a metadata text block followed by the image block, which is what
    // lets a client show the picture while still knowing its size in bytes.
    const meta = JSON.parse(result?.content?.[0]?.text ?? '{}')
    const block = result?.content?.[1]
    check(
      result?.isError !== true && meta.mimeType === 'image/png' && block?.type === 'image' &&
        block?.mimeType === 'image/png' && typeof block?.data === 'string' && block.data.length > 0,
      'a real PNG comes back as metadata plus an MCP image block',
      `${meta.mimeType ?? '?'}, ${block?.data?.length ?? 0} base64 chars`,
    )
    // Detection is by magic bytes, so the other three supported formats need only a
    // header to be classified (the harness hands back the bytes; it need not decode).
    const gif = join('/tmp', `dsh-as-mcp-live-gif-${process.pid}.gif`)
    const webp = join('/tmp', `dsh-as-mcp-live-webp-${process.pid}.webp`)
    const bmp = join('/tmp', `dsh-as-mcp-live-bmp-${process.pid}.bmp`)
    try {
      writeFileSync(gif, Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;', 'latin1'))
      writeFileSync(webp, Buffer.from('RIFF\u001a\u0000\u0000\u0000WEBPVP8 \u0000\u0000\u0000\u0000', 'latin1'))
      writeFileSync(bmp, Buffer.from('BM\u0000\u0000\u0000\u0000', 'latin1'))
      for (const [path, mime] of [[gif, 'image/gif'], [webp, 'image/webp']]) {
        const outcome = await attemptTool('file_read_image', { path })
        check(
          outcome.ok === true && outcome.payload?.mimeType === mime,
          `a ${mime.split('/')[1].toUpperCase()} header is detected as ${mime}`,
          outcome.ok ? String(outcome.payload?.mimeType) : outcome.error?.slice(0, 50),
        )
      }
      // BMP is readable, but a *prompt* cannot carry it — the two lists differ on
      // purpose (a model attachment has its own accepted formats).
      const bmpRead = await attemptTool('file_read_image', { path: bmp })
      check(
        bmpRead.ok === true && bmpRead.payload?.mimeType === 'image/bmp',
        'a BMP header is detected as image/bmp (readable, unlike a prompt attachment)',
        bmpRead.ok ? String(bmpRead.payload?.mimeType) : bmpRead.error?.slice(0, 50),
      )
      if (has('session_create') && has('session_prompt')) {
        const session = await callTool('session_create', { cwd: process.cwd() })
        const attached = await attemptTool('session_prompt', {
          sessionId: session.sessionId,
          prompt: 'look at this',
          images: [{ path: bmp }],
          wait: false,
        })
        check(
          attached.ok === false && /cannot carry/.test(attached.error ?? '') &&
            /png, jpeg, webp, gif/i.test(attached.error ?? ''),
          'a BMP attached to a prompt is refused with the accepted formats named',
          attached.error?.slice(0, 90),
        )
      }
    } finally {
      for (const path of [gif, webp, bmp]) rmSync(path, { force: true })
    }

    const notImage = await attemptTool('file_read_image', { path: text })
    check(
      notImage.ok === false && /not an image/.test(notImage.error ?? ''),
      'a text file is refused as not an image',
      notImage.error?.slice(0, 50),
    )
    const missing = await attemptTool('file_read_image', { path: `${text}.missing` })
    check(
      missing.ok === false && /does not exist/.test(missing.error ?? ''),
      'a missing image path is a legible error',
      missing.error?.slice(0, 50),
    )

    await callTool('shell_run', {
      command: `node -e "require('node:fs').writeFileSync('${big}', Buffer.alloc(9*1024*1024, 0x89))"`,
    })
    const tooLarge = await attemptTool('file_read_image', { path: big })
    check(
      tooLarge.ok === false && /8388608-byte cap/.test(tooLarge.error ?? ''),
      'an image over the 8 MiB cap is refused with the limit named',
      tooLarge.error?.slice(0, 60),
    )
  } finally {
    for (const path of [png, big, text]) rmSync(path, { force: true })
  }
}

// --- file paging contracts -------------------------------------------------

/**
 * `file_read`'s paging promise: a byte-capped read reports `truncated` and
 * `nextOffset`, the next window continues exactly, and a window that starts inside a
 * multi-byte character decodes it as U+FFFD instead of failing or shifting the rest.
 */
async function filePagingChecks() {
  section('file paging contracts')
  if (!has('file_read') || !has('file_write')) {
    skip('file paging contracts', 'needs file_read and file_write')
    return
  }
  const path = join('/tmp', `dsh-as-mcp-live-paging-${process.pid}.txt`)
  const head = 'a'.repeat(5_000)
  const euro = '€'
  const tail = 'b'.repeat(5_000)
  try {
    await callTool('file_write', { path, content: head + euro + tail })

    const first = await callTool('file_read', { path, maxBytes: 5_000 })
    check(
      first.truncated === true && first.bytes === 5_000 && first.nextOffset === 5_000 &&
        first.text === head,
      'a byte-capped read reports truncated, bytes and nextOffset',
      `${first.bytes} bytes, next ${first.nextOffset}`,
    )

    const second = await callTool('file_read', { path, offset: first.nextOffset, maxBytes: 6_000 })
    check(
      second.truncated === false && second.offset === 5_000 &&
        second.text === euro + tail && first.text + second.text === head + euro + tail,
      'the next window continues exactly and completes the file',
      `${second.bytes} bytes, truncated ${second.truncated}`,
    )

    // 5000 bytes of 'a' then a 3-byte euro: offset 5001 leaves the euro's last two
    // bytes orphaned, which decode as two replacement characters. The point is that
    // the remainder after them is still aligned with the file.
    // An offset at or past EOF is an empty, complete read, not an error: a paging
    // loop that starts from "past the end" should stop rather than crash.
    // Offsets are BYTES: '€' is one character but three bytes, so use byteLength.
    const eofOffset = Buffer.byteLength(head + euro + tail, 'utf8')
    const atEnd = await callTool('file_read', { path, offset: eofOffset })
    check(
      atEnd.text === '' && atEnd.truncated === false && atEnd.nextOffset === undefined,
      'an offset at EOF is an empty complete read',
      `${atEnd.bytes ?? '?'} bytes`,
    )
    const pastEnd = await attemptTool('file_read', { path, offset: 10_000_000 })
    check(
      pastEnd.ok === true && pastEnd.payload?.text === '',
      'an offset past EOF is empty rather than an error',
      pastEnd.ok ? '' : pastEnd.error?.slice(0, 60),
    )

    const split = await callTool('file_read', { path, offset: 5_001, maxBytes: 100 })
    const replacements = /^\uFFFD*/.exec(split.text)?.[0].length ?? 0
    check(
      replacements === 2 && split.text.slice(replacements) === tail.slice(0, split.text.length - replacements),
      'a window starting inside a multi-byte character decodes U+FFFD per orphaned byte and keeps the rest aligned',
      `${replacements} replacement char(s), then "${split.text.slice(replacements, replacements + 4)}"`,
    )
  } finally {
    rmSync(path, { force: true })
  }
}

// --- prompt input validation -----------------------------------------------

/**
 * A prompt that cannot be sent must be refused as a whole and say which input was
 * bad — and it must not be half-admitted. No model turn is involved: every case here
 * fails before the harness sees a message.
 */
async function promptInputChecks() {
  section('prompt input validation')
  if (!has('session_prompt') || !has('session_create') || !has('session_messages')) {
    skip('prompt input validation', 'needs session_prompt/session_create/session_messages')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  const before = (await callTool('session_messages', { sessionId: session.sessionId, limit: 10 })).messages ?? []

  const empty = await attemptTool('session_prompt', { sessionId: session.sessionId, prompt: '   ' })
  check(
    empty.ok === false && /non-empty text or at least one image/.test(empty.error ?? ''),
    'an empty prompt is refused with the supported shapes',
    empty.error?.slice(0, 60),
  )

  const textFile = join('/tmp', `dsh-as-mcp-live-not-image-${process.pid}.txt`)
  writeFileSync(textFile, 'plain text, not an image')
  try {
    const notImage = await attemptTool('session_prompt', {
      sessionId: session.sessionId,
      prompt: 'look at this',
      images: [{ path: textFile }],
    })
    check(
      notImage.ok === false && notImage.error?.includes(textFile) && /not an image/.test(notImage.error ?? ''),
      'a non-image attachment is refused by name',
      notImage.error?.slice(0, 70),
    )
  } finally {
    rmSync(textFile, { force: true })
  }

  const five = await attemptTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'too many images',
    images: Array.from({ length: 5 }, () => ({ path: '/tmp/none.png' })),
  })
  check(five.ok === false, 'more images than the cap is refused before any file is read', five.error?.slice(0, 60))

  const after = (await callTool('session_messages', { sessionId: session.sessionId, limit: 10 })).messages ?? []
  check(after.length === before.length, 'a refused prompt was never admitted', `${after.length} message(s)`)
}

// --- session creation errors -----------------------------------------------

/**
 * The error quality a caller-created session depends on: rejecting half a route
 * before a session exists, explaining an unroutable pair with the routes that do
 * exist, requiring a directory, and surfacing a bad preset.
 */
async function sessionCreateErrorChecks() {
  section('session creation errors')
  if (!has('session_create')) {
    skip('session creation errors', 'this endpoint advertises no session_create')
    return
  }
  const partial = await attemptTool('session_create', { cwd: process.cwd(), provider: 'deepseek' })
  check(
    partial.ok === false && /provider and model together/.test(partial.error ?? ''),
    'half a model route is refused before a session is created',
    partial.error?.slice(0, 60),
  )
  const neither = await attemptTool('session_create', {})
  check(
    neither.ok === false && /provide either workspaceId or cwd/.test(neither.error ?? ''),
    'a session without a workspace or directory is refused clearly',
    neither.error?.slice(0, 60),
  )

  const unroutable = await attemptTool('session_create', {
    cwd: process.cwd(),
    provider: 'definitely-not-a-provider',
    model: 'definitely-not-a-model',
  })
  const body = unroutable.ok ? unroutable.payload : undefined
  check(
    body?.sessionId !== undefined && /requested provider "definitely-not-a-provider"/.test(body?.modelSelectionError ?? '') &&
      /dsh_info/.test(body?.modelSelectionError ?? ''),
    'an unroutable pair still creates the session and explains the route problem',
    body?.modelSelectionError?.slice(0, 60),
  )

  const badPreset = await attemptTool('session_create', { cwd: process.cwd(), agentPreset: 'no-such-preset' })
  check(
    badPreset.ok === false && /preset/i.test(badPreset.error ?? ''),
    'an unknown agent preset is refused with a message that names it',
    badPreset.error?.slice(0, 60),
  )
}

// --- fork and rename contracts ---------------------------------------------

/**
 * The fork/rename promises: a title is stored trimmed and comes back through
 * session_list, a fork names its source and reports a non-zero inherited prefix, an
 * explicit `atSeq` boundary inherits no more than the default fork, and unknown ids
 * are legible errors. No model turn is needed for any of it.
 */
async function forkRenameChecks() {
  section('fork and rename contracts')
  if (!has('session_create') || !has('session_fork') || !has('session_rename')) {
    skip('fork and rename contracts', 'needs session_create/session_fork/session_rename')
    return
  }
  const source = await callTool('session_create', { cwd: process.cwd() })
  // A whitespace-only title must be refused before it reaches the harness.
  const blankTitle = await attemptTool('session_rename', { sessionId: source.sessionId, title: '   ' })
  check(
    blankTitle.ok === false && /title/i.test(blankTitle.error ?? ''),
    'a whitespace-only title is refused',
    blankTitle.error?.slice(0, 70),
  )
  const renamed = await callTool('session_rename', { sessionId: source.sessionId, title: '  padded title  ' })
  check(renamed.title === 'padded title', 'session_rename trims the title', JSON.stringify(renamed.title))

  if (has('session_list')) {
    const listed = await callTool('session_list', { limit: 50, includeTitle: true })
    const row = (listed.sessions ?? []).find((entry) => entry.sessionId === source.sessionId)
    check(row?.title === 'padded title', 'the renamed title comes back through session_list', row?.title)
  }

  // This session has never been prompted, and the harness refuses to fork a prefix
  // with no completed turn in it. The refusal must be legible: it is the answer a
  // caller that forgot to prompt the source needs. The positive fork path (with a
  // real turn) is exercised by --with-model's exercise/smoke scripts.
  const turnless = await attemptTool('session_fork', { sessionId: source.sessionId })
  check(
    turnless.ok === false && /no completed turn/i.test(turnless.error ?? ''),
    'forking a never-prompted session is refused with that reason',
    turnless.error?.slice(0, 70),
  )

  const missing = await attemptTool('session_rename', { sessionId: 'session-does-not-exist', title: 'x' })
  check(
    missing.ok === false && /no session|unknown session|not found/i.test(missing.error ?? ''),
    'renaming an unknown session is a legible error',
    missing.error?.slice(0, 60),
  )
  const empty = await attemptTool('session_rename', { sessionId: source.sessionId, title: '   ' })
  check(empty.ok === false, 'an empty title is refused before it reaches the harness', empty.error?.slice(0, 50))
}

// --- agent tool bridge -----------------------------------------------------

/**
 * `dsh_tool_list`/`dsh_tool_call` run the instance's own agent tools without a model
 * turn. The promises worth asserting: the list is real, an unlisted name is refused
 * with the setting that would allow it, a tool's own argument error reaches the
 * caller, and a large result is capped with its size reported instead of flooding
 * the conversation.
 */
async function toolBridgeChecks() {
  section('agent tool bridge')
  if (!has('dsh_tool_list') || !has('dsh_tool_call') || !has('session_create')) {
    skip('agent tool bridge', 'needs dsh_tool_list/dsh_tool_call/session_create')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  const listed = await callTool('dsh_tool_list', { sessionId: session.sessionId })
  const tools = listed.tools ?? []
  check(
    tools.length > 0 && tools.every((tool) => typeof tool.name === 'string' && tool.name !== ''),
    'dsh_tool_list reports the agent tools for a session',
    `${tools.length} tool(s)`,
  )
  const names = new Set(tools.map((tool) => tool.name))

  const unknownSession = await callTool('dsh_tool_list', { sessionId: 'no-such-session' })
  check(
    (unknownSession.tools ?? []).length === 0 && typeof unknownSession.scopeError === 'string' &&
      unknownSession.scopeError.includes('no-such-session'),
    'dsh_tool_list on an unknown session says it could not scope it instead of failing',
    String(unknownSession.scopeError ?? '').slice(0, 60),
  )

  const unknown = await attemptTool('dsh_tool_call', {
    name: 'definitely_not_a_tool',
    args: {},
    sessionId: session.sessionId,
  })
  check(
    unknown.ok === false &&
      /not exposed by this endpoint/.test(unknown.error ?? '') &&
      /agentTools\.allow/.test(unknown.error ?? ''),
    'an unlisted agent tool is refused with the setting that would allow it',
    unknown.error?.slice(0, 60),
  )

  // A listed tool given no arguments must fail with its own validation message, not
  // a transport error: that message is what tells a caller how to fix the call.
  // `maxResultChars` is the flood guard: a tool can return a whole file, and the
  // reply must say how big the untruncated text was instead of echoing it.
  const readTool = tools.find((tool) => tool.name === 'read')
  if (readTool !== undefined && has('file_write')) {
    const bigPath = join('/tmp', `dsh-as-mcp-live-bridge-${process.pid}.txt`)
    try {
      await callTool('file_write', { path: bigPath, content: 'x'.repeat(5_000) })
      // The agent's `read` tool names its argument `file_path`; older shapes use
      // `path`. Try both rather than pinning the script to one harness version.
      const readVia = async (argumentName) => attemptTool('dsh_tool_call', {
        name: 'read',
        args: { [argumentName]: bigPath },
        sessionId: session.sessionId,
        maxResultChars: 100,
      })
      const attempt = await readVia('file_path')
      const clamped = attempt.ok ? attempt.payload : (await readVia('path')).payload
      check(
        // The agent's own `read` formats text (line numbers, its own line cap), so the
        // untruncated size is not the file size — only that it exceeded our cap.
        clamped !== undefined && clamped.truncated === true && clamped.resultBytes > 100 &&
          String(clamped.text ?? '').length <= 100,
        'dsh_tool_call { maxResultChars } bounds the result and reports its size',
        `${clamped?.resultBytes ?? '?'} bytes, ${String(clamped?.text ?? '').length} chars returned`,
      )
    } finally {
      rmSync(bigPath, { force: true })
    }
  } else {
    skip('dsh_tool_call result cap', 'the agent exposes no read tool')
  }

  const first = tools.find((tool) => typeof tool.name === 'string')
  if (first !== undefined) {
    const invalid = await attemptTool('dsh_tool_call', {
      name: first.name,
      args: {},
      sessionId: session.sessionId,
    })
    const rejected = invalid.ok ? invalid.payload?.ok === false : true
    check(
      rejected,
      `"${first.name}" with empty arguments is rejected by the tool, not the transport`,
      (invalid.ok ? invalid.payload?.error : invalid.error)?.slice(0, 60),
    )
  }

  if (names.has('bash')) {
    const big = await attemptTool('dsh_tool_call', {
      name: 'bash',
      // bash requires `description` first in its schema; `command` runs 30 KB.
      args: {
        description: 'emit 30000 bytes for the result cap check',
        command: `node -e "process.stdout.write('y'.repeat(30000))"`,
      },
      sessionId: session.sessionId,
      maxResultChars: 200,
    })
    const body = big.ok ? big.payload : undefined
    check(
      body?.ok === true && body.truncated === true && body.resultBytes >= 30000 &&
        typeof body.text === 'string' && body.text.length <= 200 && body.value === undefined,
      'a large agent-tool result is capped, with its original size reported',
      `${body?.resultBytes ?? '?'} bytes, text ${body?.text?.length ?? '?'} chars`,
    )
  } else {
    skip('large agent-tool result cap', 'this composition lists no bash tool')
  }
}

// --- workspace contracts ---------------------------------------------------

/**
 * The workspace promises: the same path is one registration, a missing directory is
 * created only when asked, and deleting a workspace leaves the directory and its
 * files alone (idempotently, so a retried cleanup is not an error).
 */
async function workspaceChecks() {
  section('workspace contracts')
  if (!has('workspace_create') || !has('workspace_list') || !has('workspace_delete')) {
    skip('workspace contracts', 'needs workspace_create/list/delete')
    return
  }
  const dir = join('/tmp', `dsh-as-mcp-live-ws-${process.pid}`)
  const kept = join(dir, 'keep.txt')
  rmSync(dir, { recursive: true, force: true })
  try {
    const created = await callTool('workspace_create', { path: dir })
    const workspace = created.workspace
    check(
      typeof workspace?.id === 'string' && created.created === true && existsSync(dir),
      'workspace_create registers and makes the directory',
    )
    // The default makes the directory; `createDirectory: false` is the strict mode.
    const implicitParent = join(dir, 'nested', 'deeper')
    const implicit = await callTool('workspace_create', { path: implicitParent })
    check(
      existsSync(implicitParent) && implicit.created === true,
      'workspace_create makes a missing path by default',
    )
    await callTool('workspace_delete', { workspaceId: implicit.workspace?.id })
    const strictMissing = join(dir, 'nested', 'strict')
    const strict = await attemptTool('workspace_create', { path: strictMissing, createDirectory: false })
    check(
      strict.ok === false && existsSync(strictMissing) === false,
      'workspace_create { createDirectory: false } refuses a missing path',
      strict.error?.slice(0, 70),
    )

    const again = await callTool('workspace_create', { path: dir, title: 'renamed title' })
    check(
      again.workspace?.id === workspace?.id && again.created === false,
      'registering the same path returns the existing workspace',
      again.workspace?.id,
    )

    // The file tools are a separate group; this section must still run when they are off.
    const canTouchFiles = has('file_write') && has('file_read')
    if (canTouchFiles) {
      rmSync(kept, { force: true })
      await callTool('file_write', { path: kept, content: 'keep me' })
    }
    const listed = await callTool('workspace_list')
    const row = (listed.workspaces ?? []).find((entry) => entry.id === workspace?.id)
    check(
      row !== undefined && row.path !== undefined && typeof row.sessionCount === 'number' && row.status === 'ok',
      'workspace_list reports the registration, its path, session count and status',
      `${row?.sessionCount ?? '?'} session(s), ${row?.status ?? '?'}`,
    )

    // `sessionCount` is the registry's own attach list, not "sessions whose cwd is this
    // directory": a session created through the registration is counted, one created by
    // cwd alone is not. Both halves are checked, because the row reads like a cwd tally.
    if (has('session_create')) {
      const countNow = async () => (await callTool('workspace_list')).workspaces
        ?.find((entry) => entry.id === workspace?.id)?.sessionCount
      const beforeCount = await countNow()
      await callTool('session_create', { workspaceId: workspace?.id })
      const attachedCount = await countNow()
      check(
        typeof beforeCount === 'number' && attachedCount === beforeCount + 1,
        'a session created through the registration is counted on it',
        `${beforeCount} -> ${attachedCount ?? '?'}`,
      )
      await callTool('session_create', { cwd: dir })
      const cwdCount = await countNow()
      check(
        cwdCount === attachedCount,
        'a session created by cwd alone is not attached to the registration',
        `${attachedCount} -> ${cwdCount ?? '?'}`,
      )
    }

    // Deleting an id this instance does not know is a no-op with a boolean, not an error.
    const unknownDelete = await callTool('workspace_delete', { workspaceId: 'no-such-workspace' })
    check(unknownDelete.deleted === false, 'workspace_delete of an unknown id answers deleted: false')
    const deleted = await callTool('workspace_delete', { workspaceId: workspace.id })
    check(deleted.deleted === true, 'workspace_delete removes the registration')
    const after = await callTool('workspace_list')
    check(
      !(after.workspaces ?? []).some((entry) => entry.id === workspace.id),
      'the deleted workspace leaves the list',
    )
    if (canTouchFiles) {
      check(
        existsSync(kept) && (await callTool('file_read', { path: kept })).text === 'keep me',
        'deleting a workspace leaves its directory and files untouched',
      )
    } else {
      skip('workspace deletion leaves files untouched', 'the files tool group is off')
    }
    const idempotent = await callTool('workspace_delete', { workspaceId: workspace.id })
    check(idempotent.deleted === false, 'deleting an unknown workspace answers deleted:false, not an error')

    const missing = join('/tmp', `dsh-as-mcp-live-ws-missing-${process.pid}`)
    rmSync(missing, { recursive: true, force: true })
    const refused = await attemptTool('workspace_create', { path: missing, createDirectory: false })
    check(
      refused.ok === false && existsSync(missing) === false,
      'createDirectory:false refuses a missing directory without creating it',
      refused.error?.slice(0, 60),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- file editing contracts ------------------------------------------------

/**
 * The promises in the file tool descriptions: an ambiguous `oldText` is refused and
 * writes nothing, `replaceAll` replaces every occurrence, and `createDirectories:
 * false` fails before creating anything. Each is cheap and directly falsifiable.
 */
async function fileEditChecks() {
  section('file edit contracts')
  if (!has('file_write') || !has('file_read') || !has('file_edit')) {
    skip('file edit contracts', 'needs file_write, file_read and file_edit')
    return
  }
  const path = join('/tmp', `dsh-as-mcp-live-edit-${process.pid}.txt`)
  rmSync(path, { force: true })
  await callTool('file_write', { path, content: 'alpha\nbeta\ngamma\n' })
  try {
    const written = await callTool('file_read', { path })
    check(written.text === 'alpha\nbeta\ngamma\n', 'file_write round-trips through file_read')

    // `createDirectories` is the difference between "write into a tree that exists" and
    // "quietly create whatever path was asked for".
    const nested = join('/tmp', `dsh-as-mcp-live-nested-${process.pid}`, 'a', 'b.txt')
    await callTool('file_write', { path: nested, content: 'nested' })
    check(
      (await callTool('file_read', { path: nested })).text === 'nested',
      'file_write creates missing parents by default',
    )
    const strictNested = join('/tmp', `dsh-as-mcp-live-nested-${process.pid}`, 'c', 'b.txt')
    const withoutParents = await attemptTool('file_write', { path: strictNested, content: 'x', createDirectories: false })
    check(
      withoutParents.ok === false && existsSync(strictNested) === false,
      'file_write { createDirectories: false } refuses a missing parent',
      withoutParents.error?.slice(0, 60),
    )

    // `maxDepth` bounds a recursive walk to the requested depth.
    const shallow = await callTool('file_list', { path: dirname(nested), recursive: true, maxDepth: 1 })
    check(
      (shallow.entries ?? []).every((entry) => (entry.depth ?? 1) <= 1),
      'file_list { maxDepth } bounds a recursive walk',
      `${(shallow.entries ?? []).length} entr(ies)`,
    )

    // The edit honours the same compare-and-swap as a write: a hash read before the
    // file changed must not be allowed to rewrite it.
    const before = await callTool('file_read', { path, sha256: true })
    await callTool('file_write', { path, content: 'changed elsewhere\n' })
    const staleEdit = await attemptTool('file_edit', {
      path,
      oldText: 'changed elsewhere',
      newText: 'clobbered',
      expectedSha256: before.sha256,
    })
    check(
      staleEdit.ok === false && /current sha256 is/.test(staleEdit.error ?? '') &&
        (await callTool('file_read', { path })).text === 'changed elsewhere\n',
      'a stale expectedSha256 refuses the edit and leaves the file intact',
      staleEdit.error?.slice(0, 60),
    )
    const fresh = await callTool('file_read', { path, sha256: true })
    await callTool('file_edit', {
      path,
      oldText: 'changed elsewhere',
      newText: 'alpha\nbeta\ngamma',
      expectedSha256: fresh.sha256,
    })
    check(
      (await callTool('file_read', { path })).text === 'alpha\nbeta\ngamma\n',
      'the edit succeeds with the current hash',
    )

    const ambiguous = await attemptTool('file_edit', { path, oldText: 'a', newText: 'A' })
    check(
      ambiguous.ok === false && /occur|match|unique|ambiguous/i.test(ambiguous.error ?? ''),
      'an ambiguous oldText is refused',
      ambiguous.error?.slice(0, 70),
    )
    check(
      (await callTool('file_read', { path })).text === 'alpha\nbeta\ngamma\n',
      'the refused edit wrote nothing',
    )

    const replaced = await callTool('file_edit', { path, oldText: 'a', newText: 'A', replaceAll: true })
    check(
      typeof replaced.path === 'string' &&
        (await callTool('file_read', { path })).text === 'AlphA\nbetA\ngAmmA\n',
      'replaceAll replaces every occurrence',
      (await callTool('file_read', { path })).text.slice(0, 20),
    )

    const missingParent = join('/tmp', `dsh-as-mcp-live-missing-${process.pid}`, 'file.txt')
    rmSync(dirname(missingParent), { recursive: true, force: true })
    const refused = await attemptTool('file_write', {
      path: missingParent,
      content: 'x',
      createDirectories: false,
    })
    check(
      refused.ok === false && /parent directory does not exist/.test(refused.error ?? '') &&
        existsSync(missingParent) === false && existsSync(dirname(missingParent)) === false,
      'createDirectories:false refuses before creating the parent',
      refused.error?.slice(0, 70),
    )

    // Relative paths resolve against cwd for all three tools, not just write.
    const relative = `dsh-as-mcp-live-rel-${process.pid}.txt`
    await callTool('file_write', { path: relative, cwd: '/tmp', content: 'relative' })
    check(
      (await callTool('file_read', { path: relative, cwd: '/tmp' })).text === 'relative',
      'a relative path resolves against cwd',
    )
    rmSync(join('/tmp', relative), { force: true })
  } finally {
    rmSync(path, { force: true })
  }
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
    // `approval.policy` is a security posture, so the reply must say which stance the
    // session actually got: "allow" switches it to the harness's unattended mode, and a
    // profile where that is impossible must explain rather than silently inherit.
    const approvalInfo = await callTool('dsh_info')
    if (approvalInfo.config?.approval === 'allow') {
      check(
        created.approvalPolicy === 'never' || typeof created.approvalPolicyError === 'string',
        'approval.policy allow makes the session unattended, or says why it could not',
        created.approvalPolicy ?? created.approvalPolicyError?.slice(0, 50),
      )
    } else {
      check(
        created.approvalPolicy === undefined,
        'approval.policy inherit leaves the session on the harness default',
        String(created.approvalPolicy),
      )
    }
    const unknownCwd = await callTool('session_list', { cwd: '/tmp/dsh-as-mcp-not-a-workspace', limit: 5 })
    check(
      (unknownCwd.sessions ?? []).length === 0 && unknownCwd.total === 0,
      'session_list for a cwd with no sessions is empty, not an error',
    )
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

  // Compare-and-swap across interleaved clients: A reads the hash, B changes the
  // file, A's guarded write must be refused (and name the new hash), then A re-reads
  // and succeeds. This is the lost-update window a CAS is for.
  if (has('file_write') && has('file_read')) {
    const path = join('/tmp', `dsh-as-mcp-live-cas-${process.pid}.txt`)
    try {
      await callTool('file_write', { path, content: 'initial\n' })
      const readA = await callTool('file_read', { path, sha256: true })
      await callTool('file_write', { path, content: 'written by B\n' })
      const stale = await attemptTool('file_write', {
        path,
        content: 'written by A\n',
        expectedSha256: readA.sha256,
      })
      const afterStale = await callTool('file_read', { path, sha256: true })
      check(
        stale.ok === false && /current sha256 is/.test(stale.error ?? '') &&
          afterStale.text === 'written by B\n',
        "a stale client's guarded write is refused and leaves B's content intact",
        stale.error?.slice(0, 60),
      )
      const retried = await callTool('file_write', {
        path,
        content: 'written by A\n',
        expectedSha256: afterStale.sha256,
      })
      check(
        retried.sha256 !== afterStale.sha256 &&
          (await callTool('file_read', { path })).text === 'written by A\n',
        'the retry with the current hash succeeds',
        `${String(retried.sha256).slice(0, 12)}…`,
      )
    } finally {
      rmSync(path, { force: true })
    }
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

  // On a profile that turned a group off, the reason must name the switch an operator
  // would flip — otherwise "unavailable" is a dead end.
  const disabledGroups = Object.entries(info.enabledToolGroups ?? {})
    .filter(([, enabled]) => enabled !== true)
    .map(([group]) => group)
  if (disabledGroups.length > 0) {
    const gated = (availability.unavailable ?? []).filter((entry) => entry.reason.includes('tool group is disabled'))
    check(
      disabledGroups.every((group) => gated.some((entry) => entry.reason.includes(`tools.${group}: false`))),
      'a disabled tool group names the config switch in its reason',
      `${disabledGroups.join(', ')} disabled`,
    )
  }
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
  const totalMs = Date.now() - startedAt
  check(arrivals.length > 0, 'progress notifications are sent', `${arrivals.length} in ${totalMs}ms`)
  // A fast turn can legitimately produce a single notification (the sender is
  // rate-limited to about one a second). What must hold is that it arrived *during*
  // the turn: a batched-at-the-end implementation would only deliver after the reply.
  check(
    arrivals[0] < totalMs - 100,
    'progress arrives while the turn runs, not only at the end',
    `first at ${arrivals[0] ?? '?'}ms of ${totalMs}ms`,
  )
  check(
    arrivals.length === 1 || arrivals[arrivals.length - 1] - arrivals[0] > 500,
    'when more than one arrives, they are spread across the turn',
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
          // A tool call makes the turn reliably long enough to queue behind and then
          // cancel; a pure generation turn can finish between the two requests.
          prompt: 'Run the bash command: sleep 10; echo CANCELLED-WINDOW. Then reply exactly: CANCEL DONE.',
          timeoutMs: 300_000,
        },
      },
    }),
  })
  await waitUntilRunning(session.sessionId)
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
  // The wait ending is one thing; the turn actually stopping is another. The listing's
  // running filter is the second view, and it must converge rather than keep the session
  // "running" forever.
  let leftRunning = false
  for (let attempt = 0; attempt < 40 && has('session_list'); attempt += 1) {
    const listed = await callTool('session_list', { running: true, limit: 50 })
    if (!(listed.sessions ?? []).some((row) => row.sessionId === session.sessionId)) {
      leftRunning = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  check(leftRunning || !has('session_list'), 'the cancelled turn leaves the running filter', String(leftRunning))
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
  // Steer the child through the parent: switch the parent's model before spawning, so
  // the run also answers "is inheritance at spawn time, or fixed at session creation?".
  // The probe that designed this check showed the child following the switched route.
  let steeredRoute
  if (has('session_set_model')) {
    const info = await callTool('dsh_info', { includeModels: true })
    const routes = (info.catalog?.providerModels ?? []).filter(
      (entry) => typeof entry.provider === 'string' && Array.isArray(entry.models) && entry.models.length > 0,
    )
    if (routes.length >= 2) {
      const target = routes[routes.length - 1]
      steeredRoute = `${target.provider}/${target.models[0].id}`
      await callTool('session_set_model', {
        sessionId: session.sessionId,
        provider: target.provider,
        model: target.models[0].id,
      })
    }
  }
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
  if (steeredRoute !== undefined) {
    check(
      (prompted.turn?.models ?? []).includes(steeredRoute),
      'the switched route is what the spawning turn used',
      `${(prompted.turn?.models ?? []).join(',') || '?'} (wanted ${steeredRoute})`,
    )
  }

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
    // Documented claim: a prompt reply's `session` block is that session's own turns,
    // never the folded children — the report is where subagent money first appears.
    const replyTokens = prompted.session?.usage?.totals?.totalTokens
    const selfRow = (report.sessions ?? []).find((row) => row.origin === 'self')
    check(
      typeof replyTokens === 'number' && (report.totals?.totalTokens ?? 0) > replyTokens &&
        selfRow?.usage?.totals?.totalTokens === replyTokens,
      "the prompt reply's session snapshot excludes the subagent, the report includes it",
      `reply ${replyTokens ?? '?'} < report ${report.totals?.totalTokens ?? '?'}`,
    )

    // Route inheritance, verified live before it was documented: a child spawned by a
    // session created on a non-default route spent on that same route.
    const routesOf = (row) => (row?.usage?.byModel ?? [])
      .map((entry) => `${entry.provider}/${entry.model}`)
      .filter((route) => !route.startsWith('null/'))
    const parentRoutes = routesOf((report.sessions ?? []).find((row) => row.origin === 'self'))
    const childRoutes = routesOf(child)
    check(
      childRoutes.length > 0 && childRoutes.every((route) => parentRoutes.includes(route)),
      "a subagent spends on its parent session's selected route",
      `child ${childRoutes.join(',') || '?'} within parent ${parentRoutes.join(',') || '?'}`,
    )
    if (steeredRoute !== undefined) {
      // Inheritance happens at spawn time: the parent answered on one route earlier,
      // was switched, and the child followed the switch.
      check(
        childRoutes.includes(steeredRoute),
        'the child follows the route the parent had selected when it spawned',
        `child ${childRoutes.join(',')} (wanted ${steeredRoute})`,
      )
    }

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

// --- orchestration ---------------------------------------------------------

/**
 * The queue/cancel/poll combination a real orchestrator uses on one session: start
 * a long turn without waiting, queue work behind it, withdraw that queued work,
 * cancel the running turn, then keep using the session. Each tool exists on its own;
 * this checks they compose on one session without corrupting its state.
 */
async function orchestrationCheck() {
  section('orchestration on one session (real turn)')
  if (!has('session_prompt') || !has('session_cancel')) {
    skip('orchestration checks', 'needs session_prompt and session_cancel')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Run the bash command: sleep 20; echo LONG-DONE. Then reply exactly: LONG TURN.',
    wait: false,
  })

  // A queued message must not start while the first turn is open.
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: QUEUED-NEVER',
    wait: false,
  })

  let queueListed = false
  if (has('session_queue')) {
    const queue = await callTool('session_queue', { sessionId: session.sessionId })
    const rows = queue.queued ?? []
    check(rows.length >= 1, 'the queued message is visible while the turn runs', `${rows.length} queued`)
    check(
      rows.every((row) => typeof row.id === 'string' && typeof row.text === 'string' &&
        typeof row.images === 'number' && (row.source === undefined || typeof row.source === 'string')),
      'queue rows name their id, text, image count and source kind',
      `${rows[0]?.source ?? 'no source field'} source`,
    )
    queueListed = rows.length >= 1
    if (queueListed) {
      const removed = await callTool('session_queue', {
        sessionId: session.sessionId,
        messageId: rows[0].id,
        action: 'remove',
      })
      check(removed.accepted === true, 'the queued message can be withdrawn')
    }
    // Cross-client: a message queued by another MCP client must be visible and
    // withdrawable here. The queue lives on the session, so a connection-scoped id
    // would be a bug a single-client test cannot see.
    const secondary = secondaryClient()
    await secondary.callTool('session_prompt', {
      sessionId: session.sessionId,
      prompt: 'Reply with exactly: QUEUED-FROM-OTHER-CLIENT',
      wait: false,
    })
    const crossQueue = await callTool('session_queue', { sessionId: session.sessionId })
    const foreign = (crossQueue.queued ?? []).find(
      (entry) => String(entry.text ?? '').includes('QUEUED-FROM-OTHER-CLIENT'),
    )
    check(foreign !== undefined, 'a message queued by another client is visible here', `${(crossQueue.queued ?? []).length} queued`)
    if (foreign !== undefined) {
      const withdrawn = await callTool('session_queue', {
        sessionId: session.sessionId,
        messageId: foreign.id,
        action: 'remove',
      })
      check(withdrawn.accepted === true, 'a message queued by another client can be withdrawn here')
    }
  } else {
    skip('queue checks in orchestration', 'this endpoint advertises no session_queue')
  }

  // A second queued message stays queued: session_cancel stops the running turn,
  // it does not throw away the work waiting behind it (the description says so).
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: ORIGINAL-QUEUE',
    wait: false,
  })

  const cancelled = await callTool('session_cancel', { sessionId: session.sessionId })
  check(cancelled.accepted === true, 'the running turn can be cancelled')

  let preserved = false
  if (has('session_queue')) {
    const afterCancel = await callTool('session_queue', { sessionId: session.sessionId })
    const remaining = (afterCancel.queued ?? []).filter(
      (entry) => String(entry.text ?? '').includes('ORIGINAL-QUEUE'),
    )
    preserved = remaining.length === 1
    check(preserved, 'cancelling preserves the work queued behind the turn', `${remaining.length} left`)
    if (preserved) {
      // A message id that is not in the queue must say so instead of silently accepting.
    const bogus = await attemptTool('session_queue', {
      sessionId: session.sessionId,
      messageId: 'no-such-message',
      action: 'remove',
    })
    check(
      bogus.ok === false && /no queued message|not found|unknown|no longer pending/i.test(bogus.error ?? ''),
      'an unknown queued message id is refused with a readable message',
      bogus.error?.slice(0, 70),
    )

    // Editing a pending message must change what runs, not just what a listing shows.
      const edited = await callTool('session_queue', {
        sessionId: session.sessionId,
        messageId: remaining[0].id,
        action: 'edit',
        content: 'Reply with exactly: EDITED-QUEUE',
      })
      check(edited.accepted === true, 'a queued message can be edited in place')
    }
  }

  // The session must still work afterwards: this is the state corruption a
  // cancel/queue combination would leave behind. The queued message runs first,
  // so the marker for it appears before our prompt's reply.
  const after = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: STILL USABLE',
    timeoutMs: 300_000,
  })
  check(/STILL USABLE/.test(after.turn?.reply ?? ''), 'the session answers after the cancelled turn', after.turn?.reply)
  const messages = await callTool('session_messages', { sessionId: session.sessionId, limit: 100 })
  const transcript = messages.messages ?? []
  check(
    !transcript.some((message) => String(message.text ?? '').includes('QUEUED-NEVER')) &&
      !transcript.some((message) => String(message.text ?? '').includes('QUEUED-FROM-OTHER-CLIENT')),
    'the withdrawn messages never ran (including the one another client queued)',
  )
  if (preserved) {
    check(
      transcript.some((message) => String(message.text ?? '').includes('EDITED-QUEUE')) &&
        !transcript.some((message) => String(message.text ?? '').includes('ORIGINAL-QUEUE')),
      'the edited message ran after the cancellation, and the original text did not',
    )
  }
}

// --- title generation is invisible to usage --------------------------------

/**
 * README says the session title is generated by an LLM call that leaves **no usage
 * record**: only `session/title-llm-request` (naming the route) reaches the log, so no
 * token fold can see the spend. This reads the session's own durable log through
 * `shell_run` and compares the usage-bearing events with the receipt's sample count — if
 * the title call wrote usage anywhere, the two would disagree.
 */
async function titleUsageCheck() {
  section('title generation is invisible to usage (real turn)')
  if (!has('session_prompt') || !has('session_usage') || !has('shell_run')) {
    skip('title usage check', 'needs session_prompt, session_usage and shell_run')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: TITLE PROBE',
    timeoutMs: 300_000,
  })
  // The title call runs just after the turn settles, and how long it takes is the
  // harness's business: poll the log instead of sleeping a fixed guess that would flake
  // on a slow machine.
  const command = `f=$(ls ~/.dsh/sessions/*/${session.sessionId}/session.v4.jsonl.zstd 2>/dev/null | head -1)`
    + '; if [ -z "$f" ]; then echo NOFILE; exit 0; fi'
    + '; echo "messages:$(zstd -dc "$f" | grep -c \'"type":"assistant/message"\')"'
    + '; echo "attempts:$(zstd -dc "$f" | grep -c \'"type":"assistant/attempt"\')"'
    + '; echo "titles:$(zstd -dc "$f" | grep -c \'"type":"session/title-llm-request"\')"'
    + '; echo "titleRoute:$(zstd -dc "$f" | grep -c \'"type":"session/title-llm-request".*"route"\')"'
  let stdout = ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const log = await callTool('shell_run', { command })
    stdout = String(log.stdout ?? '')
    if (stdout.includes('NOFILE') || Number(new RegExp('titles:(\\d+)').exec(stdout)?.[1] ?? '0') > 0) break
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  if (stdout.includes('NOFILE')) {
    skip('title usage check', 'could not locate the session log')
    return
  }
  const read = (label) => Number(new RegExp(`${label}:(\\d+)`).exec(stdout)?.[1] ?? 'NaN')
  const messages = read('messages')
  const attempts = read('attempts')
  const titles = read('titles')
  const titleRoute = read('titleRoute')
  const usage = await callTool('session_usage', { sessionId: session.sessionId })
  const samples = usage.sessions?.[0]?.usage?.samples

  check(
    titles >= 1 && titleRoute >= 1,
    'the harness asked for a title and named the route it would use',
    `${titles} request(s), ${titleRoute} with a route`,
  )
  // Every usage-bearing event the log contains is what the receipt counted; the title
  // request itself carries no usage record for a fold to see.
  check(
    samples === messages + attempts,
    'usage samples equal the assistant events in the log (the title call is not one)',
    `samples ${samples ?? '?'} vs ${messages + attempts} assistant event(s)`,
  )
}

// --- images attached to a prompt -------------------------------------------

/**
 * A prompt can carry screenshots. The path is read through the same filesystem seam and
 * becomes an image block for the model, so this checks the accepted path end to end (one
 * real turn) and the refusals that cost nothing: more than four images, and an unreadable
 * path.
 */
async function promptImageCheck() {
  section('prompt images (real turn)')
  if (!has('session_prompt') || !has('shell_run')) {
    skip('prompt image check', 'needs session_prompt and shell_run')
    return
  }
  const png = join('/tmp', `dsh-as-mcp-live-prompt-${process.pid}.png`)
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg=='
  try {
    await callTool('shell_run', {
      command: `node -e "require('node:fs').writeFileSync('${png}', Buffer.from('${base64}','base64'))"`,
    })
    const session = await callTool('session_create', { cwd: process.cwd() })
    const attached = await callTool('session_prompt', {
      sessionId: session.sessionId,
      prompt: 'Reply with exactly: IMAGE OK',
      images: [{ path: png }],
      timeoutMs: 300_000,
    })
    check(/IMAGE OK/.test(attached.turn?.reply ?? ''), 'a prompt can carry an image and still settle', attached.turn?.reply?.slice(0, 40))

    const five = Array.from({ length: 5 }, () => ({ path: png }))
    const tooMany = await attemptTool('session_prompt', {
      sessionId: session.sessionId,
      prompt: 'too many',
      images: five,
      wait: false,
    })
    check(tooMany.ok === false, 'more than four prompt images is refused before the turn', tooMany.error?.slice(0, 60))

    const unreadable = await attemptTool('session_prompt', {
      sessionId: session.sessionId,
      prompt: 'missing image',
      images: [{ path: `${png}.missing` }],
      wait: false,
    })
    check(
      unreadable.ok === false && /missing/.test(unreadable.error ?? ''),
      'an unreadable prompt image names the path',
      unreadable.error?.slice(0, 70),
    )
  } finally {
    rmSync(png, { force: true })
  }
}

// --- idempotent retry across clients ---------------------------------------

/**
 * `idempotencyKey` is what makes a retry safe. The acceptance run covers one client
 * retrying; this covers a *second* MCP client re-sending the same key — the case of two
 * harness instances driving one session — and checks that only one turn ran.
 */
async function idempotencyCheck() {
  section('idempotent retry across clients (real turn)')
  if (!has('session_prompt') || !has('session_usage')) {
    skip('idempotent retry check', 'needs session_prompt and session_usage')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  const key = `live-idem-${process.pid}`
  const prompt = 'Reply with exactly: IDEM-ONE'
  const first = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt,
    idempotencyKey: key,
    timeoutMs: 300_000,
  })
  check(/IDEM-ONE/.test(first.turn?.reply ?? ''), 'the first send with a key runs a turn', first.turn?.reply?.slice(0, 40))

  const secondary = secondaryClient()
  const replay = await secondary.callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt,
    idempotencyKey: key,
    timeoutMs: 300_000,
  })
  check(
    replay.replayed === true && replay.turn?.reply === first.turn?.reply,
    'a second client retrying the same key gets the recorded turn instead of a new one',
    `replayed ${String(replay.replayed)}`,
  )
  const mismatch = await attemptTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: DIFFERENT-CONTENT',
    idempotencyKey: key,
    timeoutMs: 60_000,
  })
  check(
    mismatch.ok === false && /reused for different content/.test(mismatch.error ?? ''),
    'the key cannot be reused for different content, from this client either',
    mismatch.error?.slice(0, 70),
  )

  const usage = await callTool('session_usage', { sessionId: session.sessionId, includeTurns: true })
  const turns = usage.sessions?.[0]?.usage?.byTurn ?? []
  check(turns.length === 1, 'only one turn ran despite three send attempts', `${turns.length} turn(s)`)
}


// --- a second entry onto the same endpoint -----------------------------------

/**
 * `mountOnWebServer` adds a second way in: the same endpoint is reachable on DSH's own
 * web server as well as the plugin's listener. Both entries must advertise the same tools
 * and answer the same questions — a second entry that disagrees is a deployment that
 * half-works depending on which URL a client was given.
 *
 * Without a listener (the `mountonly` shape) there is only one way in, so this needs the
 * hybrid shape and its `--also` URL; it skips otherwise.
 */
async function secondEntryChecks() {
  const also = option('--also', undefined)
  if (also === undefined) {
    skip('second entry', 'no --also URL (only a hybrid deployment has two entries)')
    return
  }
  section('a second entry onto the same endpoint')
  const alsoUrl = also.endsWith('/mcp') || also.includes('?') ? also : `${also.replace(/\/+$/, '')}/mcp`
  const other = secondaryClient(alsoUrl)
  try {
    // The web-server mount happens *after* the plugin's own listener is up, so a hybrid
    // deployment's second entry can refuse for a moment after the first one answers.
    let otherTools
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        otherTools = await other.listTools()
        if (otherTools.length > 0) break
      } catch {
        // not mounted yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    if (otherTools === undefined) otherTools = await other.listTools()
    check(
      otherTools.length === surface.size && otherTools.every((name) => surface.has(name)),
      'both entries advertise the same tools',
      `${otherTools.length} vs ${surface.size}`,
    )
    const otherInfo = await other.callTool('dsh_info')
    const mainInfo = await callTool('dsh_info')
    check(
      otherInfo.version === mainInfo.version && otherInfo.listening === mainInfo.listening,
      'both entries report the same build and listener state',
      `${otherInfo.version}/${String(otherInfo.listening)}`,
    )
    if (has('workspace_list')) {
      const otherWorkspaces = (await other.callTool('workspace_list')).workspaces ?? []
      const mainWorkspaces = (await callTool('workspace_list')).workspaces ?? []
      const ids = (rows) => rows.map((row) => row.id).sort().join(',')
      check(
        ids(otherWorkspaces) === ids(mainWorkspaces),
        'both entries see the same registered workspaces',
        `${otherWorkspaces.length} vs ${mainWorkspaces.length}`,
      )
    }
    // Same host, two doors: a session must be the same object through either one, or a
    // client handed the wrong URL sees a different instance's state.
    // Admission is the same on both doors: the same bearer is accepted, and a request
    // without one is refused with the header that names the scheme.
    {
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bare', version: '1' } },
      })
      const bare = await fetch(alsoUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body,
      })
      check(
        bare.status === 401 && /Bearer/.test(bare.headers.get('www-authenticate') ?? ''),
        'the second entry refuses an unauthenticated request the same way',
        `HTTP ${bare.status}`,
      )
      const wrong = await fetch(alsoUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer not-the-token',
        },
        body,
      })
      check(wrong.status === 401, 'the second entry refuses a wrong bearer too', `HTTP ${wrong.status}`)
    }
    if (has('session_create') && has('session_list')) {
      const created = await callTool('session_create', { cwd: process.cwd() })
      const seenFromOther = (await other.callTool('session_list', { limit: 50 })).sessions ?? []
      check(
        seenFromOther.some((row) => row.sessionId === created.sessionId),
        'a session created through one entry is listed through the other',
        created.sessionId,
      )
      if (has('session_rename')) {
        const title = `live-cross-entry-${process.pid}`
        await other.callTool('session_rename', { sessionId: created.sessionId, title })
        const fromMain = (await callTool('session_list', { limit: 50, includeTitle: true })).sessions ?? []
        check(
          fromMain.find((row) => row.sessionId === created.sessionId)?.title === title,
          'a rename made through the other entry is what this one reports',
          title,
        )
      }
    }
  } catch (error) {
    check(false, 'the second entry answers', error instanceof Error ? error.message : String(error))
  }
}

// --- steering into a running turn ------------------------------------------

/**
 * `session_queue { action: "steer" }` promises to deliver a queued message into the turn
 * that is *already running* instead of waiting behind it. Probed live before it was
 * asserted: start a turn that sleeps, queue a marker, steer it, and check the marker
 * appears inside that turn's number rather than as a new turn.
 */
async function steerCheck() {
  section('steering (real turn)')
  if (!has('session_queue') || !has('session_prompt')) {
    skip('steer check', 'needs session_queue and session_prompt')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Run the bash command: sleep 10; echo WINDOW. Then reply exactly: WINDOW DONE.',
    wait: false,
  })
  await waitUntilRunning(session.sessionId)
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: STEER-INLINE',
    wait: false,
  })
  const queue = await callTool('session_queue', { sessionId: session.sessionId })
  const row = (queue.queued ?? []).find((entry) => String(entry.text ?? '').includes('STEER-INLINE'))
  if (row === undefined) {
    check(false, 'the message to steer is visible in the queue', `${(queue.queued ?? []).length} queued`)
    return
  }
  const steered = await attemptTool('session_queue', {
    sessionId: session.sessionId,
    messageId: row.id,
    action: 'steer',
  })
  check(
    steered.ok === true && steered.payload?.accepted === true,
    'a queued message can be steered into the running turn',
    steered.ok ? String(steered.payload?.accepted) : steered.error?.slice(0, 60),
  )

  // Settle the turn, then read back: the steered text must be inside the original
  // turn, not a later one.
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: AFTER-STEER',
    timeoutMs: 600_000,
  })
  const messages = await callTool('session_messages', { sessionId: session.sessionId, limit: 200 })
  const rows = messages.messages ?? []
  const steeredRow = rows.find((message) => String(message.text ?? '').includes('STEER-INLINE'))
  // Transcript rows do not always carry a turn number, so the turn count is the honest
  // witness: a message that merely queued would need a turn of its own.
  const usage = await callTool('session_usage', { sessionId: session.sessionId, includeTurns: true })
  const turns = usage.sessions?.[0]?.usage?.byTurn ?? []
  check(
    steeredRow !== undefined && turns.length === 2,
    'the steered message is processed inside the running turn (no turn of its own)',
    `${turns.length} turn(s); steered ${steeredRow !== undefined ? 'yes' : 'no'}`,
  )

  // The same fold-in through the prompt API: `session_prompt { mode: "steer" }`
  // delivers into the running turn and its reply is that turn's answer.
  const steerSession = await callTool('session_create', { cwd: process.cwd() })
  await callTool('session_prompt', {
    sessionId: steerSession.sessionId,
    prompt: 'Run the bash command: sleep 10; echo WINDOW. Then reply exactly: WINDOW DONE.',
    wait: false,
  })
  await waitUntilRunning(steerSession.sessionId)
  const viaPrompt = await callTool('session_prompt', {
    sessionId: steerSession.sessionId,
    prompt: 'Reply with exactly: STEER-VIA-PROMPT',
    mode: 'steer',
    timeoutMs: 600_000,
  })
  check(
    /STEER-VIA-PROMPT/.test(viaPrompt.turn?.reply ?? '') && viaPrompt.timedOut !== true &&
      viaPrompt.turn?.aborted !== true,
    'session_prompt { mode: "steer" } is answered inside the running turn',
    String(viaPrompt.turn?.reply ?? '').slice(0, 50),
  )
  await callTool('session_prompt', {
    sessionId: steerSession.sessionId,
    prompt: 'Reply with exactly: AFTER-PROMPT-STEER',
    timeoutMs: 600_000,
  })
  const promptUsage = await callTool('session_usage', { sessionId: steerSession.sessionId, includeTurns: true })
  check(
    (promptUsage.sessions?.[0]?.usage?.byTurn ?? []).length === 2,
    'prompt steering did not create a turn of its own',
    `${(promptUsage.sessions?.[0]?.usage?.byTurn ?? []).length} turn(s)`,
  )
}

// --- mid-turn route switch -------------------------------------------------

/**
 * A model switch applies to the model calls that follow, including later steps of a
 * *running* turn (probed before it was documented). That produces one turn with two
 * routes, which is exactly the case per-turn `byModel` exists for: the row total says
 * what the turn cost, the split says which model charged it.
 */
async function midTurnSwitchCheck() {
  section('mid-turn route switch (real turn)')
  if (!has('session_set_model') || !has('session_usage')) {
    skip('mid-turn route switch', 'needs session_set_model and session_usage')
    return
  }
  const info = await callTool('dsh_info', { includeModels: true })
  const routes = (info.catalog?.providerModels ?? []).filter(
    (entry) => typeof entry.provider === 'string' && Array.isArray(entry.models) && entry.models.length > 0,
  )
  if (routes.length < 2) {
    skip('mid-turn route switch', 'this profile advertises fewer than two usable routes')
    return
  }
  const first = routes[0]
  const second = routes[routes.length - 1]
  const firstRoute = `${first.provider}/${first.models[0].id}`
  const secondRoute = `${second.provider}/${second.models[0].id}`
  const session = await callTool('session_create', {
    cwd: process.cwd(),
    provider: first.provider,
    model: first.models[0].id,
  })
  // The first command sleeps, so the turn is guaranteed to still be open when the
  // switch lands: without it a fast route can finish three echoes before the delay
  // elapses, and the switch would apply to a later turn instead (a flake risk the
  // assertion cannot see coming).
  const prompt = 'Run the bash command: sleep 6; echo WINDOW. '
    + 'Then reply with exactly: MID DONE.'
  const key = `mid-turn-${Date.now()}`
  await callTool('session_prompt', { sessionId: session.sessionId, prompt, idempotencyKey: key, wait: false })
  // Wait for the turn to be running on the first route, then switch mid-flight.
  await waitUntilRunning(session.sessionId)
  await callTool('session_set_model', {
    sessionId: session.sessionId,
    provider: second.provider,
    model: second.models[0].id,
  })
  const reply = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt,
    idempotencyKey: key,
    timeoutMs: 600_000,
  })
  const models = reply.turn?.models ?? []
  check(
    models.includes(firstRoute) && models.includes(secondRoute),
    'a mid-turn switch is visible in the turn models (both routes answered)',
    models.join(', '),
  )

  const usage = await callTool('session_usage', { sessionId: session.sessionId, includeTurns: true })
  const turn = (usage.sessions?.[0]?.usage?.byTurn ?? []).find((entry) => entry.turn === reply.turn?.turn)
  const split = turn?.byModel ?? []
  const splitTotal = split.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0)
  check(
    split.length === 2 &&
      split.some((entry) => `${entry.provider}/${entry.model}` === firstRoute) &&
      split.some((entry) => `${entry.provider}/${entry.model}` === secondRoute) &&
      splitTotal === turn?.totalTokens,
    'the per-turn byModel split names both routes and sums to the turn total',
    `${split.map((entry) => `${entry.model}:${entry.totalTokens}`).join(' + ')} = ${turn?.totalTokens ?? '?'}`,
  )
}

// --- model selection (real turn) -------------------------------------------

/**
 * The catalog dsh_info advertises is what session_create selects from, so create a
 * session on a real advertised route, run one turn, and check the turn reports that
 * route. When a second route exists, switch to it and confirm the next turn follows.
 */
async function modelSelectionCheck() {
  section('model selection (real turn)')
  const info = await callTool('dsh_info', { includeModels: true })
  const routes = (info.catalog?.providerModels ?? []).filter(
    (entry) => typeof entry.provider === 'string' && Array.isArray(entry.models) && entry.models.length > 0,
  )
  if (routes.length === 0) {
    skip('model selection', 'this profile advertises no model routes with includeModels')
    return
  }
  const first = routes[0]
  const firstModel = first.models[0]
  const route = `${first.provider}/${firstModel.id}`
  const session = await callTool('session_create', {
    cwd: process.cwd(),
    provider: first.provider,
    model: firstModel.id,
  })
  check(session.model === route, 'session_create selects the advertised route', session.model)

  // `reasoningEffort` is passed through to the harness selection and echoed back; it
  // costs no turn, so it can be checked before the turns this section spends.
  const effort = await attemptTool('session_set_model', {
    sessionId: session.sessionId,
    provider: first.provider,
    model: firstModel.id,
    reasoningEffort: 'high',
  })
  if (effort.ok) {
    check(
      effort.payload?.reasoningEffort === 'high' && effort.payload?.model === firstModel.id,
      'session_set_model { reasoningEffort } is applied and echoed',
      String(effort.payload?.reasoningEffort ?? 'absent'),
    )
  } else {
    skip('session_set_model { reasoningEffort }', effort.error?.slice(0, 60))
  }

  const reply = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: ROUTE OK',
    timeoutMs: 300_000,
  })
  check(
    /ROUTE OK/.test(reply.turn?.reply ?? '') && Array.isArray(reply.turn?.models) &&
      reply.turn.models.includes(route),
    'the turn reports the route it ran on',
    (reply.turn?.models ?? []).join(', '),
  )

  const second = routes.find((entry) => entry.provider !== first.provider || entry.models[0].id !== firstModel.id)
  if (second === undefined) {
    skip('routing a switch to a second model', 'this profile advertises one usable route')
    return
  }
  const secondModel = second.models[0]
  const secondRoute = `${second.provider}/${secondModel.id}`
  await callTool('session_set_model', {
    sessionId: session.sessionId,
    provider: second.provider,
    model: secondModel.id,
  })
  const switched = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: SWITCH OK',
    timeoutMs: 300_000,
  })
  check(
    /SWITCH OK/.test(switched.turn?.reply ?? '') && (switched.turn?.models ?? []).includes(secondRoute),
    'session_set_model changes the route of the next turn',
    `${(switched.turn?.models ?? []).join(', ')} (wanted ${secondRoute})`,
  )

  // The receipt is a second view of the same turns: its per-turn model list must
  // agree with what each prompt reply reported, or billing and routing disagree.
  if (has('session_usage')) {
    const receipt = await callTool('session_usage', { sessionId: session.sessionId, includeTurns: true, includeCost: true })
    const turns = receipt.sessions?.[0]?.usage?.byTurn ?? []
    const firstTurn = reply.turn?.turn
    const secondTurn = switched.turn?.turn
    const rowFor = (number) => turns.find((entry) => entry.turn === number)
    check(
      (rowFor(firstTurn)?.models ?? []).includes(route) &&
        (rowFor(secondTurn)?.models ?? []).includes(secondRoute),
      'the usage receipt agrees with each turn on its route',
      `turn ${firstTurn}: ${(rowFor(firstTurn)?.models ?? []).join(',')}; turn ${secondTurn}: ${(rowFor(secondTurn)?.models ?? []).join(',')}`,
    )

    // Tokens are the number a caller bills; the reply's per-turn receipt and the
    // session receipt must agree, and the session total must be their sum.
    const replyTokens = reply.turn?.usage?.totalTokens
    const switchedTokens = switched.turn?.usage?.totalTokens
    // The fold is ours; the harness keeps its own token projection. When both exist,
    // the receipt says whether they agreed — a live disagreement is the signal that one
    // side changed shape.
    const observed = receipt.sessions?.[0]?.usage
    check(
      observed?.verifiedAgainstProjection === true && observed?.projectionTotals === undefined,
      "the receipt's folded totals are verified against the harness's own projection",
      `verified ${String(observed?.verifiedAgainstProjection)}`,
    )

    // DSH's own price plugin, when installed, is the only source of money: the info
    // block claims costAvailable, so the receipt must actually have it.
    if (info.usage?.costAvailable === true) {
      const rowCost = receipt.sessions?.[0]?.cost
      check(
        rowCost?.available === true && typeof rowCost.costUsd === 'number' &&
          typeof rowCost.costEstimateUsd === 'number' && rowCost.source === 'dsh-cost-meter',
        'dsh_info advertises money and the receipt can price the session',
        `costUsd ${rowCost?.costUsd ?? '?'} / estimate ${rowCost?.costEstimateUsd ?? '?'}`,
      )
    }
    // `session_messages` has its own turn window; it must agree with the turn numbers
    // the prompts reported rather than trusting the same parameter name as usage.
    if (has('session_messages') && typeof firstTurn === 'number' && typeof secondTurn === 'number') {
      const laterMessages = await callTool('session_messages', {
        sessionId: session.sessionId,
        fromTurn: secondTurn,
        limit: 50,
      })
      const laterRows = laterMessages.messages ?? []
      const laterTurned = laterRows.filter((message) => typeof message.turn === 'number')
      check(
        laterTurned.length > 0 && laterTurned.every((message) => message.turn >= secondTurn) &&
          laterRows.some((message) => String(message.text ?? '').includes('SWITCH OK')),
        'session_messages { fromTurn } starts at the later turn',
        `${laterRows.length} message(s)`,
      )
      const earlierMessages = await callTool('session_messages', {
        sessionId: session.sessionId,
        toTurn: firstTurn,
        limit: 50,
      })
      const earlierRows = earlierMessages.messages ?? []
      check(
        earlierRows.length > 0 &&
          earlierRows.filter((message) => typeof message.turn === 'number')
            .every((message) => message.turn <= firstTurn) &&
          !earlierRows.some((message) => String(message.text ?? '').includes('SWITCH OK')),
        'session_messages { toTurn } stops at the earlier turn',
        `${earlierRows.length} message(s)`,
      )
    } else {
      skip('session_messages turn window', 'needs session_messages and two completed turns')
    }

    // Fork by turn boundary: the child's transcript must stop before the later turn.
    if (has('session_fork')) {
      const ambiguous = await attemptTool('session_fork', {
        sessionId: session.sessionId,
        atSeq: 1,
        atTurn: firstTurn,
      })
      check(
        ambiguous.ok === false && /not both/.test(ambiguous.error ?? ''),
        'naming both a seq and a turn for the fork cut is refused',
        ambiguous.error?.slice(0, 60),
      )
      const unknownTurn = await attemptTool('session_fork', {
        sessionId: session.sessionId,
        atTurn: 99_999,
      })
      check(
        unknownTurn.ok === false && /not in session .* log/.test(unknownTurn.error ?? '') &&
          /the turns it records are/.test(unknownTurn.error ?? ''),
        'forking at a turn the log does not record says which turns it does',
        unknownTurn.error?.slice(0, 80),
      )
      const forked = await callTool('session_fork', { sessionId: session.sessionId, atTurn: firstTurn })
      const childTranscript = await callTool('session_messages', { sessionId: forked.sessionId, limit: 50 })
      const childText = (childTranscript.messages ?? []).map((message) => String(message.text ?? '')).join('\n')
      check(
        typeof forked.atSeq === 'number' &&
          childTranscript.messages?.length > 0 &&
          !childText.includes('SWITCH OK'),
        'session_fork { atTurn } stops the child before the later turn',
        `atSeq ${forked.atSeq ?? '?'}, ${childTranscript.messages?.length ?? 0} message(s)`,
      )
    }
    const receiptTurns = (rowFor(firstTurn)?.totalTokens ?? 0) + (rowFor(secondTurn)?.totalTokens ?? 0)
    check(
      typeof replyTokens === 'number' && replyTokens === rowFor(firstTurn)?.totalTokens &&
        typeof switchedTokens === 'number' && switchedTokens === rowFor(secondTurn)?.totalTokens &&
        receiptTurns === receipt.sessions?.[0]?.usage?.totals?.totalTokens,
      'the receipt and the replies agree on each turn\'s tokens, and the total is their sum',
      `${replyTokens} + ${switchedTokens} = ${receiptTurns}`,
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
  await infoCoherenceChecks()
  await shellLimitsChecks()
  await listingImageChecks()
  await filePagingChecks()
  await promptInputChecks()
  await sessionCreateErrorChecks()
  await forkRenameChecks()
  await toolBridgeChecks()
  await workspaceChecks()
  await relativePathChecks()
  await fileEditChecks()
  await concurrencyChecks()
  await availabilityCheck()
  await secondEntryChecks()
  const sessionId = await listChecks()
  const withSubagent = flag('--with-subagent')
  if (flag('--with-model') || withSubagent) {
    if (sessionId === undefined || !has('session_prompt')) {
      skip('model-turn checks', 'needs session_prompt and a created session')
    } else {
      await progressCheck(sessionId)
      await cancellationCheck()
      await orchestrationCheck()
      await modelSelectionCheck()
      await midTurnSwitchCheck()
      await steerCheck()
      await idempotencyCheck()
      await promptImageCheck()
      await titleUsageCheck()
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
