import { createServer, type Server } from 'node:http'

import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'

import type { Config } from '../config.js'
import type { DshLogger } from '../dsh/types.js'
import { registerTools, type ToolDeps } from './tools.js'
import { presentedToken, tokenMatches } from './token.js'
import { SERVER_NAME, VERSION } from '../version.js'

/**
 * The workflow note an MCP client receives in its `initialize` result.
 *
 * The MCP spec calls this "instructions": free text a client may put in front of
 * its model. It is the one place to say what the endpoint *is* and how its tools
 * fit together, because a model that lists 20 tools and guesses the order will
 * reach for `shell_run` when `session_prompt` is the intended path. Kept short on
 * purpose — every sentence here is paid for on every connection.
 */
export const SERVER_INSTRUCTIONS = [
  'This is DeepSeek Harness exposed over MCP. Every call drives a real DSH agent session inside this instance;',
  'work appears live in the DSH UI and is subject to the same sandbox and permission policy.',
  '',
  'Call dsh_info first. It reports which harness services this profile provides, whether usage can be read, and the',
  'catalog of providers, agent presets and sandbox mode that session_create accepts.',
  '',
  'The usual flow is session_create, then session_prompt. session_prompt waits for the turn and returns the agent',
  'reply, every tool call it made, and the token usage it consumed (per turn and cumulative, with money when a price',
  'plugin is installed). Use session_usage when you need a receipt after the fact: DSH has no "session ended" event,',
  'and the tool reads the durable log, so it also answers after a session went idle.',
  '',
  'Prefer session_prompt for work that needs judgement. file_read/file_write/file_list and shell_run act directly,',
  "without spending a model turn or tokens. dsh_tool_list and dsh_tool_call run this instance's own agent tools, but",
  'only the names listed there are reachable.',
  '',
  'The bearer token is the whole security boundary: a holder can read files, run commands, and read transcripts on',
  'this machine. Do not print it into a shared transcript.',
].join('\n')

/** A live MCP endpoint and the disposer that tears it down. */
export interface EndpointHandle {
  /** The URL an MCP client should POST to. */
  readonly url: string
  /** Release the listener; safe to call twice. */
  dispose(): Promise<void>
}

/** Everything {@link createRequestHandler} needs. */
export interface RequestHandlerOptions {
  readonly deps: ToolDeps
  /**
   * The token every request must present, read per request so pinning or
   * rotating one in the settings panel takes effect without a restart.
   */
  readonly getToken: () => string
  readonly log: DshLogger
}

/** The guarded Node request handler plus the handler's own teardown. */
export interface RequestHandler {
  readonly handle: NodeMcpRequestHandler
  close(): Promise<void>
}

/** Largest request body the endpoint will accept when the client declares one. */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024

/**
 * Whether a request declares a body larger than {@link MAX_REQUEST_BYTES}.
 *
 * Checked from `Content-Length` before the body is read, so an oversized upload is
 * refused instead of buffered. A chunked request declares no length and is not
 * covered by this check; the endpoint is loopback-first and every tool that could
 * carry a large payload has its own cap, so this is defence in depth rather than
 * the primary bound.
 */
export function declaresOversizedBody(headers: { 'content-length'?: string | number | undefined }): boolean {
  const declared = headers['content-length']
  if (declared === undefined) return false
  const bytes = typeof declared === 'number' ? declared : Number(declared)
  return Number.isFinite(bytes) && bytes > MAX_REQUEST_BYTES
}

/**
 * The challenge a 401 carries.
 *
 * A bare 401 without `WWW-Authenticate` tells a standard MCP client that it is
 * unauthorized but not that a bearer token is the answer, so the client reports a
 * dead endpoint instead of retrying with its configured credential. The realm is
 * a fixed label, not the token: nothing here may echo the secret.
 */
const BEARER_CHALLENGE = 'Bearer realm="dsh-as-mcp"'

/** Reply with a minimal, non-reflective error body. */
function deny(res: Parameters<NodeMcpRequestHandler>[1], status: number, body: string): void {
  const payload = Buffer.from(body, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    ...(status === 401 ? { 'www-authenticate': BEARER_CHALLENGE } : {}),
  })
  res.end(payload)
}

/**
 * Reply with a JSON document (used where the SDK's own error shape is expected).
 */
function denyJson(
  res: Parameters<NodeMcpRequestHandler>[1],
  status: number,
  body: unknown,
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Read one request body, bounded.
 *
 * The authenticated guard reads the JSON itself instead of letting the transport
 * do it, because two things live only in the body: a `notifications/cancelled`
 * request id (the SDK version in use accepts the notification but does not abort
 * the in-flight handler for it) and which in-flight request belongs to which
 * session (what that cancellation has to stop). The parsed value is handed to the
 * transport through its `parsedBody` escape hatch, so nothing is read twice.
 */
async function readJsonBody(
  req: AsyncIterable<unknown>,
  limit: number,
): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    total += buffer.byteLength
    if (total > limit) return { ok: false, tooLarge: true }
    chunks.push(buffer)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, tooLarge: false }
  }
}

