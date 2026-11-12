/**
 * Server-pushed change events for both MCP eras.
 *
 * `session_prompt { wait: false }` returns as soon as the message is admitted, so
 * the caller has nothing to observe and the documented path is polling. The modern
 * (2026-07-28) protocol adds a server→client push channel: a client opens one
 * long-lived `subscriptions/listen` stream naming the change feeds it wants, and
 * the server may publish to it at any time. The MCP SDK owns that stream and its
 * filtering; this module owns the plugin side — one subscription bus per endpoint,
 * the coalescing that keeps a token stream from becoming a notification storm, and
 * the fanout to 2025-era stateful sessions (whose long-lived GET SSE stream is fed
 * by the same events).
 *
 * Three facts make this work without touching tool requests:
 *
 * - `createMcpHandler` takes a `bus` option and returns `notify`, a facade that
 *   publishes onto it (`@modelcontextprotocol/server`'s `McpHttpHandler`). The bus
 *   is created once per handler, not per request, so a background watcher can
 *   publish after its tool call has already returned.
 * - The only payload-carrying event a subscription can receive is
 *   `notifications/resources/updated` for a URI the client listed. So every feed is
 *   a synthetic resource, and its `resources/read` returns the data. A settled turn
 *   is the original instance of this pattern.
 * - A 2025-era client cannot name a listen filter; its channel is the stateful
 *   Streamable HTTP GET stream, and the same publish call reaches it through
 *   {@link EndpointPushes.attachLegacy}.
 *
 * @module dsh-as-mcp/mcp/push
 */

import { InMemoryServerEventBus, type ServerNotifier } from '@modelcontextprotocol/server'

import type { TurnPushes } from '../dsh/driver.js'

/**
 * The synthetic resource one session's turn settlement is published on.
 *
 * The session id is encoded so a value that needs escaping cannot turn into a
 * different URI; the template in `tools.ts` decodes it back.
 *
 * @param sessionId - the DSH session whose turn is watched.
 */
export function turnResourceUri(sessionId: string): string {
  return `dsh://session/${encodeURIComponent(sessionId)}/turn`
}

/**
 * Minimum gap between two coalesced publishes of the same resource URI.
 *
 * A streaming assistant reply can produce a frame per token; one notification per
 * frame would make the client issue one `resources/read` per token. 150 ms is
 * below the threshold where a human notices a stall and well below what a fast
 * model emits. Turn settlement bypasses this (it is a discrete event a caller is
 * waiting for).
 */
export const PUSH_COALESCE_MS = 150

/**
 * The 2025-era stateful sessions a publish must also reach.
 *
 * Implemented by the HTTP handler's legacy-session manager; kept as an interface
 * here so this module does not depend on the transport, and so a profile that
 * serves modern traffic only can simply never attach one.
 */
export interface LegacyPushSessions {
  /**
   * Whether at least one stateful 2025 session is live.
   *
   * Deliberately coarse: a session with its SSE stream open is the only one that
   * can receive a publish, but counting every live session keeps this gate cheap
   * and over-arming costs one settlement watcher, never a wrong notification.
   */
  hasSessions(): boolean
  /** Publish `notifications/resources/updated` for `uri` to those sessions. */
  resourceUpdated(uri: string): void
}

/**
 * The endpoint's push surface, one per plugin instance.
 *
 * `eventBus` is handed to `createMcpHandler`, so this object (not the SDK) owns
 * the bus instance and can answer {@link hasSubscribers}. `attach` is called once
 * the handler exists: the notifier only exists with the handler, while the driver
 * that arms watchers is constructed before it, so the link is made in that gap.
 */
export class EndpointPushes implements TurnPushes {
  /** The subscription bus every `subscriptions/listen` stream registers on. */
  readonly eventBus = new InMemoryServerEventBus()

  private notifier: ServerNotifier | undefined
  private legacy: LegacyPushSessions | undefined

  /** Last publish instant per URI, for coalescing. */
  private readonly lastPublishedAt = new Map<string, number>()
  /** Trailing publishes waiting for their coalescing window to open. */
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Bind the handler's publish facade.
   * @param notifier - `handler.notify` from `createMcpHandler`.
   */
  attach(notifier: ServerNotifier): void {
    this.notifier = notifier
  }

  /**
   * Bind the legacy-session fanout.
   *
   * Called by the HTTP handler once its stateful 2025 manager exists. Re-attaching
   * (a re-created handler, a test) replaces the previous fanout.
   *
   * @param sessions - the 2025-era session fanout.
   */
  attachLegacy(sessions: LegacyPushSessions): void {
    this.legacy = sessions
  }

  hasSubscribers(): boolean {
    // `listenerCount` is the in-process bus's own introspection: one listener per
    // open listen stream, regardless of which feeds that stream asked for. It is
    // a coarse "is anyone listening" signal, which is all the watcher gate needs —
    // over-arming costs one watch, never a wrong notification (the SDK filters
    // per URI before anything reaches the wire). A stateful 2025 session is a
    // subscriber of the same events through a different transport.
    const modern = this.notifier !== undefined && this.eventBus.listenerCount > 0
    return modern || this.legacy?.hasSessions() === true
  }

  turnSettled(sessionId: string): void {
    // Deliberately immediate: this is the discrete event a caller is waiting for,
    // and it is published once per turn, not once per token.
    this.resourceUpdatedNow(turnResourceUri(sessionId))
  }

  /**
   * Publish a resource update, coalesced per URI.
   *
   * The first publish in a window goes out at once; later ones for the same URI
   * are collapsed into one trailing publish when the window opens. Different URIs
   * never wait on each other, so a busy session cannot starve another feed.
   *
   * @param uri - the resource whose update is announced.
   */
  resourceUpdated(uri: string): void {
    const now = Date.now()
    const wait = PUSH_COALESCE_MS - (now - (this.lastPublishedAt.get(uri) ?? 0))
    if (wait <= 0) {
      this.publish(uri, now)
      return
    }
    // A trailing publish is already queued for this URI: it will read the newest
    // data when it fires, so there is nothing to add.
    if (this.scheduled.has(uri)) return
    const timer = setTimeout(() => {
      this.scheduled.delete(uri)
      this.publish(uri, Date.now())
    }, wait)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    this.scheduled.set(uri, timer)
  }

  /**
   * Publish one resource update immediately, bypassing the coalescing window.
   *
   * @param uri - the resource whose update is announced.
   */
  resourceUpdatedNow(uri: string): void {
    this.publish(uri, Date.now())
  }

  /** Drop queued trailing publishes; safe to call twice. */
  dispose(): void {
    for (const timer of this.scheduled.values()) clearTimeout(timer)
    this.scheduled.clear()
    this.lastPublishedAt.clear()
    this.notifier = undefined
    this.legacy = undefined
  }

  private publish(uri: string, at: number): void {
    this.lastPublishedAt.set(uri, at)
    // Safe when nothing is listening: the SDK treats a publish with no stream as
    // a no-op, and a stream that did not ask for this URI filters it out.
    this.notifier?.resourceUpdated(uri)
    this.legacy?.resourceUpdated(uri)
  }
}
