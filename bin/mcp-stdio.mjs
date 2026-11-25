#!/usr/bin/env node
/**
 * stdio ⇄ Streamable HTTP bridge for dsh-as-mcp.
 *
 * The MCP endpoint lives inside the DSH host process, which has no stdio to
 * hand to a child. This bridge is the adapter for clients that only speak
 * stdio: it forwards each newline-delimited JSON-RPC message to the endpoint
 * over HTTP and writes the reply back as a line.
 *
 * When the endpoint is stateful (its `initialize` reply carries an
 * `mcp-session-id`), the bridge also keeps the protocol's server→client
 * notification channel open: a long-lived `GET` with `accept: text/event-stream`
 * on the same endpoint. Every JSON-RPC message that channel carries is written
 * to stdout as its own line, so a stdio client sees notifications and
 * server→client requests without polling. The channel reconnects with
 * exponential backoff while stdin is open; a stateless endpoint (no session id,
 * or a GET answered with 404/405) disables it with one stderr note.
 *
 * Configuration (environment variables):
 *   DSH_AS_MCP_URL    endpoint URL, default http://127.0.0.1:8790/mcp
 *   DSH_AS_MCP_TOKEN  bearer token; when unset, read from
 *                     <DSH_HOME>/dsh-as-mcp/token
 *
 * Claude Code channel mode (`--channel`, or DSH_AS_MCP_CHANNEL=1): the bridge
 * declares the `claude/channel` capability and writes one
 * `notifications/claude/channel` line whenever a DSH session's turn ends. It
 * negotiates the 2025-era revision upstream (the stateful leg), subscribes and
 * reads through its own `dsh-channel:<n>` requests whose replies never reach
 * stdout, and survives an unreachable or restarted DSH. See ./channel.mjs.
 *   --channel-scope=owned|all   or DSH_AS_MCP_CHANNEL_SCOPE (default owned)
 *
 * There are no dependencies on purpose: this file has to run from a bare
 * `npx dsh-as-mcp`, from a `link:` install, and from a tarball alike.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  CHANNEL_INSTRUCTIONS,
  INTERNAL_ID_PREFIX,
  LEGACY_PROTOCOL_VERSION,
  createTracker,
} from './channel.mjs'

const DEFAULT_URL = 'http://127.0.0.1:8790/mcp'

/** Resolve `$DSH_HOME`, mirroring the harness's own rule. */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

/** The token file the plugin writes when `auth.token` is left empty. */
function tokenFilePath() {
  return join(resolveDshHome(), 'dsh-as-mcp', 'token')
}

/** Read the persisted token, or `''` when the plugin has not run yet. */
function readPersistedToken() {
  try {
    return readFileSync(tokenFilePath(), 'utf8').trim()
  } catch {
    return ''
  }
}

const endpoint = process.env.DSH_AS_MCP_URL?.trim() || DEFAULT_URL
// The distinction matters for the exfil guard below: a token handed over
// explicitly was meant for the configured endpoint, one read from disk was
// not necessarily.
const tokenIsExplicit = Boolean(process.env.DSH_AS_MCP_TOKEN?.trim())
const token = process.env.DSH_AS_MCP_TOKEN?.trim() || readPersistedToken()

/**
 * Whether a hostname names this machine.
 *
 * The IPv4 arm matches a literal 127.0.0.0/8 dotted quad, NOT a `127.` string
 * prefix. A prefix test also accepts `127.0.0.1.attacker.example`, whose DNS the
 * attacker controls, so the persisted machine-local token would be sent straight
 * to them — defeating the exact exfiltration this guard exists to stop. The
 * hostname is attacker-influenced (it comes from a pasted client config), so the
 * test has to be exact.
 */
function isLoopbackHost(hostname) {
  // Trailing dot is the fully-qualified spelling of the same name.
  const name = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (name === 'localhost' || name === '::1') return true
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  if (quad === null) return false
  const octets = quad.slice(1).map(Number)
  return octets.every((octet) => octet <= 255) && octets[0] === 127
}

