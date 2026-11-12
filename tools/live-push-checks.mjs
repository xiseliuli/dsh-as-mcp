#!/usr/bin/env node
/**
 * Live checks for the server-push surface and both MCP transports.
 *
 * `tools/live-checks.mjs` and `tools/live-worktree-checks.mjs` never exercise the
 * push side: settlement notifications need a real turn, and the 2025-era stateful
 * leg only exists on an HTTP endpoint with a listener. This script drives a fresh
 * DSH boot end to end:
 *
 * - a 2026-07-28 client: `server/discover`, `tools/list`, one `subscriptions/listen`
 *   stream, then notifications + `resources/read` for session events, status,
 *   projections, the session list and background jobs;
 * - a 2025-era client: `initialize` → `mcp-session-id`, `resources/subscribe`, a
 *   long-lived GET SSE stream, and the same notifications on it;
 * - the stdio bridge (`bin/mcp-stdio.mjs`): the initialize reply, a tools/list
 *   round-trip, and a pushed notification forwarded to stdio;
 * - compatibility and refusal paths: stateless legacy POSTs still work without a
 *   session id, GET without a session is 405, GET without a token is 401, an
 *   unknown session id is 404.
 *
 * It creates one throwaway directory, one session and one shell job; the job is
 * killed and the session archived afterwards. The harness has no session delete,
 * so run it against a throwaway profile (see docs/LIVE-VERIFICATION.md).
 *
 * Usage:
 *   node tools/live-push-checks.mjs --url http://127.0.0.1:18990/mcp
 *   node tools/live-push-checks.mjs --url <url> --token-file ~/.dsh/dsh-as-mcp/token
 *   node tools/live-push-checks.mjs --url <url> --token <bearer> --keep
 *
 * @module dsh-as-mcp/tools/live-push-checks
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The protocol revision this endpoint serves as the modern era. */
const MODERN_VERSION = '2026-07-28'
/** The newest 2025-era revision the stateful leg serves. */
const LEGACY_VERSION = '2025-06-18'
/** The endpoint's tool count; the push surface must not change it. */
const TOOL_COUNT = 35

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

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Await a truthy result for at most `timeoutMs`, polling a cheap predicate. */
async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const startedAt = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - startedAt > timeoutMs) return undefined
    await sleep(intervalMs)
  }
}

/** One SSE frame, as `{ event, data, id }`; comment-only frames are dropped. */
function parseSseFrame(raw) {
  let event = 'message'
  let id
  const data = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  if (data.length === 0) return undefined
  const text = data.join('\n')
  try {
    return { event, id, message: JSON.parse(text) }
  } catch {
    return { event, id, text }
  }
}

/** Drain a long-lived SSE response into an inspectable event list. */
function openSse(response) {
  const events = []
  let buffer = ''
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let state = 'open'
  const drain = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const frame = parseSseFrame(raw)
          if (frame !== undefined) events.push(frame)
        }
      }
    } catch {
      // An aborted read is how a test closes the stream.
    } finally {
      state = 'closed'
    }
  })()
  return {
    events,
    get state() {
      return state
    },
    async close() {
      await reader.cancel().catch(() => {})
      await drain.catch(() => {})
    },
  }
}

/** Read either a JSON body or the first SSE data frame for one JSON-RPC id. */
async function readJsonRpc(response, id) {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  const candidates = []
  if (contentType.includes('text/event-stream')) {
    for (const frame of text.split('\n\n')) {
      const parsed = parseSseFrame(frame)
      if (parsed !== undefined && parsed.message !== undefined) candidates.push(parsed.message)
    }
  } else if (text.trim() !== '') {
    try {
      candidates.push(JSON.parse(text))
    } catch {
      // fall through to the per-frame scan below
      const parsed = parseSseFrame(text)
      if (parsed?.message !== undefined) candidates.push(parsed.message)
    }
  }
  return candidates.find((candidate) => candidate?.id === id) ?? candidates.at(-1)
}

