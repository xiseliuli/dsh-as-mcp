import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import { toNodeHandler, toWebRequest, type NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
  legacyStatelessFallback,
  type JSONRPCMessage,
  type LegacyHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server'

import type { Config } from '../config.js'
import type { DshLogger } from '../dsh/types.js'
import { EndpointPushes } from './push.js'
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
  'When several sessions of one workspace should each work in an isolated Git checkout, pass worktree: true (or',
  '{ name, from }) to session_create, or call worktree_create for an existing session. A session created with',
  'workspaceId keeps its place in that workspace group while its tools, commands and prompts run in the new',
  'checkout (a cwd-only session stays ungrouped). The reply carries the worktree record (path, branch, baseCommit,',
  'repositoryRoot) — keep it for worktree_restore. session_status.workingDirectory and session_list',
  '{ includeWorktree } show where each session is working. Profiles without the forge bundle have no worktrees',
  'service; dsh_info reports that as harnessServices.worktrees.',
  '',
  'Sessions can also be archived and pinned — the same registry sets the DSH sidebar writes. Archive hides a',
  'session from the UI grouping and gates its turns without deleting its log; an active session is refused unless',
  'stopActivity: true is passed. session_list reports each row\'s archived and pinned flags.',
  '',
  'Prefer session_prompt for work that needs judgement. file_read/file_write/file_list and shell_run act directly,',
  "without spending a model turn or tokens. dsh_tool_list and dsh_tool_call run this instance's own agent tools, but",
  'only the names listed there are reachable. dsh_info.toolAvailability names the tools this profile cannot serve and',
  'why, which is worth reading before planning a sequence of calls.',
  '',
  'To inspect a session while it runs: session_messages with includeToolCalls lists what the agent invoked (and',
  'whether each call has answered), session_tool_result fetches one recorded result by call id or tool name, and',
  'session_list with origin=root|subagent shows the agent tree. session_search finds conversations by message',
  'content when the deployment has enabled the session-query index (dsh_info { probeSearch: true } says whether).',
  '',
  'Work started with session_prompt { wait: false } needs its own reporting: call session_status to learn whether the',
  'session is still running, which turn is open, how long its log has been quiet (stalled after a minute of silence),',
  'and — when it ended — why, including failure reasons such as error, blocked, max-tokens or interrupted (a',
  'completed turn carries no failure block). Pass waitMs to hold the call until something changes instead of polling',
  'on a guessed interval. A session_prompt that',
  'waits already reports the same facts: its reply carries turn.failure for an abnormal ending, and a client that',
  'sends a progressToken gets progress notifications whose message includes the log silence.',
  '',
  'Do not poll what can be pushed. Modern (2026-07-28) clients open ONE subscriptions/listen stream and name the',
  'resources they want (notifications.resourceSubscriptions); the server then publishes',
  'notifications/resources/updated whenever one changes, and resources/read on that URI returns the JSON payload.',
  'Feeds, all under dsh://: dsh://sessions, dsh://jobs and dsh://jobs/<jobId>, and per session',
  'dsh://session/<sessionId>/turn (settlement of a fire-and-forget prompt), .../events (projected durable events:',
  'seq/type/turn/step/summary), .../assistant (live text/reasoning/tool deltas), .../status (same as session_status)',
  'and .../projections (workingDirectory, worktree, goal, plan, todos, agentPreset, title). Open the',
  'listen stream BEFORE prompting; a notification only names the URI, so read it for the data. Event and assistant',
  'feeds carry a monotonic seq, so a client can drop repeats. 2025-era clients get the same notifications on a',
  'long-lived GET channel instead: initialize returns Mcp-Session-Id, then GET this same URL with that header and',
  'Accept: text/event-stream, after resources/subscribe. A 2025 client that ignores the session id keeps the old',
  'stateless request/response behavior (GET is 405 for it), so polling still works as a fallback.',
  '',
  'To control queued work: session_queue lists the pending inbox and can remove, edit or steer one message before it',
  'runs; session_cancel stops the running turn. If session.scope is "owned", all of these are limited to sessions this',
  'endpoint created or forked.',
  '',
  'The bearer token is the whole security boundary: a holder can read files, run commands, and read transcripts on',
  'this machine. Do not print it into a shared transcript.',
].join('\n')

