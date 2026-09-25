/**
 * The endpoint's observable state.
 *
 * Its own module so both the plugin entry (which owns the state) and the tool
 * layer (which reports it to a caller) can name the same shape without an
 * import cycle.
 */

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
}
