/**
 * Server-pushed turn-settlement events.
 *
 * `session_prompt { wait: false }` returns as soon as the message is admitted, so
 * the caller has nothing to observe and the documented path is polling
 * `session_status`. The modern (2026-07-28) protocol adds a server→client push
 * channel: a client opens one long-lived `subscriptions/listen` stream and names
 * the change feeds it wants, and the server may publish to it at any time. The
 * MCP SDK owns that stream and its filtering; this module owns the plugin side —
 * one subscription bus per endpoint, and a typed publish call for the driver.
 *
 * Two facts make this work without touching the stateless legacy serving:
 *
 * - `createMcpHandler` takes a `bus` option and returns `notify`, a facade that
 *   publishes onto it (`@modelcontextprotocol/server`'s `McpHttpHandler`). The bus
 *   is created once per handler, not per request, so a background watcher can
 *   publish after its tool call has already returned.
 * - The only payload-carrying event a subscription can receive is
 *   `notifications/resources/updated` for a URI the client listed. So a settled
 *   turn is announced as an update of a synthetic resource, and the resource is
 *   readable (`resources/read`) with the same payload as `session_status`.
 *
 * Legacy 2025 clients never open a listen stream (their `GET` is `405` in
 * stateless serving), so they are unaffected: they keep polling. Nothing here
 * changes what an unsubscribed client receives.
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

  /**
   * Bind the handler's publish facade.
   * @param notifier - `handler.notify` from `createMcpHandler`.
   */
  attach(notifier: ServerNotifier): void {
    this.notifier = notifier
  }

  hasSubscribers(): boolean {
    // `listenerCount` is the in-process bus's own introspection: one listener per
    // open listen stream, regardless of which feeds that stream asked for. It is
    // a coarse "is anyone listening" signal, which is all the watcher gate needs —
    // over-arming costs one watch, never a wrong notification (the SDK filters
    // per URI before anything reaches the wire).
    return this.notifier !== undefined && this.eventBus.listenerCount > 0
  }

  turnSettled(sessionId: string): void {
    // Safe when nothing is listening: the SDK treats a publish with no stream as a
    // no-op, and a stream that did not ask for this URI filters it out.
    this.notifier?.resourceUpdated(turnResourceUri(sessionId))
  }
}
