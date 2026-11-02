#!/usr/bin/env node
/**
 * Full acceptance run against a live dsh-as-mcp endpoint.
 *
 * `smoke.mjs` answers "does this speak MCP". This answers the harder question:
 * can an outside agent actually drive a DSH instance through it — create a
 * workspace, start a session, make the DSH agent write code, read that code back
 * off disk, and run it? Every step asserts a real effect, not just a 200.
 *
 * WARNING: this creates a real session and hands a real prompt to the DSH
 * agent, which makes real LLM calls against whatever endpoint it resolves to.
 * That costs real money and leaves a real session behind — read the endpoint
 * line this script prints before anything else runs.
 *
 * It also exercises the failure paths deliberately, because a bridge that works
 * when everything is present but returns an opaque 500 when something is missing
 * is not usable from another agent: an unknown tool must be reported as an
 * unknown tool, and a missing session must say so.
 *
 *   node scripts/exercise.mjs [--url <url>] [--token <value>] [--dir <scratch>]
 *                             [--keep] [--no-color]
 *
 * Configuration, same priority as smoke.mjs — flag, then environment, then
 * default:
 *   DSH_AS_MCP_URL    endpoint URL, default http://127.0.0.1:8790/mcp
 *   DSH_AS_MCP_TOKEN  bearer token; otherwise read from
 *                     <DSH_HOME>/dsh-as-mcp/token
 *
 * Exits non-zero on the first failed expectation, after reporting every step.
 *
 * @module dsh-as-mcp/scripts/exercise
 */

import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'Full acceptance run against a live dsh-as-mcp endpoint.\n\n'
    + 'WARNING: this creates a real session and makes real LLM calls through the\n'
    + 'DSH agent — it costs real money and leaves a real session behind.\n\n'
    + '  node scripts/exercise.mjs [--url <url>] [--token <value>] [--dir <scratch>]\n'
    + '                            [--keep] [--no-color]\n\n'
    + 'Environment (same priority as smoke.mjs: flag, then env, then default):\n'
    + '  DSH_AS_MCP_URL, DSH_AS_MCP_TOKEN, DSH_HOME\n',
  )
  process.exit(0)
}

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

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv ? fromEnv : join(homedir(), '.dsh')
}

// Priority matches smoke.mjs: an explicit flag wins, then the environment
// variable, then the default — and the caller is told which one resolved
// before anything is sent, since silently landing on the default endpoint is
// exactly how a stray run once hit a real, already-running DSH instance.
const urlFromArg = option('url', undefined)
const urlFromEnv = process.env.DSH_AS_MCP_URL?.trim()
const endpoint = urlFromArg ?? urlFromEnv ?? 'http://127.0.0.1:8790/mcp'
const endpointSource = urlFromArg ? 'arg' : urlFromEnv ? 'env' : 'default'
process.stderr.write(`endpoint: ${endpoint} (${endpointSource})\n`)

const keep = flag('keep')
const useColor = process.stdout.isTTY === true && !flag('no-color')

const dim = (text) => (useColor ? `\u001b[2m${text}\u001b[0m` : text)
const green = (text) => (useColor ? `\u001b[32m${text}\u001b[0m` : text)
const red = (text) => (useColor ? `\u001b[31m${text}\u001b[0m` : text)
const bold = (text) => (useColor ? `\u001b[1m${text}\u001b[0m` : text)

let passed = 0
let failed = 0
/** Set by the `surface` section and read by every later section. */
let usageReported = true


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

let token = option('token', undefined) ?? process.env.DSH_AS_MCP_TOKEN?.trim()
let protocolVersion
let nextId = 1
let sessionHeader