/** A live MCP endpoint and the disposer that tears it down. */
export interface EndpointHandle {
  /** The URL an MCP client should POST to. */
  readonly url: string
  /**
   * Release the listener; safe to call twice.
   *
   * An open Streamable-HTTP GET stream is an active connection that never ends
   * on its own, so teardown drops live sockets instead of waiting for clients
   * to hang up (a settings change or an unload must not stall on one).
   */
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
  /**
   * The endpoint's server-push surface.
   *
   * Supplied by the plugin so the driver, which arms the watchers, and the HTTP
   * handler, which owns the subscription bus, share one object. Omitted in tests
   * that do not exercise push; the handler then creates its own (still owned by
   * no watcher, so nothing is ever published).
   */
  readonly pushes?: EndpointPushes
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

/** A human-readable message for an unknown thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Most stateful 2025-era sessions one endpoint keeps at once.
 *
 * Every session is one live server instance and, once a client opens it, one
 * long-lived SSE stream; an unbounded map would let a token holder pin an
 * arbitrary number of both. Eight is far more than the one-or-two concurrent
 * 2025 clients a DSH endpoint actually sees, and an evicted client recovers by
 * re-initializing (a 404 tells it its session is gone).
 */
const MAX_LEGACY_SESSIONS = 8

/** Idle time after which a stateful 2025-era session is closed. */
const LEGACY_SESSION_IDLE_MS = 30 * 60 * 1000

/** How often {@link LegacySessionManager} sweeps idle sessions. */
const LEGACY_SESSION_SWEEP_MS = 60 * 1000

/** One stateful 2025-era session: its server, transport and last-use stamp. */
interface LegacySession {
  readonly server: McpServer
  readonly transport: WebStandardStreamableHTTPServerTransport
  /** Last request served on this session, for capacity and idle eviction. */
  lastSeen: number
}

/**
 * A JSON-RPC error body shaped like the SDK transports' own error answers.
 *
 * Unknown-session answers must stay indistinguishable from the transport's
 * `404 Session not found`, so a client cannot tell which leg refused it.
 */
function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Whether a parsed request body carries an `initialize` JSON-RPC request. */
function carriesInitialize(body: unknown): boolean {
  return messagesOf(body).some((message) =>
    isInitializeRequest(message as unknown as JSONRPCMessage),
  )
}

/**
 * The stateful 2025-era Streamable HTTP leg.
 *
 * A 2025 MCP client may POST the `initialize` handshake without a session and
 * then expect the server to remember it: subsequent POSTs carry the
 * `Mcp-Session-Id` header, and a long-lived `GET` with `Accept:
 * text/event-stream` is the channel on which the server pushes notifications.
 * The stateless serving this endpoint used before cannot do either (it answers
 * every POST from a fresh instance and `GET`/`DELETE` with 405), so this class
 * owns one server + transport per session and routes by the header.
 *
 * It keeps three behaviours intact:
 *
 * - **Backward compatibility.** A legacy POST with no session id that is not an
 *   `initialize` is still answered statelessly by
 *   {@link legacyStatelessFallback}, so a client that ignores the response
 *   header keeps working exactly as before.
 * - **SDK fidelity.** Requests for a known session go straight to that
 *   transport, which owns session validation, `MCP-Protocol-Version` checks and
 *   per-request SSE framing; a `/mcp`-less or stale session id is answered 404
 *   with the same body the transport emits.
 * - **Bounded memory.** At most {@link MAX_LEGACY_SESSIONS} sessions, closed
 *   after {@link LEGACY_SESSION_IDLE_MS} of silence; both paths close the
 *   transport (which ends its streams) and the server.
 *
 * Resumability (`Last-Event-ID` replay) is deliberately not implemented: it
 * would need a bounded event store per session, while every published
 * notification is payload-less and names a resource the client re-reads over
 * `resources/read`. A client whose GET stream drops reconnects without a
 * cursor and refetches; see the P1 report/CHANGELOG for that limitation.
 */
class LegacySessionManager {
  private readonly sessions = new Map<string, LegacySession>()
  private readonly stateless: LegacyHttpHandler
  private readonly factory: McpServerFactory
  private readonly log: DshLogger
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(input: { readonly factory: McpServerFactory; readonly log: DshLogger }) {
    this.factory = input.factory
    this.log = input.log
    this.stateless = legacyStatelessFallback(
      this.factory,
      (error) => this.log.warn('[dsh-as-mcp] 2025-era request rejected:', error.message),
      { maxRequestBodySize: MAX_REQUEST_BYTES },
    )
    const timer = setInterval(() => this.evictIdle(), LEGACY_SESSION_SWEEP_MS)
    // The sweep must never keep the host process (or a test run) alive.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    this.sweepTimer = timer
  }