/** The per-run MCP client used by every check. */
function createClient(url, token) {
  const base = {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  }
  let nextId = 1

  /** A modern POST: per-request envelope in `_meta`, method/name headers. */
  async function modern(method, params, options = {}) {
    const id = options.id ?? nextId++
    const headers = {
      ...base,
      'content-type': 'application/json',
      'mcp-protocol-version': MODERN_VERSION,
      'mcp-method': method,
      ...(options.name === undefined ? {} : { 'mcp-name': options.name }),
      ...(options.sessionId === undefined ? {} : { 'mcp-session-id': options.sessionId }),
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...(params ?? {}),
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'live-push-checks', version: '1' },
          },
        },
      }),
    })
    return { id, response, body: await readJsonRpc(response, id) }
  }

  /** A legacy POST, stateless when `sessionId` is absent. */
  async function legacy(method, params, options = {}) {
    const id = options.id ?? nextId++
    const headers = { ...base, 'content-type': 'application/json' }
    if (options.sessionId !== undefined) headers['mcp-session-id'] = options.sessionId
    if (options.protocolVersion !== undefined) headers['mcp-protocol-version'] = options.protocolVersion
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
    })
    return { id, response, body: await readJsonRpc(response, id) }
  }

  /** Call a tool through the legacy stateless leg (no session needed). */
  async function callTool(name, args) {
    const { body } = await legacy('tools/call', { name, arguments: args })
    if (body?.error !== undefined) throw new Error(`tools/call ${name} failed: ${JSON.stringify(body.error)}`)
    const text = body?.result?.content?.[0]?.text
    return text === undefined ? undefined : JSON.parse(text)
  }

  /** Call a tool through the modern leg. */
  async function modernCallTool(name, args) {
    const { body } = await modern('tools/call', { name, arguments: args }, { name })
    if (body?.error !== undefined) throw new Error(`modern tools/call ${name} failed: ${JSON.stringify(body.error)}`)
    const text = body?.result?.content?.[0]?.text
    return text === undefined ? undefined : JSON.parse(text)
  }

  /** Read one resource through the modern leg. */
  async function modernRead(uri) {
    // A modern POST whose body names a resource carries that name in Mcp-Name too;
    // the classification cross-check refuses a body name with no header.
    const { body } = await modern('resources/read', { uri }, { name: uri })
    if (body?.error !== undefined) throw new Error(`modern resources/read ${uri} failed: ${JSON.stringify(body.error)}`)
    return JSON.parse(body?.result?.contents?.[0]?.text ?? '{}')
  }

  /** A 2025-era stateful session: initialize, then POST/GET with its id. */
  async function openStatefulSession() {
    const { response, body } = await legacy('initialize', {
      protocolVersion: LEGACY_VERSION,
      capabilities: {},
      clientInfo: { name: 'live-push-checks', version: '1' },
    })
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId === null) throw new Error('initialize did not return an Mcp-Session-Id header')
    if (body?.result?.protocolVersion === undefined) throw new Error('initialize returned no protocolVersion')
    const initialized = await fetch(url, {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json', 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    const session = {
      sessionId,
      initializedStatus: initialized.status,
      protocolVersion: body.result.protocolVersion,
      async post(method, params) {
        return await legacy(method, params, { sessionId, protocolVersion: LEGACY_VERSION })
      },
      async stream() {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'text/event-stream',
            authorization: `Bearer ${token}`,
            'mcp-session-id': sessionId,
            'mcp-protocol-version': LEGACY_VERSION,
          },
        })
        if (response.status !== 200) throw new Error(`GET notification stream answered ${response.status}`)
        return openSse(response)
      },
      async delete() {
        return await fetch(url, {
          method: 'DELETE',
          headers: { ...base, 'mcp-session-id': sessionId },
        })
      },
    }
    return session
  }

  return { url, token, modern, legacy, callTool, modernCallTool, modernRead, openStatefulSession }
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
    },
  }
}