/** JSON-RPC messages in a body, flattened (MCP does not batch, but be safe). */
function messagesOf(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
  if (typeof body === 'object' && body !== null) return [body as Record<string, unknown>]
  return []
}

/** Request ids named by `notifications/cancelled` messages in this body. */
function cancelledRequestIds(body: unknown): string[] {
  const ids: string[] = []
  for (const message of messagesOf(body)) {
    if (message.method !== 'notifications/cancelled') continue
    const params = message.params as { requestId?: unknown } | undefined
    const requestId = params?.requestId
    if (typeof requestId === 'string' || typeof requestId === 'number') ids.push(String(requestId))
  }
  return ids
}

/** The `session_prompt` call in this body, if there is one: id and session. */
function promptCallOf(body: unknown): { requestId: string; sessionId: string } | undefined {
  for (const message of messagesOf(body)) {
    if (message.method !== 'tools/call') continue
    const params = message.params as { name?: unknown; arguments?: { sessionId?: unknown } } | undefined
    if (params?.name !== 'session_prompt') continue
    const sessionId = params.arguments?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (typeof message.id !== 'string' && typeof message.id !== 'number') continue
    return { requestId: String(message.id), sessionId }
  }
  return undefined
}

/**
 * The host a client should dial: a wildcard bind advertises loopback, because
 * `0.0.0.0` (or `::`) is not an address a client can connect to, while the
 * endpoint it stands for is reachable on the loopback interface.
 */
export function advertisedHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  return normalized === '0.0.0.0' || normalized === '::' ? '127.0.0.1' : host
}

/** Whether a listen host admits only the local machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

/** The `?token=` fallback, for clients that cannot set an `Authorization` header. */
function queryToken(url: string | undefined): string | null {
  if (url === undefined) return null
  const queryAt = url.indexOf('?')
  if (queryAt < 0) return null
  return new URLSearchParams(url.slice(queryAt + 1)).get('token')
}

/**
 * Wrap the SDK's Node handler with bearer-token admission.
 *
 * DSH's own web server answers unauthenticated browser traffic with 403, and a
 * plugin-registered exact route sits in front of that fallback — so this route
 * has to enforce its own admission or it would be the one unauthenticated hole
 * in the surface.
 */
export function createRequestHandler(options: RequestHandlerOptions): RequestHandler {
  const { deps, getToken, log } = options

  // One server instance per request: `createMcpHandler` owns the modern leg's
  // per-request lifetime, and our tools are stateless beyond the driver.
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: SERVER_NAME, version: VERSION },
        { instructions: SERVER_INSTRUCTIONS },
      )
      registerTools(server, deps)
      return server
    },
    {
      // `legacy: 'stateless'` answers every legacy request from a fresh server
      // instance, which is what makes this endpoint usable from a connectionless
      // caller. The default response mode is kept deliberately: forcing
      // `responseMode: 'json'` makes the SDK warn on every boot and does not
      // change the legacy framing, which is `text/event-stream` either way —
      // so `bin/mcp-stdio.mjs` reads both framings.
      legacy: 'stateless',
      onerror: (error) => log.warn('[dsh-as-mcp] request rejected:', error.message),
    },
  )

  const node = toNodeHandler(handler, {
    onerror: (error) => log.warn('[dsh-as-mcp] transport error:', error.message),
  })

  /**
   * In-flight `session_prompt` calls by JSON-RPC id, so a cancellation
   * notification can stop the turn that call is waiting on.
   *
   * The SDK version in use acknowledges `notifications/cancelled` and does
   * nothing else with it, so without this map a cancelled request would keep its
   * turn running and its handler waiting until the turn ended.
   */
  const promptRequests = new Map<string, string>()

  /** Stop the turn behind one cancelled request, without failing the handler. */
  const cancelForNotification = (requestId: string): void => {
    const sessionId = promptRequests.get(requestId)
    if (sessionId === undefined) return
    log.info(
      '[dsh-as-mcp] cancellation for request %s: cancelling the turn in session %s',
      requestId,
      sessionId,
    )
    void Promise.resolve(deps.driver.cancelSession(sessionId)).catch((error: unknown) => {
      log.warn(
        '[dsh-as-mcp] cancellation could not stop the turn: %s',
        error instanceof Error ? error.message : String(error),
      )
    })
  }

  const guard: NodeMcpRequestHandler = async (req, res, parsedBody) => {
    const presented = presentedToken(req.headers.authorization, queryToken(req.url))
    if (!tokenMatches(getToken(), presented)) {
      deny(res, 401, 'unauthorized')
      return
    }

    // The body is read here so a cancellation can be matched to its request; the
    // parsed value goes to the transport through its `parsedBody` escape hatch.
    let body = parsedBody
    if (body === undefined && req.method === 'POST') {
      if (declaresOversizedBody(req.headers)) {
        deny(res, 413, 'request body too large')
        // Drain rather than destroy so the client sees the 413 instead of a reset.
        ;(req as { resume?: () => void }).resume?.()
        return
      }
      const read = await readJsonBody(req, MAX_REQUEST_BYTES)
      if (!read.ok) {
        if (read.tooLarge) deny(res, 413, 'request body too large')
        else {
          denyJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error: Invalid JSON' },
            id: null,
          })
        }
        return
      }
      body = read.value
    }

    for (const requestId of cancelledRequestIds(body)) cancelForNotification(requestId)

    const prompt = promptCallOf(body)
    if (prompt !== undefined) promptRequests.set(prompt.requestId, prompt.sessionId)
    try {
      await node(req, res, body)
    } finally {
      if (prompt !== undefined) promptRequests.delete(prompt.requestId)
    }
  }

  return {
    handle: guard,
    close: async () => {
      await handler.close()
    },
  }
}