  /** Open sessions; the push fanout arms while this is non-zero. */
  get size(): number {
    return this.sessions.size
  }

  /** Serve one 2025-era request, opening a session on `initialize`. */
  async handle(request: Request, body: unknown): Promise<Response> {
    const method = request.method.toUpperCase()
    const sessionId = request.headers.get('mcp-session-id')
    if (sessionId === null) {
      // Only an initialize opens a session. Everything else keeps the old
      // stateless serving — including its 405 for GET/DELETE.
      if (method !== 'POST' || !carriesInitialize(body)) {
        return await this.stateless(request, { parsedBody: body })
      }
      return await this.open(request, body)
    }
    const session = this.sessions.get(sessionId)
    if (session === undefined) return jsonRpcErrorResponse(404, -32001, 'Session not found')
    session.lastSeen = Date.now()
    return await session.transport.handleRequest(request, { parsedBody: body })
  }

  /** Publish one resource update to every live session, best effort. */
  notifyResourceUpdated(uri: string): void {
    for (const [sessionId, session] of this.sessions) {
      try {
        void Promise.resolve(session.server.server.sendResourceUpdated({ uri })).catch((error: unknown) => {
          this.log.warn('[dsh-as-mcp] 2025-era push to session %s failed: %s', sessionId, errorText(error))
        })
      } catch (error) {
        this.log.warn('[dsh-as-mcp] 2025-era push to session %s failed: %s', sessionId, errorText(error))
      }
    }
  }

  /** Close every session and stop the sweep timer; safe to call twice. */
  async close(): Promise<void> {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => this.dispose(session.server, session.transport)))
  }

  /**
   * Open one session around an `initialize` request.
   *
   * The transport generates the id, calls `onsessioninitialized` before it
   * answers, and registers the session in the map from there; a rejected
   * initialize (no id was ever generated) leaves nothing behind.
   */
  private async open(request: Request, body: unknown): Promise<Response> {
    this.evictOverCapacity()
    let server: McpServer | undefined
    let transport: WebStandardStreamableHTTPServerTransport | undefined
    try {
      server = await this.createServer(request)
      const created = server
      let entry: LegacySession | undefined
      const opened = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          // Two initializes can race past `open`'s capacity check; enforce the
          // bound again at registration so the map can never end up over it.
          if (entry === undefined) return
          this.evictOverCapacity()
          this.sessions.set(sessionId, entry)
        },
        onsessionclosed: (sessionId) => {
          this.evict(sessionId)
        },
      })
      transport = opened
      entry = { server: created, transport: opened, lastSeen: Date.now() }
      opened.onerror = (error) => {
        this.log.warn('[dsh-as-mcp] 2025-era transport error:', error.message)
      }
      // `Server.connect` chains an existing `onclose` rather than replacing it,
      // so a transport closed from anywhere (eviction included) still drops its
      // entry from the map.
      opened.onclose = () => {
        for (const [sessionId, candidate] of this.sessions) {
          if (candidate.transport === opened) {
            this.sessions.delete(sessionId)
            return
          }
        }
      }
      await created.connect(opened)
      const response = await opened.handleRequest(request, { parsedBody: body })
      if (opened.sessionId === undefined) await this.dispose(created, opened)
      return response
    } catch (error) {
      await this.dispose(server, transport)
      throw error
    }
  }

  /** Build the server side of one session. */
  private async createServer(request: Request): Promise<McpServer> {
    const product = await this.factory({ era: 'legacy', requestInfo: request })
    if (!(product instanceof McpServer)) {
      throw new TypeError('the 2025-era session factory must return an McpServer')
    }
    return product
  }

  /** Remove one session from the map and close it, best effort. */
  private evict(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    this.sessions.delete(sessionId)
    void this.dispose(session.server, session.transport)
  }

  /** Close every session that has been silent past the idle window. */
  private evictIdle(): void {
    const cutoff = Date.now() - LEGACY_SESSION_IDLE_MS
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.lastSeen > cutoff) continue
      this.log.info('[dsh-as-mcp] closing idle 2025-era session %s', sessionId)
      this.evict(sessionId)
    }
  }

  /** Evict least-recently-used sessions until a new one fits under the cap. */
  private evictOverCapacity(): void {
    while (this.sessions.size >= MAX_LEGACY_SESSIONS) {
      let oldestId: string | undefined
      let oldest = Number.POSITIVE_INFINITY
      for (const [sessionId, session] of this.sessions) {
        if (session.lastSeen >= oldest) continue
        oldest = session.lastSeen
        oldestId = sessionId
      }
      if (oldestId === undefined) return
      this.log.info('[dsh-as-mcp] evicting 2025-era session %s to stay under the cap', oldestId)
      this.evict(oldestId)
    }
  }

  /** Close the transport then the server; every failure is deliberately quiet. */
  private async dispose(
    server: McpServer | undefined,
    transport: WebStandardStreamableHTTPServerTransport | undefined,
  ): Promise<void> {
    if (transport !== undefined) {
      await transport.close().catch(() => {})
    }
    if (server !== undefined) {
      // `McpServer.close` closes the transport too, which is idempotent.
      await server.close().catch(() => {})
    }
  }
}