/** Start the stdio bridge and drive one JSON-RPC line. */
function spawnBridge(url, token) {
  const bridge = spawn(process.execPath, [resolve('bin/mcp-stdio.mjs')], {
    env: { ...process.env, DSH_AS_MCP_URL: url, DSH_AS_MCP_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const messages = []
  const stderr = []
  let buffer = ''
  bridge.stdout.setEncoding('utf8')
  bridge.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        stderr.push(`unparsable stdout line: ${line}`)
      }
    }
  })
  bridge.stderr.setEncoding('utf8')
  bridge.stderr.on('data', (chunk) => stderr.push(chunk))
  return {
    bridge,
    messages,
    stderr,
    async send(message) {
      bridge.stdin.write(`${JSON.stringify(message)}\n`)
    },
    async waitFor(predicate, timeoutMs) {
      return await waitFor(() => messages.find(predicate), timeoutMs)
    },
    async stop() {
      bridge.stdin.end()
      const exited = await Promise.race([
        new Promise((resolveExit) => bridge.once('exit', resolveExit)),
        sleep(3_000).then(() => 'timeout'),
      ])
      if (exited === 'timeout') bridge.kill('SIGKILL')
    },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const token = resolveToken(options)
  const url = options.url
  const client = createClient(url, token)
  const runner = createRunner()
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-push-live-'))
  const createdSessions = []
  let shellJobId
  let modernStream
  let statefulStream

  console.log(`endpoint ${url}`)
  console.log(`scratch  ${scratch}\n`)

  try {
    // ---- Bootstrap -------------------------------------------------------
    const info = await client.callTool('dsh_info', {})
    runner.results.push({
      name: 'endpoint answers dsh_info',
      ok: info !== undefined,
      detail: info === undefined ? 'no reply' : `harness ${info.harnessVersion ?? '?'}`,
    })
    console.log(`PASS  endpoint answers dsh_info`)

    const created = await client.callTool('session_create', { cwd: scratch })
    const sessionId = created.sessionId
    createdSessions.push(sessionId)
    runner.results.push({ name: 'session_create creates a probe session', ok: true, detail: sessionId })
    console.log(`PASS  session_create creates a probe session — ${sessionId}`)
    const eventsUri = `dsh://session/${encodeURIComponent(sessionId)}/events`
    const statusUri = `dsh://session/${encodeURIComponent(sessionId)}/status`
    const assistantUri = `dsh://session/${encodeURIComponent(sessionId)}/assistant`
    const projectionsUri = `dsh://session/${encodeURIComponent(sessionId)}/projections`

    // ---- Modern era: discovery and feeds --------------------------------
    await runner.check('modern server/discover advertises 2026-07-28 and resource subscriptions', async () => {
      const { body } = await client.modern('server/discover', {})
      if (body?.error !== undefined) throw new Error(JSON.stringify(body.error))
      const versions = body.result?.supportedVersions ?? []
      if (!versions.includes(MODERN_VERSION)) throw new Error(`supportedVersions=${JSON.stringify(versions)}`)
      if (body.result?.capabilities?.resources?.subscribe !== true) {
        throw new Error(`resources.subscribe=${JSON.stringify(body.result?.capabilities?.resources)}`)
      }
      return `supportedVersions=${JSON.stringify(versions)}`
    })

    await runner.check('modern tools/list still reports the 35-tool surface', async () => {
      const { body } = await client.modern('tools/list', {})
      if (body?.error !== undefined) throw new Error(JSON.stringify(body.error))
      const tools = body.result?.tools ?? []
      if (tools.length !== TOOL_COUNT) throw new Error(`expected ${TOOL_COUNT} tools, got ${tools.length}`)
      return `${tools.length} tools`
    })

    await runner.check('modern resources/read serves the session list, events, status, projections and assistant feeds', async () => {
      const sessions = await client.modernRead('dsh://sessions')
      if (!(sessions?.sessions ?? []).some((row) => row.sessionId === sessionId)) {
        throw new Error('created session missing from dsh://sessions')
      }
      const events = await client.modernRead(eventsUri)
      if (events?.sessionId !== sessionId) throw new Error(`events feed named ${String(events?.sessionId)}`)
      const status = await client.modernRead(statusUri)
      if (status?.sessionId !== sessionId) throw new Error(`status feed named ${String(status?.sessionId)}`)
      const projections = await client.modernRead(projectionsUri)
      if (typeof projections !== 'object' || projections === null) throw new Error('projections feed is not an object')
      const assistant = await client.modernRead(assistantUri)
      if (!Array.isArray(assistant?.frames)) throw new Error('assistant feed has no frames array')
      return `sessions=${sessions.sessions.length} events.asOfSeq=${events.asOfSeq} projections=${Object.keys(projections).join(',') || '(empty)'}`
    })

    await runner.check('modern subscriptions/listen acknowledges the requested feeds', async () => {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'subscriptions/listen',
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 900,
          method: 'subscriptions/listen',
          params: {
            notifications: { resourceSubscriptions: ['dsh://sessions', eventsUri, statusUri, 'dsh://jobs'] },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      if (response.status !== 200) throw new Error(`listen answered ${response.status}`)
      modernStream = openSse(response)
      const ack = await waitFor(
        () => modernStream.events.find((frame) => frame.message?.method === 'notifications/subscriptions/acknowledged'),
        5_000,
      )
      if (ack === undefined) throw new Error('no subscriptions/acknowledged frame')
      const echoed = ack.message.params?.notifications?.resourceSubscriptions ?? []
      for (const wanted of ['dsh://sessions', eventsUri, statusUri, 'dsh://jobs']) {
        if (!echoed.includes(wanted)) throw new Error(`ack did not echo ${wanted}: ${JSON.stringify(echoed)}`)
      }
      return `acknowledged ${echoed.length} subscriptions`
    })

    await runner.check('modern listen stream receives a session turn notification and the feed reads the new events', async () => {
      // An accepted turn without provider credentials still appends turn events;
      // the failure path is the one exercised here, exactly like a real no-model
      // deployment.
      const accepted = await client.modernCallTool('session_prompt', {
        sessionId,
        prompt: 'live push check',
        wait: false,
      })
      if (accepted?.accepted !== true) throw new Error(`prompt was not accepted: ${JSON.stringify(accepted)}`)
      const eventsNotification = await waitFor(
        () => modernStream.events.find((frame) => (
          frame.message?.method === 'notifications/resources/updated'
          && frame.message?.params?.uri === eventsUri
        )),
        8_000,
      )
      if (eventsNotification === undefined) throw new Error('no resources/updated for the events feed')
      const statusNotification = await waitFor(
        () => modernStream.events.find((frame) => (
          frame.message?.method === 'notifications/resources/updated'
          && frame.message?.params?.uri === statusUri
        )),
        8_000,
      )
      if (statusNotification === undefined) throw new Error('no resources/updated for the status feed')
      // A notification fires on the first appended event, not necessarily after the
      // turn has ended (title generation can append a last event a moment later),
      // so the read is retried until the terminal event is visible.
      const settled = await waitFor(async () => {
        const events = await client.modernRead(eventsUri)
        const types = (events?.events ?? []).map((event) => event.type)
        if (!types.includes('turn/start')) return undefined
        if (!types.includes('turn/end')) return undefined
        return { events, types }
      }, 8_000)
      if (settled === undefined) {
        const events = await client.modernRead(eventsUri)
        throw new Error(`events feed never showed turn/end: ${JSON.stringify((events?.events ?? []).map((event) => event.type))}`)
      }
      return `turn events: ${settled.types.slice(-4).join(',')}`
    })

    await runner.check('modern listen stream receives background-job notifications and a non-consuming tail read', async () => {
      const job = await client.modernCallTool('shell_start', {
        command: "printf 'live-push\\n'; sleep 2; printf 'live-push-2\\n'; sleep 20",
      })
      shellJobId = job.jobId
      const jobUri = `dsh://jobs/${encodeURIComponent(shellJobId)}`
      // The per-job URI cannot be named before the job exists, so it gets its own
      // listen stream opened as soon as the id is known. The delayed second write
      // guarantees a tail change after that stream is registered.
      const jobStreamResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': MODERN_VERSION,
          'mcp-method': 'subscriptions/listen',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 901,
          method: 'subscriptions/listen',
          params: {
            notifications: { resourceSubscriptions: [jobUri, 'dsh://jobs'] },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      if (jobStreamResponse.status !== 200) throw new Error(`job listen answered ${jobStreamResponse.status}`)
      const jobStream = openSse(jobStreamResponse)
      try {
      const jobsNotification = await waitFor(
        () => modernStream.events.find((frame) => (
          frame.message?.method === 'notifications/resources/updated'
          && frame.message?.params?.uri === 'dsh://jobs'
        )),
        6_000,
      )
      if (jobsNotification === undefined) throw new Error('no resources/updated for dsh://jobs')
      const singleNotification = await waitFor(
        () => jobStream.events.find((frame) => (
          frame.message?.method === 'notifications/resources/updated'
          && frame.message?.params?.uri === jobUri
        )),
        8_000,
      )
      if (singleNotification === undefined) throw new Error(`no resources/updated for ${jobUri}`)
      const list = await client.modernRead('dsh://jobs')
      if (!(list?.jobs ?? []).some((row) => row.jobId === shellJobId)) throw new Error('job missing from dsh://jobs')
      const peek = await waitFor(async () => {
        const payload = await client.modernRead(jobUri)
        return payload?.tail?.includes('live-push') === true ? payload : undefined
      }, 6_000)
      if (peek === undefined) throw new Error('job tail never reported the printed output')
      return `job ${shellJobId} tail=${JSON.stringify(peek.tail.trim())}`
      } finally {
        await jobStream.close()
      }
    })

    // ---- 2025 era: stateful session + GET SSE ---------------------------
    let session
    await runner.check('legacy initialize opens a stateful session', async () => {
      session = await client.openStatefulSession()
      if (session.initializedStatus !== 202) {
        throw new Error(`notifications/initialized answered ${session.initializedStatus}`)
      }
      return `session=${session.sessionId} protocol=${session.protocolVersion}`
    })

    await runner.check('2025 resources/subscribe and resources/unsubscribe are acknowledged', async () => {
      for (const uri of [eventsUri, 'dsh://jobs']) {
        const subscribed = await session.post('resources/subscribe', { uri })
        if (subscribed.body?.error !== undefined) throw new Error(`subscribe ${uri}: ${JSON.stringify(subscribed.body.error)}`)
        if (subscribed.body?.result === undefined) throw new Error(`subscribe ${uri} returned no result`)
      }
      const unsubscribed = await session.post('resources/unsubscribe', { uri: 'dsh://jobs' })
      if (unsubscribed.body?.error !== undefined) {
        throw new Error(`unsubscribe: ${JSON.stringify(unsubscribed.body.error)}`)
      }
      return 'subscribe/unsubscribe round-trip'
    })

    await runner.check('legacy stateless POSTs still work without a session id', async () => {
      const listed = await client.legacy('tools/list', {})
      if (listed.body?.error !== undefined) throw new Error(JSON.stringify(listed.body.error))
      const tools = listed.body?.result?.tools ?? []
      if (tools.length !== TOOL_COUNT) throw new Error(`expected ${TOOL_COUNT} tools, got ${tools.length}`)
      return `${tools.length} tools over the stateless fallback`
    })

    await runner.check('GET without a session id is rejected (not a push channel)', async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
      })
      if (response.status !== 405) throw new Error(`expected 405, got ${response.status}`)
      return 'GET without session → 405'
    })

    await runner.check('GET without a token is 401 even on the push channel', async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'text/event-stream', 'mcp-session-id': session.sessionId },
      })
      if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`)
      const challenge = response.headers.get('www-authenticate') ?? ''
      if (!challenge.includes('Bearer')) throw new Error(`missing bearer challenge: ${challenge}`)
      return 'GET unauthorized → 401 + WWW-Authenticate'
    })

    await runner.check('2025 stateful GET stream receives the turn notifications', async () => {
      statefulStream = await session.stream()
      const accepted = await client.callTool('session_prompt', { sessionId, prompt: 'legacy push check', wait: false })
      if (accepted?.accepted !== true) throw new Error(`prompt was not accepted: ${JSON.stringify(accepted)}`)
      const eventsNotification = await waitFor(
        () => statefulStream.events.find((frame) => (
          frame.message?.method === 'notifications/resources/updated'
          && frame.message?.params?.uri === eventsUri
        )),
        8_000,
      )
      if (eventsNotification === undefined) throw new Error('no resources/updated for the events feed on GET SSE')
      const statusNotification = await waitFor(
        () => statefulStream.events.find((frame) => (
          frame.message?.method === 'notifications/resources/updated'
          && frame.message?.params?.uri === statusUri
        )),
        8_000,
      )
      if (statusNotification === undefined) throw new Error('no resources/updated for the status feed on GET SSE')
      const read = await session.post('resources/read', { uri: eventsUri })
      if (read.body?.error !== undefined) throw new Error(JSON.stringify(read.body.error))
      const events = JSON.parse(read.body?.result?.contents?.[0]?.text ?? '{}')
      if (events.sessionId !== sessionId) throw new Error(`events read named ${String(events.sessionId)}`)
      return `GET SSE notifications for events/status; asOfSeq=${events.asOfSeq}`
    })

    await runner.check('2025 DELETE closes the session and its id is then refused', async () => {
      const closed = await session.delete()
      if (closed.status !== 200 && closed.status !== 204) throw new Error(`DELETE answered ${closed.status}`)
      const after = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-session-id': session.sessionId,
        },
      })
      if (after.status !== 404) throw new Error(`expected 404 after DELETE, got ${after.status}`)
      return 'DELETE → 200/204, subsequent GET → 404'
    })

    // ---- stdio bridge ----------------------------------------------------
    await runner.check('stdio bridge forwards the initialize reply, tools/list and a pushed notification', async () => {
      const bridge = spawnBridge(url, token)
      try {
        await bridge.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LEGACY_VERSION,
            capabilities: {},
            clientInfo: { name: 'live-push-checks', version: '1' },
          },
        })
        const init = await bridge.waitFor((message) => message?.id === 1, 8_000)
        if (init?.result?.serverInfo?.name !== 'dsh-as-mcp') {
          throw new Error(`bridge initialize reply: ${JSON.stringify(init ?? null)}`)
        }
        await bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        await bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        const listed = await bridge.waitFor((message) => message?.id === 2, 8_000)
        const tools = listed?.result?.tools ?? []
        if (tools.length !== TOOL_COUNT) throw new Error(`bridge tools/list returned ${tools.length} tools`)
        // The bridge's own stateful session now holds the GET channel; a turn on
        // the shared probe session must reach it as a stdio line.
        await client.callTool('session_prompt', { sessionId, prompt: 'bridge push check', wait: false })
        const pushed = await bridge.waitFor(
          (message) => message?.method === 'notifications/resources/updated'
            && typeof message?.params?.uri === 'string',
          8_000,
        )
        if (pushed === undefined) throw new Error('bridge forwarded no pushed notification')
        return `initialize + ${tools.length} tools + push ${pushed.params.uri}`
      } finally {
        await bridge.stop()
        if (bridge.stderr.length > 0) {
          const pushNotes = bridge.stderr.join('').split('\n').filter((line) => line.includes('[dsh-as-mcp]'))
          if (pushNotes.length > 0) console.log(`      bridge stderr: ${pushNotes.join(' | ')}`)
        }
      }
    })
  } finally {
    // ---- Teardown -------------------------------------------------------
    for (const stream of [modernStream, statefulStream]) await stream?.close()
    if (shellJobId !== undefined) {
      await client.callTool('shell_kill', { jobId: shellJobId }).catch(() => {})
    }
    for (const id of createdSessions) {
      await client.callTool('session_archive', { sessionId: id }).catch(() => {})
    }
    if (options.keep !== true) {
      const resolved = resolve(scratch)
      if (resolved.startsWith(resolve(tmpdir()) + '/')) rmSync(resolved, { recursive: true, force: true })
    } else {
      console.log(`\nkept scratch ${scratch}`)
    }
    runner.summary()
    const failed = runner.results.filter((result) => !result.ok)
    process.exitCode = failed.length === 0 ? 0 : 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