/**
 * Whether a URL points at this machine, so sending the local token is safe.
 *
 * A scheme-less authority (`127.0.0.1:8790/mcp`) is accepted: it is how someone
 * naturally writes an address, and `new URL` otherwise parses it as the opaque
 * scheme `127.0.0.1:` with an empty host, reporting a loopback endpoint as
 * off-host and refusing for a reason that is not the real one.
 *
 * Anything that parses neither way is not loopback, so the guard fails closed.
 */
function isLoopbackUrl(value) {
  for (const candidate of [value, `http://${value}`]) {
    try {
      if (isLoopbackHost(new URL(candidate).hostname)) return true
    } catch {
      // Not this shape; a scheme-less value is tried next.
    }
  }
  return false
}

/** Channel mode: off unless asked for, and then every other branch below stays dormant. */
const channelEnabled = process.argv.includes('--channel') || process.env.DSH_AS_MCP_CHANNEL?.trim() === '1'
const channelScopeFlag = process.argv.find((arg) => arg.startsWith('--channel-scope='))?.slice('--channel-scope='.length)
const channelScopeRaw = (channelScopeFlag ?? process.env.DSH_AS_MCP_CHANNEL_SCOPE ?? 'owned').trim().toLowerCase()
const channelScope = channelScopeRaw === 'all' ? 'all' : 'owned'

/** MCP session id, when the server issues one. */
let sessionId
/** Protocol revision negotiated by `initialize`, echoed on later requests. */
let protocolVersion

/** Reconnect delays for the notification channel: start fast, back off, cap. */
const PUSH_RETRY_BASE_MS = 500
const PUSH_RETRY_MAX_MS = 30_000

/** Abort handle for the running notification channel, when one is open. */
let pushAbort
/** Whether the notification channel has been started (it may be reconnecting). */
let pushStarted = false
/** Set once the endpoint is known to be stateless: push is never retried. */
let pushDisabled = false
/** The session the running channel was opened for, to detect a re-initialize. */
let pushSessionId
/** Most recent SSE `id:` seen on the channel, replayed on reconnect. */
let lastEventId
/** Whether the notification stream is open right now (channel mode waits on it). */
let pushConnected = false
const pushWaiters = new Set()

function log(message) {
  process.stderr.write(`[dsh-as-mcp] ${message}\n`)
}

/** Parse one SSE body into its JSON-RPC payloads. */
async function readEventStream(response) {
  const payloads = []
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data !== '') {
          try {
            payloads.push(JSON.parse(data))
          } catch {
            log(`dropped an unparsable SSE payload: ${data.slice(0, 200)}`)
          }
        }
      }
      newline = buffer.indexOf('\n')
    }
  }
  return payloads
}

/** Write one server→client JSON-RPC message as a single stdout line. */
function emitPushPayload(payload) {
  if (channelEnabled && payload && typeof payload === 'object') {
    // A reply to one of the bridge's own requests is the bridge's, not the client's.
    if (typeof payload.id === 'string' && payload.id.startsWith(INTERNAL_ID_PREFIX)) return
    // Observe only: the update is still forwarded to the client below.
    if (payload.method === 'notifications/resources/updated') tracker.onResourceUpdated(payload.params?.uri)
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/**
 * Read the long-lived notification stream and forward each message.
 *
 * The reader never writes a partial line: a payload is emitted only once a
 * complete JSON document has arrived (one `data:` line is the server's normal
 * framing; a multi-line `data:` payload is assembled through its blank-line
 * terminator). Returns whether anything was delivered, which tells the caller
 * whether the connection was actually useful before it ended.
 */
async function readPushStream(response) {
  const decoder = new TextDecoder()
  let buffer = ''
  /** `data:` lines of the event currently being assembled. */
  let dataLines = []
  let delivered = false

  const flush = () => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    if (data === '') return
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      log(`dropped an unparsable push payload: ${data.slice(0, 200)}`)
      return
    }
    emitPushPayload(payload)
    delivered = true
  }

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const raw = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line === '') {
        // Blank line terminates an event.
        flush()
      } else if (line.startsWith(':')) {
        // Comment / keep-alive; nothing to forward.
      } else if (line.startsWith('data:')) {
        const value = line.slice(5)
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
        // Dispatch as soon as the accumulated data is a complete JSON document,
        // so a one-data-line message is forwarded immediately rather than only
        // at the next blank line.
        try {
          JSON.parse(dataLines.join('\n'))
          flush()
        } catch {
          // Multi-line payload: wait for the blank-line terminator.
        }
      } else if (line.startsWith('id:')) {
        const id = line.slice(3).trim()
        if (id !== '') lastEventId = id
      }
      // `event:` and `retry:` need no handling here.
      newline = buffer.indexOf('\n')
    }
  }
  // A stream that ends without its final blank line still carries a message.
  flush()
  return delivered
}

