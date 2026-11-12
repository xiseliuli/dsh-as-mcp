import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EndpointPushes, turnResourceUri } from '../src/mcp/push.js'
import { TOKEN, boot, readJsonRpc, stubDriver, testConfig } from './harness.js'

/**
 * The 2025-era stateful Streamable HTTP leg.
 *
 * A 2025 client expects the server to remember its `initialize` (so later POSTs
 * carry `Mcp-Session-Id`) and to keep a long-lived GET SSE stream open for
 * server→client notifications. These tests pin the routing that keeps that
 * client, the clients that ignore the session id, and the 2026-07-28 clients on
 * one endpoint — plus the push fanout that reaches the GET stream.
 */

const LEGACY_PROTOCOL = '2025-06-18'
const MODERN_PROTOCOL = '2026-07-28'

/** Headers every 2025-era request carries. */
function legacyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    ...extra,
  }
}

/** POST one JSON-RPC message over the 2025-era framing. */
async function legacyPost(
  url: string,
  message: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return await fetch(url, { method: 'POST', headers: legacyHeaders(extra), body: JSON.stringify(message) })
}

/** The wire body of an `initialize` request, as a pre-2026 client sends it. */
function initializeMessage(id: number, protocolVersion = LEGACY_PROTOCOL): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0' },
    },
  }
}

/** The wire body of a `tools/list` request. */
function toolsListMessage(id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} }
}

/** Headers for a `GET` server-notification stream (or the session operations). */
function sessionHeaders(sessionId: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    ...extra,
  }
}

/** The names in a `tools/list` result. */
function toolNames(body: Record<string, unknown>): string[] {
  const result = body.result as { tools?: { name?: string }[] } | undefined
  return (result?.tools ?? []).flatMap((tool) => (typeof tool.name === 'string' ? [tool.name] : []))
}

/** Headers one 2026-07-28 request carries (method header included). */
function modernHeaders(method: string): Record<string, string> {
  return legacyHeaders({ 'mcp-protocol-version': MODERN_PROTOCOL, 'mcp-method': method })
}