/**
 * Write one Web-standard `Response` back to a Node response.
 *
 * This is the same conversion `toNodeHandler` performs, kept here because the
 * 2025-era leg gets its `Response` itself. Differences that matter for a
 * long-lived GET SSE stream:
 *
 * - headers are flushed immediately, because the transport may not emit its
 *   first frame for a while and a client that waits for headers would stall;
 * - writes respect backpressure (`drain`) and stop at the first `close`;
 * - a client disconnect cancels the response body, which is what releases the
 *   transport's per-session stream mapping and lets the client reconnect.
 */
async function writeWebResponse(
  res: Parameters<NodeMcpRequestHandler>[1],
  response: Response,
  onerror: (error: Error) => void,
): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  try {
    res.writeHead(response.status, headers)
  } catch (error) {
    onerror(error instanceof Error ? error : new Error(String(error)))
    return
  }
  const body = response.body
  if (body === null) {
    res.end()
    return
  }
  const flushHeaders = (res as { flushHeaders?: () => void }).flushHeaders
  if (typeof flushHeaders === 'function') flushHeaders.call(res)

  let clientClosed = false
  const closed = new Promise<void>((resolve) => {
    res.on('close', () => {
      clientClosed = true
      resolve()
    })
  })
  const reader = body.getReader()
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), closed.then(() => undefined)])
      if (next === undefined) break
      if (next.done) break
      if (next.value === undefined) continue
      if (res.write(next.value) === false) {
        await Promise.race([
          new Promise<void>((resolve) => res.on('drain', () => resolve())),
          closed,
        ])
        if (clientClosed) break
      }
    }
  } catch (error) {
    onerror(error instanceof Error ? error : new Error(String(error)))
  } finally {
    // Cancelling a finished stream is a no-op; on a disconnect it runs the
    // transport's stream teardown (dropping the session's standalone SSE slot).
    await reader.cancel().catch(() => {})
  }
  if (!clientClosed) res.end()
}

/**
 * Wrap the SDK's Node handler with bearer-token admission.
 *
 * DSH's own web server answers unauthenticated browser traffic with 403, and a
 * plugin-registered exact route sits in front of that fallback — so this route
 * has to enforce its own admission or it would be the one unauthenticated hole
 * in the surface.
 *
 * Admission happens here for every method, including the 2025-era long-lived
 * `GET` stream, because the stateful leg is served from this same handler.
 */
