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
 * Mask a token for display.
 *
 * The first four characters survive when the token is long enough that they are
 * a small part of it — the same "fingerprint" idea as the host's own log line,
 * so an operator can tell which credential is in force without being handed it.
 * A short token renders a fixed-width mask instead, rather than revealing itself
 * through its own length.
 *
 * @param token - the value to mask.
 */
export function maskSecret(token: string): string {
  const prefix = token.length > 8 ? token.slice(0, 4) : ''
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