/** The per-request `_meta` envelope every 2026-07-28 request must carry. */
function modernEnvelope(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

/**
 * Open one stateful 2025 session and return its id.
 *
 * The initialize reply is an SSE stream that closes once the result is written,
 * so draining it is also what completes the handshake.
 */
async function openSession(url: string, id = 1): Promise<string> {
  const response = await legacyPost(url, initializeMessage(id))
  expect(response.status).toBe(200)
  const sessionId = response.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()
  const body = (await readJsonRpc(response, id)) as {
    result?: { serverInfo?: { name?: string } }
  }
  expect(body.result?.serverInfo?.name).toBe('dsh-as-mcp')
  return sessionId as string
}

/** Open the long-lived GET stream for one session. */
async function openStream(url: string, sessionId: string): Promise<{
  response: Response
  abort: () => void
}> {
  const controller = new AbortController()
  const response = await fetch(url, {
    method: 'GET',
    headers: sessionHeaders(sessionId, { accept: 'text/event-stream' }),
    signal: controller.signal,
  })
  return { response, abort: () => controller.abort() }
}

/**
 * Read SSE `data:` payloads until one is a `notifications/resources/updated`.
 *
 * Uses the raw wire (not a client SDK) so the test proves the bytes a 2025
 * client parses, and cancels the reader on the way out so the transport's
 * standalone-stream slot is released even when the test fails.
 */
async function readUntilResourceUpdate(response: Response, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const body = response.body
  if (body === null) throw new Error('expected an SSE response body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for notifications/resources/updated'))
    }, timeoutMs)
    timer.unref()
  })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline])
      if (next.done) throw new Error('the SSE stream ended before the notification arrived')
      buffer += decoder.decode(next.value, { stream: true })
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
          if (payload.method === 'notifications/resources/updated') return payload
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe('stateful 2025-era sessions', () => {
  let url = ''
  let pushes: EndpointPushes
  let stop: () => Promise<void> = async () => {}

  beforeAll(async () => {
    const booted = await boot(stubDriver(), testConfig())
    url = booted.url
    pushes = booted.pushes
    stop = booted.stop
  })

  afterAll(async () => {
    await stop()
    pushes.dispose()
  })

  it('mints a session id on a legacy initialize and answers the handshake', async () => {
    // The whole stateful leg is keyed on this header: without it a 2025 client
    // cannot open the GET stream and never receives a server notification.
    const response = await legacyPost(url, initializeMessage(1))
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBeTruthy()
    const body = (await readJsonRpc(response, 1)) as {
      result?: { protocolVersion?: string; instructions?: string }
    }
    expect(typeof body.result?.protocolVersion).toBe('string')
    expect(body.result?.instructions ?? '').toContain('dsh_info')
  })

  it('serves a later POST that carries the session id and negotiated version', async () => {
    // This is the request shape a spec-compliant 2025 client (and the stdio
    // bridge) sends after the handshake: session id plus the negotiated
    // MCP-Protocol-Version header, both validated by the SDK transport.
    const sessionId = await openSession(url, 2)
    const response = await legacyPost(url, toolsListMessage(3), {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': LEGACY_PROTOCOL,
    })
    expect(response.status).toBe(200)
    const body = await readJsonRpc(response, 3)
    expect(toolNames(body)).toContain('dsh_info')
  })

  it('accepts the initialized notification on the session', async () => {
    // The step every 2025 client sends right after the handshake: it is a
    // notification, so the answer is a bodyless 202, and it must not be treated
    // as a new stateless exchange.
    const sessionId = await openSession(url, 63)
    const response = await legacyPost(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'mcp-session-id': sessionId },
    )
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('still serves a stateless POST with no session id, even while a session exists', async () => {
    // Backward compatibility: a client that ignores the response header must
    // keep working exactly as it did against the stateless endpoint.
    await openSession(url, 4)
    const response = await legacyPost(url, toolsListMessage(5))
    expect(response.status).toBe(200)
    const body = await readJsonRpc(response, 5)
    expect(toolNames(body)).toContain('dsh_info')
  })

  it('keeps 2026-07-28 traffic on the modern per-request leg', async () => {
    // A modern request carries the per-request envelope and the standard
    // headers; it must not be answered by (or open) a 2025 session.
    const response = await fetch(url, {
      method: 'POST',
      headers: modernHeaders('tools/list'),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/list',
        params: { _meta: modernEnvelope() },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBeNull()
    const body = await readJsonRpc(response, 6)
    expect(toolNames(body)).toContain('dsh_info')
  })

  it('serves the modern server/discover handshake on the modern leg', async () => {
    // The 2026-07-28 handshake probe: no session header, no per-request state,
    // and the capabilities a modern client reads before it opens a listen stream.
    const response = await fetch(url, {
      method: 'POST',
      headers: modernHeaders('server/discover'),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 61,
        method: 'server/discover',
        params: { _meta: modernEnvelope() },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBeNull()
    const body = (await readJsonRpc(response, 61)) as {
      result?: { supportedVersions?: string[]; capabilities?: { resources?: { subscribe?: boolean } } }
    }
    expect(body.result?.supportedVersions).toContain(MODERN_PROTOCOL)
    expect(body.result?.capabilities?.resources?.subscribe).toBe(true)
  })

  it('negotiates a 2026 revision down when the client initializes without the envelope', async () => {
    // A claim-less initialize is a 2025-era handshake even when it names a 2026
    // revision (that is the SDK's precedence rule): it must open a stateful
    // session and answer with a revision the server actually serves, not fail.
    const response = await legacyPost(url, initializeMessage(62, MODERN_PROTOCOL))
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBeTruthy()
    const body = (await readJsonRpc(response, 62)) as { result?: { protocolVersion?: string } }
    expect(typeof body.result?.protocolVersion).toBe('string')
    expect(body.result?.protocolVersion).not.toBe(MODERN_PROTOCOL)
  })

  it('answers GET with no session id the old way (405), never opening a stream', async () => {
    const response = await fetch(url, {
      method: 'GET',
      headers: sessionHeaders(undefined, { accept: 'text/event-stream' }),
    })
    expect(response.status).toBe(405)
    await response.body?.cancel().catch(() => {})
  })

  it('answers 404 for a session id the endpoint does not know', async () => {
    const response = await fetch(url, {
      method: 'GET',
      headers: sessionHeaders('not-a-session', { accept: 'text/event-stream' }),
    })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: { code?: number; message?: string } }
    expect(body.error).toMatchObject({ code: -32001, message: 'Session not found' })
  })

  it('404s a POST that names an unknown session', async () => {
    const response = await legacyPost(url, toolsListMessage(7), { 'mcp-session-id': 'not-a-session' })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: { code?: number } }
    expect(body.error?.code).toBe(-32001)
  })

  it('rejects a GET stream without the bearer token', async () => {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': 'anything' },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
    await response.body?.cancel().catch(() => {})
  })

  it('pushes notifications/resources/updated onto an open GET stream', async () => {
    const sessionId = await openSession(url, 8)
    const stream = await openStream(url, sessionId)
    expect(stream.response.status).toBe(200)
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream')
    try {
      // Exactly what the driver does when a watched turn settles; the legacy
      // fanout turns it into a notification on every live session.
      pushes.resourceUpdated(turnResourceUri('session-1'))
      const notification = await readUntilResourceUpdate(stream.response)
      expect(notification).toMatchObject({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: turnResourceUri('session-1') },
      })
    } finally {
      stream.abort()
    }
  })

  it('closes a session on DELETE, after which the session id is unknown', async () => {
    const sessionId = await openSession(url, 9)
    const stream = await openStream(url, sessionId)
    expect(stream.response.status).toBe(200)

    const removed = await fetch(url, {
      method: 'DELETE',
      headers: sessionHeaders(sessionId),
    })
    expect(removed.status).toBe(200)

    const after = await fetch(url, {
      method: 'GET',
      headers: sessionHeaders(sessionId, { accept: 'text/event-stream' }),
    })
    expect(after.status).toBe(404)
    stream.abort()
  })
})

describe('stateful session capacity', () => {
  it('evicts the least recently used session when the cap is reached', async () => {
    // Eight concurrent 2025 sessions are more than a DSH endpoint ever sees; the
    // ninth initialize must push the oldest one out instead of growing the map.
    const booted = await boot(stubDriver(), testConfig())
    try {
      const sessionIds: string[] = []
      for (let index = 0; index < 9; index += 1) {
        sessionIds.push(await openSession(booted.url, 100 + index))
      }
      const oldest = sessionIds[0] as string
      const newest = sessionIds[8] as string

      const evicted = await fetch(booted.url, {
        method: 'GET',
        headers: sessionHeaders(oldest, { accept: 'text/event-stream' }),
      })
      expect(evicted.status).toBe(404)

      const live = await openStream(booted.url, newest)
      expect(live.response.status).toBe(200)
      live.abort()
    } finally {
      await booted.stop()
      booted.pushes.dispose()
    }
  })
})

describe('listener teardown', () => {
  it('does not wait for an open 2025 GET stream to hang up', async () => {
    // A stateful GET stream is an active HTTP connection by design; Node's
    // `server.close` waits for active connections, so teardown has to drop it
    // or a settings-change reconcile / plugin unload would stall indefinitely.
    const booted = await boot(stubDriver(), testConfig())
    const sessionId = await openSession(booted.url, 500)
    const stream = await openStream(booted.url, sessionId)
    expect(stream.response.status).toBe(200)
    try {
      const outcome = await Promise.race([
        booted.stop().then(() => 'stopped' as const),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 2_000)
          timer.unref()
        }),
      ])
      expect(outcome).toBe('stopped')
    } finally {
      stream.abort()
      booted.pushes.dispose()
    }
  })
})