/** Start the plugin-owned listener. */
export async function startListener(input: {
  readonly config: Config
  readonly handler: NodeMcpRequestHandler
  readonly log: DshLogger
}): Promise<EndpointHandle> {
  const { config, handler, log } = input
  const { host, port, path } = config.http

  const server: Server = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0]
    if (pathname !== path) {
      deny(res, 404, 'not found')
      return
    }
    if (declaresOversizedBody(req.headers)) {
      deny(res, 413, 'request body too large')
      // Drain rather than destroy: the client gets the 413 it was owed instead of
      // a reset that looks like a network failure.
      req.resume()
      return
    }
    // The guard is async, so a rejection has to be caught here rather than
    // escape: DSH treats an unhandled rejection as fatal, and one failed
    // request must never take the host process down with it.
    void handler(req, res).catch((error: Error) => {
      log.error('[dsh-as-mcp] request handling failed:', error.message)
      if (res.headersSent) res.end()
      else deny(res, 500, 'internal error')
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  // Advertise a dialable host: a wildcard bind is reported as loopback, matching
  // what `status()` reports for the same configuration.
  const url = `http://${advertisedHost(host)}:${boundPort}${path}`
  log.info(`[dsh-as-mcp] MCP endpoint listening on ${url}`)

  return {
    url,
    dispose: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** The slice of `ctx.webServer` this plugin uses. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

/**
 * The in-fence route registrar DSH's connection service exposes.
 *
 * A route registered here sits *inside* the connection layer's Host/Origin and
 * browser-cookie fence, so it inherits DSH's own authorization instead of
 * re-implementing it. Registering the same path on the raw web server would put
 * it in front of that fence and require self-screening.
 */
export interface ConnectionFetchLike {
  register(route: {
    readonly path: string
    readonly methods: readonly string[]
    readonly requestBody: 'buffered'
    readonly fetch: (request: Request) => Promise<Response>
  }): () => void
}

/** The `connection` service, whose `fetch` member owns the `/api` channel. */
export interface ConnectionLike {
  readonly fetch: ConnectionFetchLike
}

/**
 * Serve one read-only JSON document to the settings panel.
 *
 * Same-origin with the web shell, so the browser can read it without tripping
 * over cross-origin rules — which is what makes live endpoint state available to
 * the panel at all. It is also where the panel gets the bearer token's literal,
 * so its Copy button can hand out a snippet that works as pasted; that is why
 * the route is registered on the connection layer, behind DSH's own
 * authorization, rather than on a bare port. `dsh_info` still reports only the
 * source, never the value.
 *
 * `build()` runs on every request, so nothing here is a cached reading, and a
 * throwing `build()` returns an empty document rather than failing the route.
 */
export function registerStatusRoute(input: {
  readonly connectionFetch: ConnectionFetchLike
  readonly path: string
  readonly build: () => unknown
  readonly log: DshLogger
}): () => void {
  const { connectionFetch, path, build, log } = input
  const dispose = connectionFetch.register({
    path,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => {
      let body: string
      try {
        body = JSON.stringify(build())
      } catch (error) {
        log.warn('[dsh-as-mcp] could not serialize the status payload', error)
        body = '{}'
      }
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        }),
      )
    },
  })
  log.info(`[dsh-as-mcp] settings panel status route registered at ${path}, inside DSH's auth fence`)
  return dispose
}

/**
 * Mount the same endpoint on DSH's own web server.
 *
 * Registering an exact route puts us in front of that server's SPA fallback, so
 * our own bearer check above stays authoritative.
 */
export function mountOnWebServer(input: {
  readonly webServer: WebServerLike
  readonly path: string
  readonly handler: NodeMcpRequestHandler
  readonly log: DshLogger
}): () => void {
  const { webServer, path, handler, log } = input
  const dispose = webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => handler(req as never, res as never),
  })
  log.info(`[dsh-as-mcp] MCP endpoint also mounted on the DSH web server at ${path}`)
  return dispose
}
