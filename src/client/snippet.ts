/**
 * The copyable MCP client configuration.
 *
 * Two texts come out of one snippet: what the panel *shows* and what the copy
 * button *writes*. They differ on purpose. The shown text masks the bearer
 * token, so a screenshot or a shared screen does not leak it; the copied text
 * carries the real value, because a snippet with `<token>` in it is not a
 * configuration — it is a note telling the user to go and find the token file
 * themselves, which is exactly the trip this panel exists to remove.
 *
 * @module dsh-as-mcp/client/snippet
 */

/** What the snippet carries when the host has not reported the token. */
export const TOKEN_PLACEHOLDER = '<token>'

/**
 * Render the snippet an MCP client accepts.
 * @param url - the endpoint URL the panel resolved.
 * @param token - the bearer value to embed: the real token, a mask, or the placeholder.
 */
export function clientSnippet(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        dsh: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}

/**
 * The host warns below 16 characters, so that is the line where a prefix is safe
 * to show: four characters of a 16-character token are a quarter of it, and of a
 * 9-character token they would be nearly half. A shorter token renders a
 * fixed-width mask instead of revealing itself through its own length or prefix.
 *
 * @param token - the value to mask.
 */
export function maskSecret(token: string): string {
  const prefix = token.length >= 16 ? token.slice(0, 4) : ''
  return `${prefix}${'•'.repeat(8)}`
}

/**
 * Name a token source for display.
 *
 * A host may report a source this bundle predates; rendering the raw string is
 * better than rendering a locale key, and better than claiming no token exists.
 *
 * @param t - the section's translator, which returns the key itself when it has no entry.
 * @param source - the host-reported source, or `undefined` when unknown.
 * @returns the label, or `undefined` when there is no source to name.
 */
export function sourceLabel(t: (key: string) => string, source: string | undefined): string | undefined {
  if (source === undefined) return undefined
  const key = `client.tokenSource.${source}`
  const text = t(key)
  return text === key ? source : text
}

/**
 * The endpoint URL the panel offers, or `undefined` until both the port and the path are
 * known.
 *
 * A half-read configuration used to render `http://127.0.0.1:` while the panel was still
 * loading — a URL that looks copyable and is not. Returning `undefined` lets the pane stay
 * hidden until the host has actually reported the shape of the endpoint.
 */
export function endpointUrl(host: unknown, port: unknown, path: unknown): string | undefined {
  const hostText = typeof host === 'string' && host !== '' ? host : '127.0.0.1'
  const portText = typeof port === 'number' && Number.isFinite(port) ? String(port) : ''
  const pathText = typeof path === 'string' && path.startsWith('/') ? path : ''
  if (portText === '' || pathText === '') return undefined
  // A wildcard bind is not dialable; the panel advertises what a client can reach.
  return `http://${hostText === '0.0.0.0' ? '127.0.0.1' : hostText}:${portText}${pathText}`
}

/**
 * Which endpoint URL to put in the panel's client configuration.
 *
 * Three sources disagree for good reasons and none is always right:
 *
 * - the live `status.url` is what the listener actually bound (a `port: 0` config is
 *   assigned a real port the mirror never sees), but it is stale for a draft edit and
 *   absent on an old host;
 * - `<page origin><path>` is the only true URL when the plugin listener is disabled and
 *   the endpoint is served by DSH's own web server — the browser is the one participant
 *   that knows that origin;
 * - the config mirror is the last resort, and the only source while the panel is still
 *   loading.
 *
 * A non-URL `status.url` (the mounted-only explanation string) is never dialable and is
 * ignored here.
 */
export function dialableEndpoint(input: {
  readonly statusUrl?: string
  readonly listening?: boolean
  readonly mounted?: boolean
  readonly pageOrigin?: string
  readonly path?: string
  readonly configUrl?: string
}): string | undefined {
  const isUrl = (text: string | undefined): text is string =>
    typeof text === 'string' && /^https?:\/\/[^/\s]+/.test(text)
  if (input.listening === true && isUrl(input.statusUrl)) return input.statusUrl
  if (
    input.mounted === true && input.listening === false &&
    typeof input.pageOrigin === 'string' && input.pageOrigin !== '' &&
    typeof input.path === 'string' && input.path.startsWith('/')
  ) {
    return `${input.pageOrigin.replace(/\/+$/, '')}${input.path}`
  }
  return input.configUrl
}
