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

  const guard: NodeMcpRequestHandler = async (req, res, parsedBody) => {
    const presented = presentedToken(req.headers.authorization, queryToken(req.url))
    if (!tokenMatches(getToken(), presented)) {
      deny(res, 401, 'unauthorized')
      return
    }
    await node(req, res, parsedBody)
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
