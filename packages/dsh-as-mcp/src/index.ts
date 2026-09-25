import type { Context } from '@deepseek-ai/cordis'

import { Config, normalizeConfig, optional, type Config as DshAsMcpConfig } from './config.js'
import { DshDriver } from './dsh/driver.js'
import { eventsOf, loggerOf, serviceOf } from './dsh/types.js'
import {
  createRequestHandler,
  mountOnWebServer,
  registerStatusRoute,
  startListener,
  type ConnectionLike,
  type EndpointHandle,
  type WebServerLike,
} from './mcp/http.js'
import { maskToken, resolveToken } from './mcp/token.js'
import type { ConnectionInfo, ToolDeps } from './mcp/tools.js'
import { installSettings } from './settings.js'
import { STATUS_ROUTE, type EndpointStatus } from './status.js'

/** Cordis plugin name. */
export const name = 'dsh-as-mcp'

/**
 * Nothing is a hard dependency.
 *
 * This plugin must load in a bare CLI profile with no web server, no session
 * service, and no filesystem seam, and then report precisely which capabilities
 * are missing. Declaring `inject` would instead make the loader refuse to mount
 * it, which is a worse answer for a capability bridge. Every service is
 * resolved lazily through `ctx.get`.
 */
export const inject: string[] = []

export { Config }
export { DshDriver, DshCapabilityError } from './dsh/driver.js'
export type {
  DirectoryEntry,
  SessionInfo,
  ToolCallInfo,
  TurnResult,
  TranscriptMessage,
  WorkspaceInfo,
} from './dsh/driver.js'
export type { Config as DshAsMcpConfig }
export { SETTINGS_NAMESPACE } from './settings.js'

export type { EndpointStatus } from './status.js'

/**
 * Expose this DeepSeek Harness as an MCP server.
 *
 * The endpoint is bearer-token guarded, serves Streamable HTTP, and is backed
 * by this process's own harness services — so a session created through MCP
 * appears live in the DSH UI and runs under the same sandbox and permission
 * policy as any other session.
 *
 * Nothing here is captured once. The configuration is read through a getter, so
 * an edit in the settings panel reaches the next request, and a change to the
 * bind parameters (enabled, host, port, path, mountOnWebServer) is reconciled by
 * moving the listener.
 */
