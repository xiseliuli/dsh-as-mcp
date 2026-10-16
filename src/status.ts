/**
 * The endpoint's observable state.
 *
 * Its own module so both the plugin entry (which owns the state) and the tool
 * layer (which reports it to a caller) can name the same shape without an
 * import cycle.
 */

/**
 * The read-only route the settings panel polls for live state.
 *
 * Shared by the host (which registers it) and the browser half (which fetches
 * it). It is registered on DSH's *connection* channel rather than on the raw
 * web server, so it sits behind DSH's own authorization: only a browser session
 * that already authenticated with DSH can read it.
 */
export const STATUS_ROUTE = '/api/dsh-as-mcp/status'

/** What the settings panel and `dsh_info` report about the live endpoint. */
export interface EndpointStatus {
  /** Whether the plugin-owned listener is currently accepting connections. */
  readonly listening: boolean
  /** The endpoint URL, or the URL that would be used once listening. */
  readonly url: string
  /** Whether the endpoint is also served through DSH's own web server. */
  readonly mountedOnWebServer: boolean
  /** Why the last bind attempt failed, or `null`. */
  readonly error: string | null
  /** How the effective bearer token was obtained. */
  readonly tokenSource: string
  /**
   * The bearer token every request must present, so the panel can hand the user
   * a client snippet that works as pasted.
   *
   * This is the one place the literal is deliberately readable outside the host.
   * The alternative — the panel printing `<token>` — sends the user hunting
   * through `tokenFile` for a value the panel already knows, which is how a
   * working configuration turns into a support question. It is not a wider
   * disclosure: the route is inside DSH's authorization fence (see
   * {@link STATUS_ROUTE}), and whoever can read it can already drive this DSH,
   * read the same value out of the profile document, or call the endpoint.
   * `dsh_info` still reports only {@link tokenSource} — an MCP caller has
   * already authenticated with the token and echoing it would put a live
   * credential into every calling agent's transcript.
   */
  readonly token: string
  /** Whether the settings namespace is registered (a provider was available). */
  readonly settingsRegistered: boolean
  /** Where the generated token lives, so the panel can point the user at it. */
  readonly tokenFile: string
  /** Which tool groups the current configuration advertises. */
  readonly enabledToolGroups: readonly string[]
}
