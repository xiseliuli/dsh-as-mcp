import type { Context } from '@deepseek-ai/cordis'

import { Config, type Config as DshAsMcpConfig } from './config.js'
import { DshDriver } from './dsh/driver.js'
import { eventsOf, loggerOf, serviceOf } from './dsh/types.js'
import {
  createRequestHandler,
  mountOnWebServer,
  startListener,
  type EndpointHandle,
} from './mcp/http.js'
import { resolveToken } from './mcp/token.js'
import type { ConnectionInfo } from './mcp/tools.js'

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
  TranscriptMessage,
  TurnResult,
  WorkspaceInfo,
} from './dsh/driver.js'
export type { Config as DshAsMcpConfig }

/** The slice of `ctx.webServer` this plugin uses. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: never, res: never) => void | Promise<void>
  }): () => void
}

/**
 * Expose this DeepSeek Harness as an MCP server.
 *
 * The endpoint is bearer-token guarded, serves Streamable HTTP, and is backed
 * by this process's own harness services — so a session created through MCP
 * appears live in the DSH UI and runs under the same sandbox and permission
 * policy as any other session.
 */
export function apply(ctx: Context, config: DshAsMcpConfig): void {
  const log = loggerOf(ctx)
  const driver = new DshDriver(ctx, config)

  const { token, source, file } = resolveToken(config.auth.token)
  const advertisedHost = config.http.host === '0.0.0.0' ? '127.0.0.1' : config.http.host
  let url = `http://${advertisedHost}:${config.http.port}${config.http.path}`
  let mountedOnDshWebServer = false

  const connection = (): ConnectionInfo => ({
    url,
    token,
    tokenSource: source,
    mountedOnWebServer: mountedOnDshWebServer,
  })

  const requestHandler = createRequestHandler({
    deps: { driver, config, connection },
    token,
    log,
  })

  if (config.http.enabled || config.http.mountOnWebServer) {
    log.info(
      '[dsh-as-mcp] bearer token %s (%s); '
      + 'configure auth.token in the plugin row to pin your own value',
      source === 'generated' ? `generated at ${file}` : `from ${source}`,
      source,
    )
  }

  ctx.effect(() => {
    let listener: EndpointHandle | undefined
    let unmountFromWebServer: (() => void) | undefined
    let disposed = false

    const start = async (): Promise<void> => {
      if (config.http.enabled) {
        try {
          listener = await startListener({ config, handler: requestHandler.handle, log })
          url = listener.url
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log.error(
            `[dsh-as-mcp] could not listen on ${config.http.host}:${config.http.port} — ${message}. `
            + 'Set http.port to a free port, or http.enabled=false to only mount on the DSH web server.',
          )
        }
      }

      if (config.http.mountOnWebServer) {
        const webServer = serviceOf<WebServerLike>(ctx, 'webServer')
        if (webServer === undefined) {
          log.warn('[dsh-as-mcp] http.mountOnWebServer is set but this profile has no webServer service')
        } else if (!disposed) {
          unmountFromWebServer = mountOnWebServer({
            webServer,
            path: config.http.path,
            handler: requestHandler.handle,
            log,
          })
          mountedOnDshWebServer = true
          if (!config.http.enabled) url = `http://127.0.0.1:<dsh port>${config.http.path}`
        }
      }

      if (!disposed) {
        log.info(
          '[dsh-as-mcp] point an MCP client at %s with header "Authorization: Bearer %s"',
          url,
          token,
        )
      }
    }

    void start()

    return async () => {
      disposed = true
      unmountFromWebServer?.()
      await listener?.dispose()
      await requestHandler.close()
    }
  }, 'dsh-as-mcp endpoint')

  if (config.approval.policy === 'allow') {
    // Scoped to sessions this plugin created: a programmatic caller has no
    // browser to answer the harness approval waterfall, so without an answerer
    // every approval-requiring tool would fail closed. Answering globally would
    // silently widen permission for the user's own interactive sessions too.
    ctx.effect(() => {
      const off = eventsOf(ctx).on('approval/request', (...args: unknown[]) => {
        const request = args[0] as { agent?: { session?: { id?: string } } } | undefined
        const next = args[1] as (() => unknown) | undefined
        const sessionId = request?.agent?.session?.id
        if (sessionId !== undefined && driver.ownsSession(sessionId)) return 'allowed-once'
        return typeof next === 'function' ? next() : undefined
      })
      return () => {
        off()
      }
    }, 'dsh-as-mcp approval answerer')

    log.warn(
      '[dsh-as-mcp] approval.policy=allow — every approval request raised by a session this plugin '
      + 'created is approved automatically. Set approval.policy=inherit to disable.',
    )
  }
}
