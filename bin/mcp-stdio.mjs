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
 * There are no dependencies on purpose: this file has to run from a bare
 * `npx dsh-as-mcp`, from a `link:` install, and from a tarball alike.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

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
      delivered = await readPushStream(response)
    } catch (error) {
      if (signal.aborted) return
      const text = error instanceof Error ? error.message : String(error)
      if (!loggedInterruption) {
        log(`push channel interrupted: ${text}; reconnecting with backoff`)
        loggedInterruption = true
      }
    }

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

  const issuedSession = response.headers.get('mcp-session-id')
  if (issuedSession) sessionId = issuedSession

  // Notifications are acknowledged without a body.
  if (response.status === 202 || response.status === 204) return []
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail.trim()}` : ''}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) return await readEventStream(response)

  const body = await response.text()
  if (body.trim() === '') return []
  return [JSON.parse(body)]
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
    + '  DSH_HOME          harness home used to locate the persisted token\n',
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

await Promise.allSettled([...pending])

// stdin is gone: the client is done, so stop reconnecting the push channel.
stopPushChannel()

process.exit(0)