/** Sleep, but wake up immediately when the channel is stopped. */
function pause(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Keep the server→client notification channel open, reconnecting with
 * exponential backoff (500 ms doubling to a 30 s cap) while stdin is open.
 */
async function runPushChannel(signal) {
  let failures = 0
  let loggedInterruption = false
  while (!signal.aborted) {
    const channelSession = sessionId
    if (!channelSession) return

    const headers = { accept: 'text/event-stream' }
    if (token) headers.authorization = `Bearer ${token}`
    headers['mcp-session-id'] = channelSession
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion
    // Resumability is optional on the server; replaying the id is harmless.
    if (lastEventId !== undefined) headers['last-event-id'] = lastEventId

    let delivered = false
    try {
      const response = await fetch(endpoint, { method: 'GET', headers, signal })
      if (channelEnabled && response.status === 404) {
        await response.body?.cancel().catch(() => {})
        // A 404 on GET alone does not prove the session is gone: ask with a POST first.
        // A live session whose GET is unavailable is a stateless-style endpoint, so
        // push stops for good instead of creating sessions in a loop.
        if (await sessionStillValid()) {
          pushDisabled = true
          log('push disabled: the notification channel answered HTTP 404 but the session is valid; request/reply continue')
          return
        }
        if (signal.aborted) return
        log('push channel: session unknown to the endpoint (HTTP 404); re-initializing')
        await recoverUpstream(channelSession)
        return
      }
      if (response.status === 404 || response.status === 405) {
        pushDisabled = true
        log(
          `push disabled: the notification channel answered HTTP ${response.status} `
          + '(stateless endpoint); request/reply continue',
        )
        await response.body?.cancel().catch(() => {})
        return
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }
      loggedInterruption = false
      failures = 0
      if (channelEnabled) setPushConnected(true)
      delivered = await readPushStream(response)
    } catch (error) {
      if (signal.aborted) return
      const text = error instanceof Error ? error.message : String(error)
      if (!loggedInterruption) {
        log(`push channel interrupted: ${text}; reconnecting with backoff`)
        loggedInterruption = true
      }
    }

    if (channelEnabled) setPushConnected(false)
    if (signal.aborted) return
    // A stream that delivered messages starts over at the base delay; one that
    // keeps ending or failing without delivering backs off exponentially.
    if (!delivered) failures += 1
    const delay = Math.min(
      PUSH_RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0),
      PUSH_RETRY_MAX_MS,
    )
    await pause(delay, signal)
  }
}

/**
 * Start the notification channel after a successful `initialize`.
 *
 * A stateful endpoint issues an `mcp-session-id` header; a stateless one does
 * not, and then push stays off permanently — request/reply is unaffected.
 */
