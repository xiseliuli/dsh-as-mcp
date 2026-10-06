import type { Context } from '@deepseek-ai/cordis'

import { Config, normalizeConfig, optional, type Config as DshAsMcpConfig } from './config.js'
import { DshDriver } from './dsh/driver.js'
import { eventsOf, loggerOf, serviceOf } from './dsh/types.js'
import { describeTokenSource } from './mcp/token.js'
import {
  advertisedHost,
  createRequestHandler,
  isLoopbackHost,
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
  /** Set once the plugin is being torn down; every await in a reconcile re-checks it. */
  let disposed = false

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
    // What to report when nothing is listening depends on where the endpoint
    // actually lives: mounted on the DSH web server it is reachable only at
    // `<path>` there — the web server's host and port are not ours to know —
    // so the string must not read as a dialable URL.
    const url = listener?.url
      ?? (unmountFromWebServer !== undefined
        ? `${current.http.path} (served by the DSH web server; the plugin listener is disabled)`
        : `http://${advertisedHost(current.http.host)}:${current.http.port}${current.http.path}`)
    return {
      listening: listener !== undefined,
      url,
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

  /**
   * Move the endpoint to match the current configuration.
   *
   * Runs are serialized through a promise chain and re-check `disposed` after
   * every await. Both properties are load-bearing: settings edits arrive as one
   * `onChange` per field, so two reconciles genuinely overlap, and an overlapping
   * run used to assign `listener` after the previous run's teardown — leaking a
   * bound server on the old port while `status()` reported the new one. A
   * teardown that sampled `listener` before an in-flight reconcile assigned it
   * leaked that listener past plugin unload.
   */
  const reconcileNow = async (): Promise<void> => {
    try {
      const current = getConfig()
      const signature = signatureOf(current)
      if (signature === boundSignature) return

      unmountFromWebServer?.()
      unmountFromWebServer = undefined
      const previous = listener
      listener = undefined
      await previous?.dispose()
      if (disposed) return

      if (current.http.enabled) {
        try {
          const started = await startListener({ config: current, handler: requestHandler.handle, log })
          // The plugin may have been torn down while the bind was in flight;
          // dismantle what was just started rather than leaving it behind.
          if (disposed) {
            await started.dispose()
            return
          }
          listener = started
          listenError = null
          if (!isLoopbackHost(current.http.host)) {
            log.warn(
              '[dsh-as-mcp] http.host %s is not a loopback address: the bearer token is the only '
              + 'admission control on this endpoint. Keep it behind a gateway you trust.',
              current.http.host,
            )
          }
        } catch (error) {
          if (disposed) return
          listenError = error instanceof Error ? error.message : String(error)
          log.error(
            `[dsh-as-mcp] could not listen on ${current.http.host}:${current.http.port} — ${listenError}. `
            + 'Set http.port to a free port, or http.enabled=false to only mount on the DSH web server.',
          )
        }
      }

      if (current.http.mountOnWebServer) {
        if (disposed) return
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

      // Marked bound only now, once the run reached its end. Assigning this up
      // front made a reconcile that threw part-way — a web-server route already
      // taken, say — record its config as successfully applied, so every later
      // run with that same config returned at the guard above and the endpoint
      // stayed half-configured until an unrelated edit changed the signature.
      // A failure now leaves the old signature in place so the next run retries.
      boundSignature = signature
    } catch (error) {
      // A reconciliation failure must degrade to state and log, never to an
      // unhandled rejection: DSH exits the process on one, and `onChange` fires
      // this with no caller watching.
      if (!disposed) {
        log.error(
          '[dsh-as-mcp] endpoint reconciliation failed: %s',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  /** One reconcile at a time, in submission order. */
  let reconcileTail: Promise<void> = Promise.resolve()
  const reconcile = (): Promise<void> => {
    const run = reconcileTail.then(() => reconcileNow())
    // `reconcileNow` records its own failures, so the queue never sits on a
    // rejection and the `void reconcile()` callers need no catch of their own.
    reconcileTail = run.then(() => undefined)
    return run
  }

  ctx.effect(() => {
    const initial = effectiveToken()
    if (getConfig().http.enabled || getConfig().http.mountOnWebServer) {
      log.info(
        // Phrased to avoid a `bearer <word>` pair: DSH's log masker matches that
        // shape and replaces it, which turned this line into "bearer ****" and lost
        // the part that says where the credential came from.
        '[dsh-as-mcp] credential source: %s. Set auth.token in the plugin row or the settings panel to pin your own value.',
        describeTokenSource(initial),
      )
      if (initial.source === 'ephemeral') {
        // This endpoint cannot be authenticated by anyone: the token changes every
        // boot and only its fingerprint is logged, and a client reading the same
        // path gets whatever that path really is. Say so loudly — the alternative
        // is an operator staring at a 401 with no stated cause.
        log.warn(
          '[dsh-as-mcp] no usable token at %s: it is not a regular file (a symlink or a special file), '
          + 'so it was left alone and a per-process token was minted instead. That token is not '
          + 'persisted and cannot be read from disk, so no client can present it. Remove the object '
          + 'and restart to get a persisted token, or set auth.token to a fixed secret.',
          initial.file,
        )
      }
      if (initial.token.length < 16) {
        // A generated token is 43 characters, so this fires only for one the
        // operator chose. Warn rather than refuse: failing the boot over a weak
        // secret would strand an existing deployment, and the token is still a
        // gate — just a weaker one than the default.
        log.warn(
          '[dsh-as-mcp] the pinned bearer token is shorter than 16 characters. A short token is '
          + 'brute-forceable if http.host ever leaves loopback; prefer the generated token '
          + '(clear auth.token) or a long random secret.',
        )
      }
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
        '[dsh-as-mcp] MCP endpoint ready at %s — clients must present the auth header.',
        listener.url,
      )
      // Two lines, and deliberately no `Bearer <value>` adjacent pair. DSH's own
      // log masker matches the word "bearer" followed by anything and replaces the
      // rest of the line, which ate the half of this message that told an operator
      // where the credential lives. The fingerprint is not the secret, so masking
      // it hides the pointer without protecting anything.
      log.info(
        '[dsh-as-mcp] credential fingerprint %s, %s',
        maskToken(token.token),
        describeTokenSource(token),
      )
    })

    return async () => {
      disposed = true
      binding.release()
      // An in-flight reconcile is mid-teardown or mid-bind right now, and it
      // re-checks `disposed` after every await — letting it settle first is what
      // makes the `listener` read below final instead of a sample that misses a
      // handle assigned moments later.
      await reconcileTail
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
      const request = args[0] as
        | { agent?: { id?: string; session?: { id?: string } } }
        | undefined
      const next = args[1] as (() => unknown) | undefined
      if (getConfig().approval.policy !== 'allow') return typeof next === 'function' ? next() : undefined
      // `agent.id` is the SessionId the public `ApprovalRequestEvent` contract
      // declares, so it is read first. `agent.session.id` is the same value on
      // the shipped harness, but the published `Agent` declaration carries only
      // `id`; keeping it as a fallback costs nothing and survives a host that
      // exposes the richer object without the flat one.
      const sessionId = request?.agent?.id ?? request?.agent?.session?.id
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
