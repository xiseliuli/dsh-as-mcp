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
 * it). It carries no secret: the token is reported only as a source and a file
 * path, never as a value.
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
  /** Whether the settings namespace is registered (a provider was available). */
  readonly settingsRegistered: boolean
  /** Where the generated token lives, so the panel can point the user at it. */
  readonly tokenFile: string
  /** Which tool groups the current configuration advertises. */
  readonly enabledToolGroups: readonly string[]
}