function maybeStartPush() {
  if (pushDisabled) return
  if (!sessionId) {
    pushDisabled = true
    log(
      'push disabled: the initialize response carried no mcp-session-id '
      + '(stateless endpoint); request/reply continue',
    )
    return
  }
  if (pushStarted && pushSessionId === sessionId) return
  // A re-initialize can hand out a new session: drop the old stream first.
  stopPushChannel()
  pushStarted = true
  pushSessionId = sessionId
  pushAbort = new AbortController()
  runPushChannel(pushAbort.signal).catch((error) => {
    log(`push channel stopped: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/** Stop the notification channel (stdin closed, or a new session replaced it). */
function stopPushChannel() {
  pushStarted = false
  pushSessionId = undefined
  pushAbort?.abort()
  pushAbort = undefined
}

/** A non-2xx upstream answer; the message is the bridge's long-standing one. */
class HttpStatusError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

/** The endpoint answered 404 for the session this bridge was using. */
class SessionLostError extends Error {
  constructor(lostSessionId) {
    super('the endpoint no longer knows this MCP session (HTTP 404)')
    this.lostSessionId = lostSessionId
  }
}

/** POST one JSON-RPC message and return the JSON-RPC payloads it produced. */
async function forward(message) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionId) headers['mcp-session-id'] = sessionId
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  })

  // Channel mode: a 404 on a request that carried a session means the endpoint
  // dropped it. Say so distinctly so the caller can re-initialize and retry.
  if (channelEnabled && response.status === 404 && headers['mcp-session-id']) {
    await response.body?.cancel().catch(() => {})
    throw new SessionLostError(headers['mcp-session-id'])
  }

  const issuedSession = response.headers.get('mcp-session-id')
  if (issuedSession) sessionId = issuedSession

  // Notifications are acknowledged without a body.
  if (response.status === 202 || response.status === 204) return []
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new HttpStatusError(
      `HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail.trim()}` : ''}`,
      response.status,
    )
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) return await readEventStream(response)

  const body = await response.text()
  if (body.trim() === '') return []
  return [JSON.parse(body)]
}

// ---------------------------------------------------------------------------
// Channel mode. Nothing below runs unless `channelEnabled`.
// ---------------------------------------------------------------------------

/** Tools whose calls make a session "dispatched by this entry". */
const OWNING_TOOLS = new Set(['session_create', 'session_fork', 'session_prompt', 'session_command'])
/** Of those, the ones that name an existing session in their arguments. */
const PROMPTING_TOOLS = new Set(['session_prompt', 'session_command'])

let internalSeq = 0
/** The client's `initialize` params with the revision rewritten, replayed on every upstream handshake. */
let channelInit
/** An `initialize` has been answered (really or locally). */
let initializeAnswered = false
/** The upstream session is usable right now. */
let upstreamReady = false
/** The client sent `notifications/initialized`. */
let clientInitialized = false
let stdinClosed = false
let reconnecting
let recovering
/** Back-to-back recoveries (a session dying right after it was made) back off. */
let recoveryStreak = 0
let lastRecoveryAt = 0
const RECOVERY_STREAK_WINDOW_MS = 30_000
/** The last handshake failure was a credentials rejection (HTTP 401/403). */
let authFailure

function writeLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function setPushConnected(value) {
  pushConnected = value
  if (value) {
    for (const wake of pushWaiters) wake()
    pushWaiters.clear()
  }
}

/** Resolve once the notification stream is open, or after `ms` regardless. */
function waitForPush(ms = 5000) {
  if (pushConnected || pushDisabled) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      pushWaiters.delete(finish)
      resolve()
    }
    pushWaiters.add(finish)
  })
}

/** One bridge-internal request; the reply is consumed here and goes nowhere else. */
async function internalRequest(method, params) {
  if (!upstreamReady) throw new Error('upstream is not ready')
  const id = `${INTERNAL_ID_PREFIX}${++internalSeq}`
  let replies
  try {
    replies = await forward({ jsonrpc: '2.0', id, method, params })
  } catch (error) {
    if (error instanceof SessionLostError) recoverInBackground(error.lostSessionId)
    throw error
  }
  const reply = replies.find((candidate) => candidate && candidate.id === id)
  if (!reply) throw new Error(`no reply to ${method}`)
  if (reply.error) throw new Error(reply.error.message ?? `${method} failed`)
  return reply.result
}

if (channelEnabled) {
  // A stray rejection must never take the bridge (and the client's MCP connection) down.
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
  })
}

const tracker = createTracker({
  scope: channelScope,
  rpc: internalRequest,
  emit: (params) => {
    if (!clientInitialized) return
    writeLine({ jsonrpc: '2.0', method: 'notifications/claude/channel', params })
  },
  log,
  whenPushReady: () => waitForPush(5000),
})