export function createRequestHandler(options: RequestHandlerOptions): RequestHandler {
  const { deps, getToken, log } = options
  const pushes = options.pushes ?? new EndpointPushes()

  // One shared factory defines the endpoint's surface once, so the modern
  // per-request leg, the 2025-era stateless fallback and every stateful 2025
  // session can never drift apart.
  const factory: McpServerFactory = () => {
    const server = new McpServer(
      { name: SERVER_NAME, version: VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    )
    registerTools(server, deps)
    return server
  }

  // The modern (2026-07-28) leg is served per request: `createMcpHandler` owns
  // its lifetime, and our tools are stateless beyond the driver. `legacy:
  // 'reject'` keeps it strict — 2025-era traffic is routed to the stateful
  // manager below instead of this entry's stateless fallback.
  const handler = createMcpHandler(factory, {
    // The subscription bus is created once per handler (not per request), which
    // is what lets a background watcher publish a turn-settlement event after
    // the tool call that started the turn has already returned.
    bus: pushes.eventBus,
    // The default response mode is kept deliberately: forcing
    // `responseMode: 'json'` makes the SDK warn on every boot and drops
    // mid-call notifications. Both eras read either framing.
    legacy: 'reject',
    onerror: (error) => log.warn('[dsh-as-mcp] request rejected:', error.message),
  })
  // The driver arms watchers before this handler exists, so the link is made
  // here, once: publishes go through the handler's own bus and its per-stream
  // filtering.
  pushes.attach(handler.notify)

  // The 2025-era stateful leg. Its sessions are the other subscriber the push
  // surface must feed: a settled turn reaches a 2025 client as
  // `notifications/resources/updated` on its long-lived GET stream.
  const legacy = new LegacySessionManager({ factory, log })
  pushes.attachLegacy({
    hasSessions: () => legacy.size > 0,
    resourceUpdated: (uri) => legacy.notifyResourceUpdated(uri),
  })

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
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      if (res.destroyed === true) abort.abort()
      let request: Request
      try {
        // The body was parsed above; building the Web request from that value
        // keeps the Node stream unread (it is only ever read for a POST) and
        // gives both the era decision and the 2025-era transport one request.
        request = await toWebRequest(req, body, {
          signal: abort.signal,
          maxRequestBodySize: MAX_REQUEST_BYTES,
        })
      } catch (error) {
        log.warn('[dsh-as-mcp] could not convert the request:', errorText(error))
        deny(res, 500, 'internal error')
        return
      }

      if (await isLegacyRequest(request, body)) {
        // 2025-era traffic — the stateful session flow, or the stateless
        // fallback for clients that ignore the session header. The manager
        // hands back a Web Response, which is streamed to the Node response.
        await writeWebResponse(res, await legacy.handle(request, body), (error) => {
          log.warn('[dsh-as-mcp] 2025-era response failed:', error.message)
        })
      } else {
        // 2026-07-28 traffic keeps the SDK adapter (and its per-request
        // lifetime); the body is handed over parsed, never re-read.
        await node(req, res, body)
      }
    } finally {
      if (prompt !== undefined) promptRequests.delete(prompt.requestId)
    }
  }

  return {
    handle: guard,
    close: async () => {
      // Stop the 2025-era sessions first: closing a transport ends its SSE
      // stream, which is what lets an in-flight write finish and the listener
      // close cleanly.
      await legacy.close()
      await handler.close()
    },
  }
}

/**
 * How long {@link startListener}'s dispose lets in-flight exchanges finish
 * before the remaining sockets are dropped.
 *
 * A settings change or a plugin unload cannot wait for a long-lived SSE client
 * to go away, but a short grace keeps an ordinary request that is just finishing
 * from being cut off needlessly.
 */
const LISTENER_DRAIN_MS = 500

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
      await new Promise<void>((resolve) => {
        let settled = false
        let forceTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (): void => {
          if (settled) return
          settled = true
          if (forceTimer !== undefined) clearTimeout(forceTimer)
          resolve()
        }
        server.close(finish)
        // `server.close` waits for every active connection to end, and a 2025-era
        // GET notification stream (like a modern `subscriptions/listen` stream)
        // is active by design and never ends on its own. After a short grace for
        // ordinary in-flight requests, drop the sockets: otherwise a settings
        // change on unload would hang until every client disconnects.
        forceTimer = setTimeout(() => server.closeAllConnections(), LISTENER_DRAIN_MS)
        if (typeof forceTimer === 'object' && 'unref' in forceTimer) forceTimer.unref()
      })
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