if (token === undefined) {
  const path = join(resolveDshHome(), 'dsh-as-mcp', 'token')
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
  // `dsh_info` first: whether `session_usage` is part of this endpoint's surface
  // depends on the `tools.usage` setting, and an operator who turned usage off is
  // not a failed acceptance run.
  const info = await must('dsh_info')
  usageReported = info.usage?.reported !== false
  // Sorted, because `names` is sorted above — so this list must be in collation
  // order, not registration order.
  const expected = [
    'dsh_info',
    'dsh_tool_call',
    'dsh_tool_list',
    'file_edit',
    'file_list',
    'file_read',
    'file_read_image',
    'file_write',
    'session_cancel',
    'session_create',
    'session_fork',
    'session_list',
    'session_messages',
    'session_prompt',
    'session_queue',
    'session_rename',
    'session_search',
    'session_set_model',
    'session_tool_result',
    ...(usageReported ? ['session_usage'] : []),
    'shell_kill',
    'shell_list',
    'shell_output',
    'shell_run',
    'shell_start',
    'workspace_create',
    'workspace_delete',
    'workspace_list',
  ]
  check(
    JSON.stringify(names) === JSON.stringify(expected),
    usageReported ? 'tools/list exposes all 28 tools' : 'tools/list exposes all 27 tools (usage reporting off)',
    `${names.length} tools`,
  )
  check(
    tools.every((entry) => typeof entry.description === 'string' && entry.description.length > 20),
    'every tool is described',
  )

  // Data-returning tools advertise an object output schema, so schema-aware
  // clients can consume structuredContent.
  const structured = tools.filter((entry) =>
    ['dsh_info', 'session_list', 'file_list', 'workspace_list'].includes(entry.name))
  check(
    structured.length > 0 &&
      structured.every((entry) => entry.outputSchema?.type === 'object'),
    'data tools advertise an output schema',
    structured.map((entry) => `${entry.name}:${entry.outputSchema?.type ?? 'none'}`).join(', '),
  )

  // Mount-only deployments (`enabled: false`, `mountOnWebServer: true`) report
  // listening=false by design; what must be true is that the endpoint says where
  // it actually lives.
  check(
    info.listening === true || info.mountedOnDshWebServer === true,
    'endpoint reports where it is served',
    `listening=${info.listening === true} mounted=${info.mountedOnDshWebServer === true}`,
  )

  // --- protocol contract -----------------------------------------------------
  // What a generic MCP client relies on before any tool runs: a parse error, a
  // method-not-found, a challenge it can act on, and a bounded body.
  const unauthHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const parseFailure = await fetch(endpoint, { method: 'POST', headers: { ...unauthHeaders, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, body: '{not json' })
  const parseBody = await parseFailure.text()
  check(
    parseFailure.status === 400 && parseBody.includes('-32700'),
    'malformed JSON is answered with a parse error',
    `HTTP ${parseFailure.status}`,
  )

  const unknownMethod = await post({ jsonrpc: '2.0', id: 9_001, method: 'no/such-method', params: {} })
  const unknownText = await unknownMethod.text()
  check(unknownMethod.ok && unknownText.includes('-32601'), 'an unknown method is method-not-found', `HTTP ${unknownMethod.status}`)

  const denied = await fetch(endpoint, { method: 'POST', headers: unauthHeaders, body: '{}' })
  check(
    denied.status === 401 && (denied.headers.get('www-authenticate') ?? '').toLowerCase().includes('bearer'),
    'a missing token challenges with WWW-Authenticate: Bearer',
    `HTTP ${denied.status}`,
  )

  const endpointUrl = new URL(endpoint)
  const oversizeStatus = await new Promise((resolve) => {
    const attempt = httpRequest({
      host: endpointUrl.hostname,
      port: endpointUrl.port,
      path: endpointUrl.pathname,
      method: 'POST',
      headers: { ...unauthHeaders, 'content-length': String(999 * 1024 * 1024) },
    }, (response) => { resolve(response.statusCode); response.resume() })
    attempt.on('error', (error) => resolve(`error: ${error.message}`))
    attempt.end()
  })
  check(oversizeStatus === 413, 'a declared oversized body is refused before it is read', `HTTP ${oversizeStatus}`)

  // Model discovery is opt-in and per-provider guarded; when it does answer, the
  // shape must be a list of {provider, models[]}.
  const withModels = await must('dsh_info', { includeModels: true })
  const providerModels = withModels.catalog?.providerModels
  check(
    providerModels === undefined ||
      (Array.isArray(providerModels) &&
        providerModels.every((entry) => typeof entry.provider === 'string' && Array.isArray(entry.models))),
    'dsh_info includeModels returns per-provider model lists',
    providerModels === undefined ? 'not reported' : `${providerModels.length} routes`,
  )
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
  check(wanted.length === 0, 'all five core tool groups are enabled', Object.keys(groups).join(', '))
  check(
    usageReported === (groups.usage === true),
    usageReported ? 'usage reporting is enabled' : 'usage reporting is off by configuration',
    `usage=${groups.usage === true}`,
  )
  if (usageReported) {
    check(
      info.usage?.tokensReadable === true,
      'the session log is readable for token usage',
      `cost meter: ${info.usage?.costAvailable === true ? 'present' : 'absent'}`,
    )
  }
  const services = info.harnessServices ?? {}
  for (const service of ['workspaceRegistry', 'sessionController', 'agents', 'fs', 'shell', 'tools']) {
    check(services[service] === true, `harness service: ${service}`)
  }

  check(typeof info.version === 'string' && info.version !== '', 'dsh_info reports the plugin version', info.version)
  // The catalog is the answer to "what may I pass to session_create?" — a profile
  // that mounts a catalog service must list something, and an entry that could not
  // be read is named rather than silently absent.
  const catalog = info.catalog
  check(catalog !== undefined, 'dsh_info reports a catalog')
  if (catalog !== undefined) {
    check(
      Array.isArray(catalog.unavailable) === false ||
        catalog.unavailable.every((entry) => typeof entry === 'string'),
      'catalog.unavailable is a list of reasons',
      Array.isArray(catalog.unavailable) ? catalog.unavailable.join('; ') : 'none',
    )
    if (services.llm === true) {
      check(
        Array.isArray(catalog.providers) && catalog.providers.length > 0,
        'catalog lists provider routes',
        Array.isArray(catalog.providers) ? `${catalog.providers.length} providers` : 'absent',
      )
    }
    if (services.agentPresets === true) {
      check(
        Array.isArray(catalog.agentPresets) && catalog.agentPresets.length > 0,
        'catalog lists agent presets',
        Array.isArray(catalog.agentPresets) ? `${catalog.agentPresets.length} presets` : 'absent',
      )
    }
    if (services.sandboxPolicy === true) {
      check(
        typeof catalog.sandboxMode === 'string' && catalog.sandboxMode !== '',
        'catalog reports the effective sandbox mode',
        catalog.sandboxMode,
      )
    }
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
// The last `session_prompt` reply, kept so the usage section can compare the
// receipt against the cumulative block the reply already reported.
let lastPrompt

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

  // Model selection failures must name the route and how to discover good ones.
  const badRoute = await tool('session_create', { cwd: projectPath, provider: 'nope-provider', model: 'nope-model' })
  check(
    badRoute.ok && /not a registered provider route/.test(badRoute.payload?.modelSelectionError ?? ''),
    'a bad model route is reported, not silently ignored',
    (badRoute.payload?.modelSelectionError ?? '').slice(0, 60),
  )
  const badRouteSession = badRoute.payload?.sessionId
  const badSetModel = await tool('session_set_model', { sessionId: badRouteSession, provider: 'nope-provider', model: 'nope-model' })
  check(
    !badSetModel.ok && /known routes/.test(badSetModel.error ?? '') && /includeModels/.test(badSetModel.error ?? ''),
    'a bad session_set_model names the known routes and how to list models',
    (badSetModel.error ?? '').slice(0, 60),
  )


    const listed = await must('session_list', { limit: 50 })
    check(
      (listed.sessions ?? []).some((entry) => (entry.sessionId ?? entry.id) === sessionId),
      'the session appears in session_list',
      `${(listed.sessions ?? []).length} sessions`,
    )

    // Titles are opt-in (one log read per session); the shape must not change when
    // they are asked for, and a title that cannot be folded must not drop the row.
    const titled = await must('session_list', { limit: 50, includeTitle: true })
    const titledRow = (titled.sessions ?? []).find((entry) => (entry.sessionId ?? entry.id) === sessionId)
    check(
      titledRow !== undefined,
      'session_list includeTitle keeps the session rows',
      titledRow?.title === undefined ? 'no title yet' : `title: ${titledRow.title}`,
    )

    // Filters run before the limit, so "my sessions in this directory" is the whole
    // answer rather than whichever page happened to be recent.
    const filtered = await must('session_list', { limit: 50, cwd: projectPath })
    check(
      (filtered.sessions ?? []).some((entry) => (entry.sessionId ?? entry.id) === sessionId),
      'session_list filters by workspace directory',
      `${(filtered.sessions ?? []).length} sessions`,
    )
    // A bare list cannot distinguish "all of them" from "the first page": `total`
    // counts the matches and `truncated` says the limit hid some.
    const page = await must('session_list', { limit: 1, cwd: projectPath })
    check(
      page.sessions?.length === 1 && page.total >= 1 && page.truncated === (page.total > 1),
      'session_list reports total and truncation',
      `${page.sessions?.length ?? 0} of ${page.total ?? '?'}`,
    )

    // Unregistering is idempotent and leaves the directory alone, so a harness can
    // clean up the workspaces it created for a task.
    const throwawayPath = join(scratch, 'throwaway-workspace')
    const throwaway = await must('workspace_create', { path: throwawayPath })
    const deleted = await must('workspace_delete', { workspaceId: throwaway.workspace?.id ?? throwaway.id })
    check(deleted.deleted === true, 'workspace_delete unregisters a workspace', throwawayPath)
    const afterDelete = await must('workspace_delete', { workspaceId: throwaway.workspace?.id ?? throwaway.id })
    check(afterDelete.deleted === false, 'workspace_delete is idempotent')
    check(existsSync(throwawayPath), 'workspace_delete leaves the directory on disk', throwawayPath)
    const listedAfter = await must('workspace_list')
    check(
      !(listedAfter.workspaces ?? []).some((entry) => entry.id === (throwaway.workspace?.id ?? throwaway.id)),
      'the workspace is gone from workspace_list',
    )

    // A name from the caller must be the name the UI shows: rename, then read it
    // back through the title fold.
    const wanted = 'exercise: named by the MCP caller'
    const renamed = await must('session_rename', { sessionId, title: wanted })
    check(renamed.title === wanted, 'session_rename accepts the title', renamed.title)
    const afterRename = await must('session_list', { limit: 50, includeTitle: true })
    const renamedRow = (afterRename.sessions ?? []).find((entry) => (entry.sessionId ?? entry.id) === sessionId)
    check(
      renamedRow?.title === wanted,
      'the renamed title comes back through session_list',
      renamedRow?.title,
    )

    // A retried message must not run twice: same key, same content, replayed turn.
    const retryKey = 'exercise-retry-1'
    const firstTry = await must('session_prompt', {
      sessionId,
      prompt: 'Reply with exactly: retry marker',
      idempotencyKey: retryKey,
      timeoutMs: 180_000,
    })
    const replay = await must('session_prompt', {
      sessionId,
      prompt: 'Reply with exactly: retry marker',
      idempotencyKey: retryKey,
      timeoutMs: 180_000,
    })
    check(replay.replayed === true, 'a retried idempotency key replays instead of re-sending')
    check(
      replay.turn?.reply === firstTry.turn?.reply,
      'the replay returns the same answer',
      `${(replay.turn?.reply ?? '').slice(0, 40)}`,
    )
    const mismatch = await tool('session_prompt', {
      sessionId,
      prompt: 'This is different content under the same key.',
      idempotencyKey: retryKey,
      timeoutMs: 30_000,
    })
    check(
      mismatch.ok === false && /reused for different content/.test(mismatch.error ?? ''),
      'reusing a key for different content is refused',
      mismatch.error?.slice(0, 80),
    )

    // Queue with wait:false, then retry the same key without it: the retry awaits
    // the queued turn rather than sending a second prompt.
    const awaitKey = 'exercise-await-1'
    await must('session_prompt', {
      sessionId,
      prompt: 'Reply with exactly: await marker',
      idempotencyKey: awaitKey,
      wait: false,
      timeoutMs: 180_000,
    })
    const awaited = await must('session_prompt', {
      sessionId,
      prompt: 'Reply with exactly: await marker',
      idempotencyKey: awaitKey,
      timeoutMs: 240_000,
    })
    const awaitMessages = await must('session_messages', { sessionId, limit: 100, role: 'user' })
    const awaitPrompt = (awaitMessages.messages ?? []).filter(
      (message) => String(message.text ?? '').includes('await marker'),
    )
    check(
      awaited.replayed === true && /await marker/i.test(awaited.turn?.reply ?? '') &&
        awaitPrompt.length === 1 && awaitPrompt[0]?.requestId === `dsh-as-mcp-idem-${awaitKey}`,
      'a queue-then-retry awaits the queued turn without re-sending it',
      `${awaitPrompt.length} prompt(s), requestId ${String(awaitPrompt[0]?.requestId ?? 'absent').slice(-20)}`,
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
    lastPrompt = outcome
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

    // Tool-call arguments are summarised by default: the byte count is reported
    // but the arguments are not echoed, because an agent's file_write carries the
    // whole file and duplicating it would dominate the caller's context.
    check(
      (turn.toolCalls ?? []).every((call) => typeof call.argumentsBytes === 'number' && call.arguments === undefined),
      'tool calls are summarised by default',
      `${(turn.toolCalls ?? []).filter((call) => call.arguments !== undefined).length} with raw arguments`,
    )
    check(
      Array.isArray(turn.models) && turn.models.length > 0 && turn.models.every((route) => route.includes('/')),
      'the reply names the model route that answered',
      (turn.models ?? []).join(', '),
    )
    // Tokens say what the turn cost; durationMs says how long the caller waited for
    // it, which is what a timeout is tuned against.
    check(
      typeof turn.durationMs === 'number' && turn.durationMs >= 0 && turn.durationMs < 300_000,
      'the turn receipt includes its wall-clock duration',
      `${turn.durationMs ?? '?'} ms`,
    )
    // `full` returns them on request, still bounded.
    const full = await must('session_prompt', {
      sessionId,
      prompt: 'Run `echo tool-args-check` with your shell tool, then say done.',
      toolCalls: 'full',
      maxArgumentChars: 200,
      timeoutMs: 180_000,
    })
    const fullCalls = full.turn?.toolCalls ?? []
    check(
      fullCalls.some((call) => typeof call.arguments === 'string'),
      'toolCalls: full returns the arguments',
      `${fullCalls.length} calls`,
    )
    check(existsSync(codePath), 'the file really exists on disk', codePath)

    // Usage rides the reply: the turn's own tokens, and the session total so far.
    const turnUsage = turn.usage
    if (usageReported) {
      check(
        turnUsage !== undefined && turnUsage.totalTokens > 0,
        'the reply reports the turn token usage',
        turnUsage === undefined ? 'absent' : `${turnUsage.totalTokens} tokens, ${turnUsage.steps} steps`,
      )
      const buckets = turnUsage === undefined
        ? 0
        : turnUsage.uncachedInputTokens + turnUsage.cacheReadTokens
          + turnUsage.cacheWriteTokens + turnUsage.outputTokens
      check(
        turnUsage !== undefined && buckets === turnUsage.totalTokens,
        'the bucket total adds up',
        turnUsage === undefined ? 'absent' : `${buckets} == ${turnUsage.totalTokens}`,
      )
      const cumulative = outcome.session?.usage
      check(
        cumulative !== undefined && cumulative.totals.totalTokens >= turnUsage.totalTokens,
        'the reply reports the session total',
        cumulative === undefined ? 'absent' : `${cumulative.totals.totalTokens} tokens`,
      )
      check(
        typeof cumulative?.verifiedAgainstProjection === 'boolean',
        'the session total says whether the harness projection agreed',
        cumulative?.verifiedAgainstProjection === true ? 'verified' : 'unverified',
      )
    }
  }

  section('usage accounting')
  if (usageReported) {
    // The explicit receipt. Equality with the reply's cumulative block is the
    // check that matters: a calling harness reads one or the other, never both,
    // and the two must not disagree about what the session spent.
    // Per-project spend in one call: every session whose workspace is this
    // directory, with the limit/empty cases explained in notes.
    const workspaceUsage = await must('session_usage', { cwd: projectPath })
    check(
      workspaceUsage.scope === 'workspace' &&
        (workspaceUsage.sessions ?? []).some((row) => row.sessionId === sessionId) &&
        workspaceUsage.totals.totalTokens > 0,
      'session_usage totals a workspace directory',
      `${(workspaceUsage.sessions ?? []).length} session(s), ${workspaceUsage.totals.totalTokens} tokens`,
    )

    const batch = await must('session_usage', { sessionIds: [sessionId, sessionId] })
    check(
      batch.scope === 'sessionIds' && (batch.sessions ?? []).length === 1 && batch.totals.totalTokens > 0,
      'session_usage accepts a batch of ids and collapses duplicates',
      `${(batch.sessions ?? []).length} rows, ${batch.totals.totalTokens} tokens`,
    )

    const receipt = await must('session_usage', { sessionId, includeTurns: true })
    check(receipt.scope === 'session', 'session_usage scopes to the session', String(receipt.scope))
    check(
      receipt.sessions?.some((row) => row.sessionId === sessionId && row.origin === 'self'),
      'the session appears as its own row',
      `${receipt.sessions?.length ?? 0} row(s)`,
    )
    check(
      receipt.totals?.totalTokens > 0,
      'the receipt totals the tokens',
      `${receipt.totals?.totalTokens} tokens, ${receipt.totals?.turns} turn(s)`,
    )
    const replyTotals = lastPrompt?.session?.usage?.totals?.totalTokens
    check(
      replyTotals === undefined || receipt.totals?.totalTokens >= replyTotals,
      'the receipt is at least the total the last reply reported',
      `receipt ${receipt.totals?.totalTokens} vs reply ${replyTotals}`,
    )
    const own = receipt.sessions?.find((row) => row.origin === 'self')
    check(
      (own?.usage?.byTurn?.length ?? 0) > 0,
      'includeTurns returns the per-turn breakdown',
      `${own?.usage?.byTurn?.length ?? 0} turn(s)`,
    )
    check(
      typeof receipt.cost?.available === 'boolean',
      'the receipt states whether money is available',
      receipt.cost?.available === true ? `${receipt.cost.costUsd} USD (estimate)` : receipt.cost?.reason ?? 'no reason given',
    )

    // Money is one ledger read per row, so a wide scan can opt out; the report
    // must say that is why the amount is missing, not pretend no price source.
    const unprimed = await must('session_usage', { sessionId, includeCost: false })
    check(
      unprimed.cost?.available === false && /includeCost/.test(unprimed.cost?.reason ?? ''),
      'includeCost: false skips pricing and says so',
      unprimed.cost?.reason ?? 'no reason given',
    )
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

    // Paging: a slice read from an offset must be the tail, and must report the
    // window it actually read rather than implying the whole file.
    const tail = await must('file_read', { path, offset: 8 })
    check(
      (tail.text ?? '') === 'over MCP\n' && tail.offset === 8 && tail.truncated !== true,
      'file_read offset returns the requested window',
      `${JSON.stringify(tail.text)} at ${tail.offset}`,
    )
    // A byte-bounded read of the middle of a file reports what it cut and where to
    // continue; a caller paging large files relies on both.
    const window = await must('file_read', { path, maxBytes: 4 })
    check(
      (window.text ?? '') === 'writ' && window.truncated === true && window.nextOffset === 4,
      'file_read maxBytes reports truncated and nextOffset',
      `${JSON.stringify(window.text)} next=${window.nextOffset}`,
    )

    // file_edit: a literal replacement without re-sending the file each way, and
    // an ambiguous match that must be refused rather than guessed at.
    const edited = await must('file_edit', { path, oldText: 'written over MCP', newText: 'edited over MCP' })
    check(edited.replacements === 1, 'file_edit replaces one unique match', `${edited.replacements} replacement(s)`)
    check(
      (await readFile(path, 'utf8')) === 'edited over MCP\n',
      'file_edit wrote the replacement to disk',
    )
    const ambiguous = await tool('file_edit', { path, oldText: 'ed', newText: 'X' })
    check(
      ambiguous.ok === false && /matches \d+ times/.test(ambiguous.error ?? ''),
      'file_edit refuses an ambiguous match',
      ambiguous.error ?? 'no error payload',
    )

    // An image round-trip: write a real 1x1 PNG and read it back through the
    // image tool, so the MCP image block is exercised, not just described.
    const pngPath = join(projectPath, 'pixel.png')
    const pngScript = `require('node:fs').writeFileSync(${JSON.stringify(pngPath)}, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))`
    const madePng = await tool('shell_run', { command: `node -e ${JSON.stringify(pngScript)}`, timeoutMs: 30_000 })
    check(madePng.ok, 'a test image can be written', madePng.error ?? pngPath)
    const image = await must('file_read_image', { path: pngPath })
    check(image.mimeType === 'image/png', 'file_read_image sniffs the mime type', image.mimeType)
    check((image.bytes ?? 0) > 0, 'file_read_image reports the byte count', `${image.bytes} bytes`)

    // The format comes from the bytes, not the extension: a text file named .png
    // must be refused with the supported list rather than carried as an image.
    const fakePng = join(projectPath, 'not-really.png')
    await writeFile(fakePng, 'this is plain text\n')
    const notImage = await tool('file_read_image', { path: fakePng })
    check(
      notImage.ok === false && /not an image/.test(notImage.error ?? '') && /png/.test(notImage.error ?? ''),
      'file_read_image sniffs the bytes, not the extension',
      (notImage.error ?? '').slice(0, 60),
    )

    // The same picture pasted into a prompt: the agent must be able to see it.
    const vision = await tool('session_prompt', {
      sessionId,
      prompt: 'The attached image is a single square pixel. Reply with exactly: image seen',
      images: [{ path: pngPath }],
      timeoutMs: 180_000,
    })
    check(
      vision.ok && /image seen/i.test(vision.payload?.turn?.reply ?? ''),
      'session_prompt attaches an image the agent can see',
      vision.ok ? (vision.payload?.turn?.reply ?? '').slice(0, 60) : vision.error,
    )

    const walked = await must('file_list', { path: projectPath, recursive: true })
    check(
      (walked.entries ?? []).some((entry) => entry.name === 'fizzbuzz.mjs' && entry.path === 'fizzbuzz.mjs'),
      'file_list recursive reports relative paths',
      `${(walked.entries ?? []).length} entries`,
    )

    // A symlink pointing at its own ancestor must be listed, not followed: a walk
    // that recurses into it never ends, and the endless walk is the bug users hit.
    const loopDir = join(projectPath, 'loop-dir')
    await mkdir(loopDir, { recursive: true })
    await symlink(projectPath, join(loopDir, 'back'))
    const loopWalk = await Promise.race([
      must('file_list', { path: projectPath, recursive: true }),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 5_000)),
    ])
    check(
      loopWalk !== undefined && (loopWalk.entries ?? []).some((entry) => entry.path === 'loop-dir/back'),
      'file_list terminates on a symlink loop instead of following it',
      loopWalk === undefined ? 'timed out' : `${(loopWalk.entries ?? []).length} entries`,
    )
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

    // Background jobs: start, poll, collect, and stop. This is what keeps a long
    // build from holding one MCP call open.
    const job = await must('shell_start', { command: 'sh -c "echo started; sleep 0.3; echo finished"' })
    check(typeof job.jobId === 'string', 'shell_start returns a job id', job.jobId)
    let collected = ''
    let page
    for (let attempt = 0; attempt < 40; attempt += 1) {
      page = await must('shell_output', { jobId: job.jobId })
      collected += page.output ?? ''
      if (page.done) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    check(
      collected.includes('started') && collected.includes('finished'),
      'shell_output collects the job output',
      `${collected.length} bytes`,
    )
    check(page?.done === true && page.exitCode === 0, 'shell_output reports the job finished', `exit ${page?.exitCode}`)
    // Each byte is delivered once: a polling loop that reads after the job ended
    // must not see the output twice.
    const reread = await must('shell_output', { jobId: job.jobId })
    check(
      (reread.output ?? '') === '' && reread.done === true,
      'shell_output does not re-deliver output already read',
      `${(reread.output ?? '').length} bytes`,
    )
    const listed = await must('shell_list', {})
    check(
      (listed.jobs ?? []).some((entry) => entry.jobId === job.jobId),
      'shell_list includes the job',
      `${(listed.jobs ?? []).length} jobs`,
    )
    // Settled jobs accumulate; a caller that wants the live ones can filter.
    const onlyRunning = await must('shell_list', { running: true })
    check(
      !(onlyRunning.jobs ?? []).some((entry) => entry.jobId === job.jobId),
      'shell_list can filter to running jobs',
      `${(onlyRunning.jobs ?? []).length} running`,
    )

    const doomed = await must('shell_start', { command: 'sleep 30' })
    const stopped = await must('shell_kill', { jobId: doomed.jobId })
    check(stopped.killed === true && stopped.status === 'killed', 'shell_kill stops a running job', stopped.status)
  }

  section('fork')
  {
    // Forking copies the conversation prefix, so the child continues the same
    // context for the price of one turn instead of a replay.
    const forked = await must('session_fork', { sessionId })
    check(
      typeof forked.sessionId === 'string' && forked.sessionId !== sessionId,
      'session_fork returns a child session id',
      forked.sessionId,
    )
    check(forked.parentSessionId === sessionId, 'the child names its parent')
    check(
      (forked.inheritedEventCount ?? 0) > 0,
      'the child inherited the parent history',
      `${forked.inheritedEventCount} events`,
    )

    if (usageReported) {
      const childUsage = await must('session_usage', { sessionId: forked.sessionId })
      const inherited = childUsage.sessions?.[0]?.usage?.inherited?.totalTokens ?? 0
      check(inherited > 0, 'usage separates the inherited prefix from the child\'s own spend', `${inherited} inherited tokens`)
    }

    const childReply = await must('session_prompt', {
      sessionId: forked.sessionId,
      prompt: 'Reply with exactly: fork works',
      timeoutMs: 120_000,
    })
    check(
      /fork works/i.test(childReply.turn?.reply ?? ''),
      'the forked session continues the conversation',
      (childReply.turn?.reply ?? 'no reply').slice(0, 60),
    )

    const listed = await must('session_list', { limit: 50 })
    check(
      (listed.sessions ?? []).some((entry) => entry.sessionId === forked.sessionId),
      'the child appears in session_list',
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

    // Content search: find the session by something it said, without activating it.
    // Search is opt-in in shipped compositions (`session-query` ships with
    // `openAt: "never"`), so a disabled index must be reported with the fix, not
    // read as a broken search.
    const search = await tool('session_search', { query: 'FizzBuzz' })
    if (search.ok) {
      // Matches are relevance-ordered and capped at 20, so our own session is not
      // guaranteed to be on the first page; what must hold is that the search
      // answered with matches and said whether more exist. Under session.scope
      // "owned" a page can consist entirely of filtered foreign matches, in which
      // case `hidden` says so — that is a correct answer, not an empty search.
      const matches = search.payload?.items ?? []
      const hidden = search.payload?.hidden ?? 0
      const shapeOk = matches.every(
        (item) => typeof item.sessionId === 'string' && typeof item.snippet === 'string',
      )
      check(
        shapeOk && typeof search.payload?.hasMore === 'boolean' &&
          (matches.length > 0
            ? matches.some((item) => item.sessionId === sessionId) || search.payload?.hasMore === true
            : hidden > 0 && search.payload?.hasMore === true),
        'session_search answers with matches and hasMore',
        `${matches.length} match(es), hidden=${hidden}, hasMore=${search.payload?.hasMore}`,
      )
    } else {
      check(
        /openAt/.test(search.error ?? '') && /first-search|startup/.test(search.error ?? ''),
        'a disabled session-search index reports how to enable it',
        (search.error ?? '').slice(0, 60),
      )
    }

    // The tail window keeps the newest messages; `total` says how many matched, so
    // a poll that missed older ones can tell.
    const head = await must('session_messages', { sessionId, limit: 1 })
    check(
      head.messages?.length === 1 && head.total >= 1 && head.truncated === (head.total > 1),
      'session_messages reports total and truncation',
      `${head.messages?.length ?? 0} of ${head.total ?? '?'}`,
    )

    // Per-message caps are opt-in; when asked for, the cut is reported rather than
    // looking like a complete message.
    const capped = await must('session_messages', { sessionId, limit: 50, maxCharsPerMessage: 20 })
    const cappedMessages = capped.messages ?? []
    check(
      cappedMessages.length > 0 && cappedMessages.every((entry) => entry.text.length <= 20),
      'maxCharsPerMessage caps every message',
      `${cappedMessages.length} messages`,
    )
    check(
      cappedMessages.some((entry) => entry.truncated === true && entry.chars > entry.text.length),
      'a cut message reports truncated and its original length',
    )

    // Tool calls are the other half of what a polling caller wants to see: the
    // transcript text says "I'll run it", the call list says what ran.
    const withCalls = await must('session_messages', { sessionId, limit: 100, includeToolCalls: true })
    const calls = (withCalls.messages ?? []).flatMap((entry) => entry.toolCalls ?? [])
    const completed = calls.filter((entry) => typeof entry.resultChars === 'number')
    check(
      calls.length > 0 &&
        calls.every((entry) => typeof entry.name === 'string' && typeof entry.argumentsChars === 'number') &&
        (withCalls.messages ?? []).every((entry) => entry.role !== 'user' || entry.toolCalls === undefined) &&
        completed.length > 0,
      'session_messages reports the model tool calls (and completed result sizes) when asked',
      `${calls.length} call(s), ${completed.length} with results`,
    )

    // One read can carry the whole timeline when asked: tool results appear as their
    // own rows (callId + text + error), capped per message like any other row.
    const withResults = await must('session_messages', {
      sessionId,
      limit: 200,
      includeToolResults: true,
      maxCharsPerMessage: 120,
    })
    const toolRows = (withResults.messages ?? []).filter((entry) => entry.role === 'tool')
    check(
      toolRows.length > 0 &&
        toolRows.every((entry) => typeof entry.callId === 'string' && typeof entry.text === 'string' &&
          entry.text.length <= 120 && typeof entry.seq === 'number'),
      'session_messages can include tool results as their own rows',
      `${toolRows.length} result row(s)`,
    )

    // The call list reports sizes; one lookup fetches the text of a single result,
    // which is what debugging a failure actually needs.
    const withResult = calls.find((entry) => typeof entry.resultChars === 'number' && entry.resultChars > 0)
    if (withResult?.id !== undefined) {
      const fetched = await must('session_tool_result', { sessionId, callId: withResult.id, maxChars: 200 })
      check(
        typeof fetched.text === 'string' && fetched.chars === withResult.resultChars && fetched.text.length <= 200,
        'session_tool_result returns the recorded result text',
        `${fetched.chars} chars`,
      )
      const tail = await must('session_tool_result', {
        sessionId, callId: withResult.id, maxChars: 40, from: 'end',
      })
      check(
        tail.from === 'end' && tail.truncated === true &&
          fetched.text.slice(-40) === tail.text,
        'session_tool_result can return the tail of a long result',
        `${tail.text.length} chars from the end`,
      )
      const byName = await must('session_tool_result', {
        sessionId, toolName: withResult.name, maxChars: 200,
      })
      check(
        typeof byName.callId === 'string' && byName.name === withResult.name &&
          typeof byName.text === 'string' && byName.text.length <= 200,
        'session_tool_result also resolves the latest call by tool name',
        `${byName.callId.slice(0, 12)}…`,
      )
    } else {
      check(true, 'session_tool_result skipped (no completed call with text)', '')
    }

    // Backwards paging: without it a transcript longer than the 500-message
    // window would be unreachable past the tail.
    const tail = await must('session_messages', { sessionId, limit: 2 })
    const tailMessages = tail.messages ?? []
    if (tailMessages.length === 2) {
      const before = tailMessages[0].seq
      const older = await must('session_messages', { sessionId, limit: 2, beforeSeq: before })
      const olderMessages = older.messages ?? []
      check(
        olderMessages.every((entry) => entry.seq < before) &&
          olderMessages.length + 2 <= tail.total &&
          older.total === tail.total - 2,
        'session_messages pages backwards with beforeSeq',
        `${olderMessages.length} older, ${older.total} in that window`,
      )
    } else {
      check(true, 'beforeSeq paging skipped (transcript shorter than 3 messages)', `${tailMessages.length} messages`)
    }

    // The pending queue is a live projection, not transcript events: listing it
    // must either answer with rows or say why this profile cannot see them.
    const queue = await must('session_queue', { sessionId })
    check(
      Array.isArray(queue.queued) && (queue.note === undefined || typeof queue.note === 'string'),
      'session_queue lists the pending inbox or explains it cannot',
      `${queue.queued?.length ?? 0} queued${queue.note === undefined ? '' : ' (note)'}`,
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
    // The schema marks the argument required, so this is rejected before the
    // driver runs — which is the point: it fails loudly instead of returning `[]`,
    // an empty toolbox that would read as "nothing is permitted". The *reason* a
    // session is needed lives in the tool description, where a client reads it
    // before calling rather than only after getting it wrong.
    check(
      /sessionId/i.test(unscoped.error ?? ''),
      'and names the argument rather than returning an empty list',
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
    check(
      typeof read.payload?.resultBytes === 'number' && read.payload.resultBytes > 0,
      'the result reports its size',
      `${read.payload?.resultBytes} bytes`,
    )
    // An agent tool can return a whole file; the cap is what keeps one call from
    // flooding the caller's context, and the reply must say it was cut.
    const cut = await tool('dsh_tool_call', {
      name: 'read',
      args: { file_path: target },
      sessionId,
      maxResultChars: 100,
    })
    check(
      cut.ok && cut.payload?.truncated === true &&
        typeof cut.payload?.text === 'string' && cut.payload.text.length <= 100,
      'maxResultChars caps the result and says so',
      cut.ok ? `${cut.payload?.text?.length ?? 0} chars of ${cut.payload?.resultBytes ?? '?'} bytes` : cut.error,
    )

    // A timeout of our own is reported as ours: the harness calls any abort a
    // "tool call aborted", which does not say that the timeoutMs deadline fired.
    const timedTool = await tool('dsh_tool_call', {
      name: 'bash',
      args: { command: 'sleep 5; echo done', description: 'acceptance timeout probe' },
      sessionId,
      timeoutMs: 900,
    })
    check(
      !timedTool.ok && /timeoutMs elapsed/.test(timedTool.error ?? '') &&
        (!timedTool.payload || timedTool.payload.ok === false),
      'a dsh_tool_call timeout names the deadline that fired',
      (timedTool.error ?? '').slice(0, 60),
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

    // --- error paths ---------------------------------------------------------
    // Bad input must come back as an actionable error, not a crash or a happy
    // zero: a caller that mistypes an id would otherwise under-bill its run.
    const ghostSession = 'session-does-not-exist'
    const ghostPrompt = await tool('session_prompt', { sessionId: ghostSession, prompt: 'hi' })
    check(
      !ghostPrompt.ok && /not found|not created by this endpoint/.test(ghostPrompt.error ?? ''),
      'an unknown session is reported, not run',
      (ghostPrompt.error ?? '').slice(0, 60),
    )

    const ghostMessages = await tool('session_messages', { sessionId: ghostSession })
    check(
      !ghostMessages.ok && /not found|not created by this endpoint/.test(ghostMessages.error ?? ''),
      'transcript reads name the unknown session',
      (ghostMessages.error ?? '').slice(0, 60),
    )

    const ghostUsage = await tool('session_usage', { sessionIds: [ghostSession] })
    if (ghostUsage.ok) {
      check(
        ghostUsage.payload?.sessions?.[0]?.error !== undefined && ghostUsage.payload?.totals?.totalTokens === 0 &&
          (ghostUsage.payload?.notes ?? []).some((note) => /could not be read/.test(note)),
        'an unknown id yields a row error and says the totals exclude it',
        (ghostUsage.payload?.sessions?.[0]?.error ?? '').slice(0, 60),
      )
    } else {
      // Under session.scope "owned" a foreign id is refused before it is read.
      check(
        /not created by this endpoint/.test(ghostUsage.error ?? ''),
        'an unreadable id is refused with a legible reason',
        (ghostUsage.error ?? '').slice(0, 60),
      )
    }

    const missingRead = await tool('file_read', { sessionId, path: join(projectPath, 'definitely-absent.txt') })
    check(!missingRead.ok && /not found/.test(missingRead.error ?? ''), 'a missing file is reported with its path', (missingRead.error ?? '').slice(0, 60))

    const fileAsWorkspace = await tool('workspace_create', { path: join(projectPath, 'fizzbuzz.mjs') })
    check(
      !fileAsWorkspace.ok && /not a directory/.test(fileAsWorkspace.error ?? ''),
      'registering a file as a workspace explains why instead of echoing mkdir',
      (fileAsWorkspace.error ?? '').slice(0, 60),
    )

    const ghostJob = await tool('shell_kill', { jobId: 'no-such-job' })
    check(!ghostJob.ok && /unknown background job/.test(ghostJob.error ?? ''), 'an unknown job id is named', (ghostJob.error ?? '').slice(0, 60))

    const emptySession = await must('session_create', { cwd: projectPath, title: 'empty-fork-source' })
    const emptyId = emptySession.sessionId ?? emptySession.id
    const emptyFork = await tool('session_fork', { sessionId: emptyId })
    check(!emptyFork.ok && /no completed turn/.test(emptyFork.error ?? ''), 'forking an empty session says why', (emptyFork.error ?? '').slice(0, 60))

    // After every failure above, the endpoint must still serve.
    const stillHealthy = await must('dsh_info')
    check(stillHealthy.version !== undefined, 'the endpoint survives a barrage of bad calls', stillHealthy.version)
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