function maybeStartTracker() {
  if (!upstreamReady || !clientInitialized) return
  tracker.start().catch((error) => {
    log(`channel tracker failed to start: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function backoff(failures) {
  return Math.min(PUSH_RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0), PUSH_RETRY_MAX_MS)
}

/** A full upstream handshake with the stored client parameters; throws when it cannot complete. */
async function handshake() {
  sessionId = undefined
  protocolVersion = undefined
  lastEventId = undefined
  const id = `${INTERNAL_ID_PREFIX}${++internalSeq}`
  const replies = await forward({ jsonrpc: '2.0', id, method: 'initialize', params: channelInit })
  const reply = replies.find((candidate) => candidate && candidate.id === id)
  if (!reply?.result) throw new Error(reply?.error?.message ?? 'initialize returned no result')
  protocolVersion = reply.result.protocolVersion
  await forward({ jsonrpc: '2.0', method: 'notifications/initialized' })
}

/** Re-establish the upstream session in the background, retrying with backoff until it works. */
function reconnectUpstream() {
  if (reconnecting) return reconnecting
  upstreamReady = false
  reconnecting = (async () => {
    let failures = 0
    let logged = false
    while (!stdinClosed) {
      try {
        await handshake()
        break
      } catch (error) {
        failures += 1
        if (!logged) {
          noteUpstreamFailure(error)
          logged = true
        }
        await new Promise((resolve) => {
          setTimeout(resolve, backoff(failures)).unref?.()
        })
      }
    }
    if (stdinClosed) return
    upstreamReady = true
    authFailure = undefined
    log('upstream session established')
    maybeStartPush()
    maybeStartTracker()
  })().finally(() => {
    reconnecting = undefined
  })
  return reconnecting
}

/** Say why the upstream is unavailable, keeping a credentials rejection distinct from an outage. */
function noteUpstreamFailure(error) {
  const text = error instanceof Error ? error.message : String(error)
  if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
    authFailure = `HTTP ${error.status}`
    log(
      `authentication failed (${authFailure}): the DSH endpoint rejected the bridge's bearer token; `
      + 'check DSH_AS_MCP_TOKEN or the token file; retrying with backoff',
    )
    return
  }
  authFailure = undefined
  log(`upstream not available: ${text}; retrying with backoff`)
}

/** Whether the current session still answers a POST (used to read a GET 404 correctly). */
async function sessionStillValid() {
  const id = `${INTERNAL_ID_PREFIX}${++internalSeq}`
  try {
    await forward({ jsonrpc: '2.0', id, method: 'ping' })
    return true
  } catch (error) {
    if (error instanceof SessionLostError) return false
    throw error
  }
}

/**
 * After a lost session: wait (bounded) for a fresh one. Throws when DSH is still away.
 *
 * Single flight: concurrent callers share one recovery. A session that dies soon
 * after the previous recovery makes the next one wait, doubling up to 30 s.
 */
async function recoverUpstream(lostSessionId) {
  if (upstreamReady && sessionId !== undefined && sessionId !== lostSessionId) return
  upstreamReady = false
  recovering ??= (async () => {
    recoveryStreak = Date.now() - lastRecoveryAt < RECOVERY_STREAK_WINDOW_MS ? recoveryStreak + 1 : 0
    if (recoveryStreak > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, backoff(recoveryStreak)).unref?.()
      })
    }
    await reconnectUpstream()
    lastRecoveryAt = Date.now()
  })().finally(() => {
    recovering = undefined
  })
  let timer
  const limit = new Promise((resolve) => {
    timer = setTimeout(resolve, 8000)
    timer.unref?.()
  })
  await Promise.race([recovering, limit])
  clearTimeout(timer)
  if (!upstreamReady) throw new Error('the DSH endpoint is not reachable yet; the bridge is retrying in the background')
}

