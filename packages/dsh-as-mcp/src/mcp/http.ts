import { createServer, type Server } from 'node:http'

import { toNodeHandler, type NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'

import type { Config } from '../config.js'
import type { DshLogger } from '../dsh/types.js'
import { registerTools, type ToolDeps } from './tools.js'
import { presentedToken, tokenMatches } from './token.js'
import { SERVER_NAME, VERSION } from '../version.js'

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

/** Reply with a minimal, non-reflective error body. */
function deny(res: Parameters<NodeMcpRequestHandler>[1], status: number, body: string): void {
  const payload = Buffer.from(body, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
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
      const server = new McpServer({ name: SERVER_NAME, version: VERSION })
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
    void handler(req, res)
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
  const url = `http://${host}:${boundPort}${path}`
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