export function apply(ctx: Context, config: DshAsMcpConfig): void {
  const log = loggerOf(ctx)
  const entry = normalizeConfig(config)

  // The configured/file token is resolved once: it is the fallback whenever the
  // effective configuration pins no token of its own.
  const fallbackToken = resolveToken(entry.auth.token)

  let listener: EndpointHandle | undefined
  let unmountFromWebServer: (() => void) | undefined
  let boundSignature = ''
  let listenError: string | null = null

  const binding = installSettings({
    ctx,
    entry,
    log,
    onChange: () => {
      void reconcile()
    },
  })

  const getConfig = (): DshAsMcpConfig => binding.current()

  /**
   * The token a request must present.
   *
   * Read per request, so pinning or rotating one in the settings panel takes
   * effect without a restart. An empty value means "inherit": the composition
   * token when it pins one, otherwise the generated file token.
   */
  const effectiveToken = (): { token: string; source: string; file: string } => {
    const pinned = optional(getConfig().auth.token)
    if (pinned !== undefined) {
      return { token: pinned, source: binding.registered() ? 'settings' : 'config', file: fallbackToken.file }
    }
    return { token: fallbackToken.token, source: fallbackToken.source, file: fallbackToken.file }
  }

  const status = (): EndpointStatus => {
    const current = getConfig()
    const advertisedHost = current.http.host === '0.0.0.0' ? '127.0.0.1' : current.http.host
    return {
      listening: listener !== undefined,
      url: listener?.url ?? `http://${advertisedHost}:${current.http.port}${current.http.path}`,
      mountedOnWebServer: unmountFromWebServer !== undefined,
      error: listenError,
      tokenSource: effectiveToken().source,
      settingsRegistered: binding.registered(),
      tokenFile: fallbackToken.file,
      enabledToolGroups: Object.entries(current.tools)
        .filter(([, on]) => on)
        .map(([group]) => group),
    }
  }

  const connection = (): ConnectionInfo => {
    const token = effectiveToken()
    return {
      url: status().url,
      token: token.token,
      tokenSource: token.source,
      mountedOnWebServer: unmountFromWebServer !== undefined,
    }
  }

  const deps: ToolDeps = { driver: new DshDriver(ctx, getConfig), getConfig, connection, status, log }

  const requestHandler = createRequestHandler({
    deps,
    getToken: () => effectiveToken().token,
    log,
  })

  /** Everything that decides *where* the endpoint lives. */
  const signatureOf = (current: DshAsMcpConfig): string => [
    current.http.enabled,
    current.http.host,
    current.http.port,
    current.http.path,
    current.http.mountOnWebServer,
  ].join('|')

  /** Move the endpoint to match the current configuration. */
  const reconcile = async (): Promise<void> => {
    const current = getConfig()
    const signature = signatureOf(current)
    if (signature === boundSignature) return
    boundSignature = signature

    unmountFromWebServer?.()
    unmountFromWebServer = undefined
    const previous = listener
    listener = undefined
    await previous?.dispose()

    if (current.http.enabled) {
      try {
        listener = await startListener({ config: current, handler: requestHandler.handle, log })
        listenError = null
      } catch (error) {
        listenError = error instanceof Error ? error.message : String(error)
        log.error(
          `[dsh-as-mcp] could not listen on ${current.http.host}:${current.http.port} — ${listenError}. `
          + 'Set http.port to a free port, or http.enabled=false to only mount on the DSH web server.',
        )
      }
    }

    if (current.http.mountOnWebServer) {
      const webServer = serviceOf<WebServerLike>(ctx, 'webServer')
      if (webServer === undefined) {
        log.warn('[dsh-as-mcp] http.mountOnWebServer is set but this profile has no webServer service')
      } else {
        unmountFromWebServer = mountOnWebServer({
          webServer,
          path: current.http.path,
          handler: requestHandler.handle,
          log,
        })
      }
    }
  }

  ctx.effect(() => {
    let disposed = false

    const initial = effectiveToken()
    if (getConfig().http.enabled || getConfig().http.mountOnWebServer) {
      log.info(
        '[dsh-as-mcp] bearer token %s; set auth.token in the plugin row or the settings panel to pin your own value',
        initial.source === 'generated' ? `generated at ${fallbackToken.file}` : `from ${initial.source}`,
      )
    }

    // The first reconcile is issued here rather than directly, because
    // registration completes asynchronously: by the time it resolves, a
    // user-layer port or path is known and is honoured on the very first bind.
    // The settings panel reads live endpoint state from here. Registered
    // unconditionally rather than under http.mountOnWebServer: that option is
    // about where the MCP endpoint is served, and tying the panel's own status
    // to it would hide the status exactly when a bind has just failed.
    //
    // Deliberately on the connection layer's `/api` channel and not on the raw
    // web server: an exact route on the web server sits in front of the connection
    // fence, which would expose endpoint state to anything that can reach the
    // port. Inside the fence it inherits DSH's own authorization.
    //
    // Waited for rather than sampled — see `installSettings`. Reading
    // `ctx.get('connection')` once here was measured returning `undefined` on a
    // real install, because a service mounts after the plugins that use it, and
    // the only symptom was a status route that silently never existed.
    ctx.inject(['connection'], (connectionCtx: Context) => {
      const connection = serviceOf<ConnectionLike>(connectionCtx, 'connection')
      if (connection === undefined) return
      // The route lives exactly as long as this injected fiber, which lives
      // exactly as long as the connection service is available here. Nothing
      // else needs to remember to take it down.
      connectionCtx.effect(
        () =>
          registerStatusRoute({
            connectionFetch: connection.fetch,
            path: STATUS_ROUTE,
            build: status,
            log,
          }),
        'dsh-as-mcp status route',
      )
    })

    void reconcile().then(() => {
      if (disposed || listener === undefined) return
      const token = effectiveToken()
      log.info(
        '[dsh-as-mcp] point an MCP client at %s with header "Authorization: Bearer %s" — the full token is %s',
        listener.url,
        maskToken(token.token),
        token.source === 'config'
          ? 'the value pinned in the plugin config'
          : `in ${token.file}`,
      )
    })

    return async () => {
      disposed = true
      binding.release()
      unmountFromWebServer?.()
      unmountFromWebServer = undefined
      const current = listener
      listener = undefined
      await current?.dispose()
      await requestHandler.close()
    }
  }, 'dsh-as-mcp endpoint')

  // Registered unconditionally so the policy itself can change live: the handler
  // is a pass-through unless the current policy is `allow` and the request
  // belongs to a session this plugin started.
  ctx.effect(() => {
    const off = eventsOf(ctx).on('approval/request', (...args: unknown[]) => {
      const request = args[0] as { agent?: { session?: { id?: string } } } | undefined
      const next = args[1] as (() => unknown) | undefined
      if (getConfig().approval.policy !== 'allow') return typeof next === 'function' ? next() : undefined
      const sessionId = request?.agent?.session?.id
      if (sessionId !== undefined && deps.driver.ownsSession(sessionId)) return 'allowed-once'
      return typeof next === 'function' ? next() : undefined
    })
    return () => {
      off()
    }
  }, 'dsh-as-mcp approval answerer')

  if (entry.approval.policy === 'allow') {
    log.warn(
      '[dsh-as-mcp] approval.policy=allow — every approval request raised by a session this plugin '
      + 'created is approved automatically. Set approval.policy=inherit to disable.',
    )
  }
}