/** Fire-and-forget recovery: a failure is logged, and the background reconnect carries on. */
function recoverInBackground(lostSessionId) {
  recoverUpstream(lostSessionId).catch((error) => {
    log(`recovery pending: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function notReadyError(message) {
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32603,
      message: authFailure === undefined
        ? 'DSH is not reachable yet; the bridge is retrying in the background. Try again shortly.'
        : `authentication failed (鉴权失败, ${authFailure}): DSH rejected the bridge's token; `
          + 'check DSH_AS_MCP_TOKEN or the token file.',
    },
  }
}

/** Add the channel capability and instructions to an `initialize` result. */
function withChannel(result) {
  const upstream = typeof result.instructions === 'string' && result.instructions !== '' ? `${result.instructions}\n\n` : ''
  return {
    ...result,
    capabilities: {
      ...result.capabilities,
      experimental: { ...result.capabilities?.experimental, 'claude/channel': {} },
    },
    instructions: `${upstream}${CHANNEL_INSTRUCTIONS}`,
  }
}

function packageVersion() {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return JSON.parse(raw).version ?? '0'
  } catch {
    return '0'
  }
}

function localInitializeResult() {
  return withChannel({
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: 'dsh-as-mcp', version: packageVersion() },
  })
}

async function channelInitialize(message) {
  initializeAnswered = true
  channelInit = { ...message.params, protocolVersion: LEGACY_PROTOCOL_VERSION }
  try {
    const replies = await forward({ ...message, params: channelInit })
    const reply = replies.find((candidate) => candidate && candidate.id === message.id)
    if (!reply) throw new Error('initialize returned no reply')
    if (!reply.result) {
      // A real JSON-RPC error from the endpoint: the client should see it as is.
      for (const other of replies) writeLine(other)
      return
    }
    protocolVersion = reply.result.protocolVersion
    writeLine({ ...reply, result: withChannel(reply.result) })
    for (const other of replies) if (other !== reply) writeLine(other)
    upstreamReady = true
    maybeStartPush()
  } catch (error) {
    noteUpstreamFailure(error)
    log('answering initialize locally until the upstream is available')
    writeLine({ jsonrpc: '2.0', id: message.id, result: localInitializeResult() })
    void reconnectUpstream()
  }
}

/** Pull session ids out of a `tools/call` reply (the JSON lives in a text block). */
function sessionIdOfResult(reply) {
  if (!reply?.result || reply.result.isError === true) return undefined
  const structured = reply.result.structuredContent?.sessionId
  if (typeof structured === 'string' && structured !== '') return structured
  for (const block of reply.result.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const parsed = JSON.parse(block.text)
      if (typeof parsed?.sessionId === 'string' && parsed.sessionId !== '') return parsed.sessionId
    } catch {
      // Not JSON; try the next block.
    }
  }
  return undefined
}

async function channelForward(message) {
  const call = message.method === 'tools/call' ? message.params : undefined
  const toolName = typeof call?.name === 'string' ? call.name : undefined
  const owning = toolName !== undefined && OWNING_TOOLS.has(toolName)
  if (owning && PROMPTING_TOOLS.has(toolName)) {
    const target = call.arguments?.sessionId
    // Subscribe and baseline first, submit second: the settlement push is
    // published once, so a subscription made after the prompt can miss it.
    if (typeof target === 'string' && target !== '') await tracker.prepare(target)
  }
  let replies
  try {
    replies = await forward(message)
  } catch (error) {
    if (!(error instanceof SessionLostError)) throw error
    await recoverUpstream(error.lostSessionId)
    replies = await forward(message)
  }
  for (const reply of replies) {
    if (reply && typeof reply === 'object' && reply.result?.protocolVersion) {
      protocolVersion = reply.result.protocolVersion
    }
    writeLine(reply)
  }
  if (owning) {
    const reply = replies.find((candidate) => candidate && candidate.id === message.id)
    const dispatched = sessionIdOfResult(reply)
      ?? (typeof call.arguments?.sessionId === 'string' ? call.arguments.sessionId : undefined)
    if (dispatched !== undefined && reply?.result && reply.result.isError !== true) tracker.markOwned(dispatched)
  }
}

async function handleChannelLine(message) {
  const isObject = message !== null && typeof message === 'object'
  const method = isObject ? message.method : undefined
  const hasId = isObject && message.id !== undefined
  try {
    if (method === 'initialize') {
      await channelInitialize(message)
      return
    }
    if (method === 'notifications/initialized') {
      // Set first: a failed forward must not leave the channel silent forever.
      clientInitialized = true
      if (upstreamReady) {
        const used = sessionId
        try {
          await forward(message)
        } catch (error) {
          log(`could not forward notifications/initialized: ${error instanceof Error ? error.message : String(error)}`)
          // The recovery handshake sends its own initialized and then starts the tracker.
          recoverInBackground(error instanceof SessionLostError ? error.lostSessionId : used)
          return
        }
      }
      maybeStartTracker()
      return
    }
    if (initializeAnswered && !upstreamReady) {
      // Never leave the client waiting on an upstream that is not there.
      if (hasId) writeLine(method === 'ping' ? { jsonrpc: '2.0', id: message.id, result: {} } : notReadyError(message))
      return
    }
    await channelForward(message)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    log(`request failed: ${text}`)
    if (hasId) writeLine({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: text } })
  }
}

/** Handle one input line, emitting zero or more output lines. */
async function handleLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return

  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    log(`ignored a non-JSON input line: ${trimmed.slice(0, 200)}`)
    return
  }

  if (channelEnabled) {
    await handleChannelLine(message)
    return
  }

  try {
    for (const reply of await forward(message)) {
      if (reply && typeof reply === 'object' && reply.result?.protocolVersion) {
        protocolVersion = reply.result.protocolVersion
      }
      process.stdout.write(`${JSON.stringify(reply)}\n`)
    }
    // Only an answered `initialize` can establish the stateful leg: its response
    // header carries the session id and its result the negotiated revision the
    // notification channel echoes back.
    if (message && typeof message === 'object' && message.method === 'initialize') {
      maybeStartPush()
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    log(`request failed: ${text}`)
    // Answer the caller in-band so a client is not left waiting forever.
    if (message && typeof message === 'object' && message.id !== undefined) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: text },
      })}\n`)
    }
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    'dsh-as-mcp — stdio ⇄ Streamable HTTP bridge\n\n'
    + `Endpoint: ${endpoint}\n`
    + `Token:    ${token ? 'set' : `NOT SET — run DSH once, or set DSH_AS_MCP_TOKEN (expected at ${tokenFilePath()})`}\n\n`
    + 'Environment:\n'
    + '  DSH_AS_MCP_URL    endpoint URL\n'
    + '  DSH_AS_MCP_TOKEN  bearer token\n'
    + '  DSH_HOME          harness home used to locate the persisted token\n\n'
    + 'Claude Code channel mode (research preview):\n'
    + '  --channel                    declare claude/channel and push one notification per ended\n'
    + '                               DSH session turn (or set DSH_AS_MCP_CHANNEL=1)\n'
    + '  --channel-scope=owned|all    owned (default): only sessions dispatched through this bridge;\n'
    + '                               all: every session except sub-agents (or DSH_AS_MCP_CHANNEL_SCOPE)\n',
  )
  process.exit(0)
}

if (!token) {
  log(`no bearer token found; set DSH_AS_MCP_TOKEN or start DSH once so ${tokenFilePath()} exists`)
}

// The token file is a machine-local credential. A copied or generated client
// config with an off-host URL would otherwise silently send it there, so a
// file-derived token may only travel to a loopback endpoint unless the token
// was set explicitly for this run.
if (token && !tokenIsExplicit && !isLoopbackUrl(endpoint)) {
  log(
    `refusing to send the persisted token (${tokenFilePath()}) to a non-loopback endpoint: ${endpoint}. `
    + 'Set DSH_AS_MCP_TOKEN explicitly if this endpoint is meant to receive it.',
  )
  process.exit(1)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pending = new Set()

for await (const line of lines) {
  // Dispatch without awaiting: MCP correlates replies by request id, so a slow
  // tool call must not block the next request on the same connection.
  const task = handleLine(line).finally(() => pending.delete(task))
  pending.add(task)
}

if (channelEnabled) {
  // A request parked on recovery must not hold the exit: give it a moment, then go.
  stdinClosed = true
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
} else {
  await Promise.allSettled([...pending])
}

// stdin is gone: the client is done, so stop reconnecting the push channel.
stdinClosed = true
stopPushChannel()

process.exit(0)
