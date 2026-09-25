import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { apply, inject, name } from '../src/index.js'
import { TOKEN, callTool, rpc } from './harness.js'

/**
 * Run a harness waterfall over a context.
 *
 * `ctx.waterfall` is typed against Cordis's own event map; the harness augments
 * that map through declaration merging, which this plugin deliberately does not
 * depend on. Calling through a narrow structural cast keeps the test honest
 * about the runtime contract without importing `@deepseek-ai/dsh-*`.
 */
async function waterfall(root: Context, event: string, request: unknown, fallback: () => Promise<unknown>): Promise<unknown> {
  const call = root as unknown as {
    waterfall(name: string, req: unknown, next: () => Promise<unknown>): Promise<unknown>
  }
  return await call.waterfall.call(root, event, request, fallback)
}

/** Reserve a port by binding it, then release it for the plugin to claim. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Poll until the plugin's effect has finished bringing the listener up. */
async function waitForEndpoint(url: string): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      })
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

function pluginConfig(overrides: {
  port: number
  tools?: Partial<Config['tools']>
  approval?: Config['approval']
  mountOnWebServer?: boolean
  token?: string
  enabled?: boolean
}): Config {
  return {
    http: {
      enabled: overrides.enabled ?? true,
      host: '127.0.0.1',
      port: overrides.port,
      path: '/mcp',
      mountOnWebServer: overrides.mountOnWebServer ?? false,
    },
    auth: { token: overrides.token ?? TOKEN },
    tools: { workspace: true, session: true, files: true, shell: true, ...overrides.tools },
    session: { agentPreset: '', provider: '', model: '', promptTimeoutMs: 500 },
    limits: { maxReadBytes: 1024, shellTimeoutMs: 1000 },
    approval: overrides.approval ?? { policy: 'inherit' },
  }
}

/** One fake workspace, enough for the tools that read the registry. */
function fakeWorkspaceRegistry(): {
  list: () => unknown[]
  get: (id: string) => unknown
  resolveByPath: () => Promise<undefined>
  create: (path: string, title?: string) => Promise<unknown>
} {
  const workspace = {
    id: 'ws-1',
    path: '/tmp/fake-workspace',
    title: 'Fake',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: [],
    status: async () => 'ok' as const,
  }
  return {
    list: () => [workspace],
    get: (id: string) => (id === 'ws-1' ? workspace : undefined),
    resolveByPath: async () => undefined,
    create: async (path: string, title?: string) => ({ ...workspace, path, title: title ?? 'Fake' }),
  }
}

/** Every context created by a test, torn down afterwards. */
const contexts: Context[] = []

async function bootWithContext(build: (root: Context) => Config): Promise<{ root: Context; url: string }> {
  const root = new Context()
  contexts.push(root)
  const config = build(root)
  apply(root, config)
  const url = `http://127.0.0.1:${config.http.port}${config.http.path}`
  if (config.http.enabled) await waitForEndpoint(url)
  return { root, url }
}

afterEach(async () => {
  for (const root of contexts.splice(0)) await root.fiber.dispose()
})

describe('plugin metadata', () => {
  it('is named dsh-as-mcp and requires no injected service', () => {
    expect(name).toBe('dsh-as-mcp')
    // The whole capability-gating design rests on this: the loader must mount
    // the plugin even where no session, fs, or web service exists.
    expect(inject).toEqual([])
  })
})

describe('apply() in a bare profile', () => {
  it('mounts without throwing when no harness service is present', async () => {
    const port = await freePort()
    const { url } = await bootWithContext(() => pluginConfig({ port }))
    // Reaching the endpoint at all proves apply() survived an empty context.
    const response = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(response.status).toBe(200)
  })

  it('reports every capability as absent', async () => {
    const port = await freePort()
    const { url } = await bootWithContext(() => pluginConfig({ port }))
    const { text } = await callTool(url, 'dsh_info', {})
    const info = JSON.parse(text) as { harnessServices: Record<string, boolean> }
    expect(info.harnessServices).toMatchObject({
      workspaceRegistry: false,
      sessionController: false,
      fs: false,
      shell: false,
    })
  })

  it('answers a tool whose service is missing with a clear capability error', async () => {
    const port = await freePort()
    const { url } = await bootWithContext(() => pluginConfig({ port }))
    const { isError, text } = await callTool(url, 'workspace_list', {})
    expect(isError).toBe(true)
    // The message must name the service, so an operator can tell which bundle
    // to add to the profile rather than reading a stack trace.
    expect(text).toContain('workspaceRegistry')
    expect(text).toContain('dsh-base')
  })
})

describe('apply() with harness services present', () => {
  it('drives the registry and reports the capability as present', async () => {
    const port = await freePort()
    const { url } = await bootWithContext((root) => {
      root.provide('workspaceRegistry', fakeWorkspaceRegistry())
      return pluginConfig({ port })
    })

    const info = JSON.parse((await callTool(url, 'dsh_info', {})).text) as {
      harnessServices: Record<string, boolean>
    }
    expect(info.harnessServices.workspaceRegistry).toBe(true)

    const listed = JSON.parse((await callTool(url, 'workspace_list', {})).text) as {
      workspaces: { id: string; path: string }[]
    }
    expect(listed.workspaces).toHaveLength(1)
    expect(listed.workspaces[0]).toMatchObject({ id: 'ws-1', path: '/tmp/fake-workspace' })
  })

  it('mounts on the DSH web server as an exact route when asked', async () => {
    const port = await freePort()
    const registered: { kind: string; path: string; handler: unknown }[] = []
    await bootWithContext((root) => {
      root.provide('webServer', {
        register: (route: { kind: string; path: string; handler: unknown }) => {
          registered.push(route)
          return () => undefined
        },
      })
      return pluginConfig({ port, mountOnWebServer: true })
    })

    // Registration happens inside the effect, so wait for it.
    const deadline = Date.now() + 5_000
    while (registered.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    expect(registered).toHaveLength(1)
    // An exact route, not a prefix: it must sit in front of the web server's SPA
    // fallback without swallowing the rest of the surface.
    expect(registered[0]).toMatchObject({ kind: 'exact', path: '/mcp' })

    // Driving the captured handler directly proves the mount is live and that
    // the same bearer check applies on this route.
    const handler = registered[0]?.handler as (req: unknown, res: unknown) => Promise<void>
    const response = await driveHandler(handler, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'dsh_info', arguments: {} },
    })
    expect(response.status).toBe(200)

    const denied = await driveHandler(handler, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, null)
    expect(denied.status).toBe(401)
  })
})

/** Run a captured web-server handler against a real socket and capture the reply. */
async function driveHandler(
  handler: (req: unknown, res: unknown) => Promise<void>,
  message: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: string }> {
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    })
    return { status: response.status, body: await response.text() }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('approval answerer', () => {
  it('approves only sessions this plugin created, and defers otherwise', async () => {
    const port = await freePort()
    const { root, url } = await bootWithContext((ctx) => {
      ctx.provide('sessionController', {
        create: async () => ({ sessionId: 'session-owned' }),
        list: async () => ({ items: [] }),
        selectModel: async () => ({ selected: { provider: 'p', model: 'm' } }),
        prompt: async () => ({ accepted: true }),
        cancel: () => ({ accepted: true }),
        inspect: async () => ({ events: [] }),
      })
      return pluginConfig({ port, approval: { policy: 'allow' } })
    })

    // Ownership is established by creating the session through this plugin.
    const created = JSON.parse((await callTool(url, 'session_create', { cwd: '/tmp' })).text) as {
      sessionId: string
    }
    expect(created.sessionId).toBe('session-owned')

    const fallback = (): Promise<string> => Promise.resolve('unavailable')
    const owned = await waterfall(root, 'approval/request', { agent: { session: { id: 'session-owned' } } }, fallback)
    expect(owned).toBe('allowed-once')

    // A session the user is driving interactively must keep its own policy.
    const foreign = await waterfall(root, 'approval/request', { agent: { session: { id: 'session-someone-else' } } }, fallback)
    expect(foreign).toBe('unavailable')
  })

  it('stays out of the waterfall entirely under the default policy', async () => {
    const port = await freePort()
    const { root } = await bootWithContext((ctx) => {
      ctx.provide('sessionController', {
        create: async () => ({ sessionId: 'session-owned' }),
        list: async () => ({ items: [] }),
      })
      return pluginConfig({ port })
    })

    const result = await waterfall(
      root,
      'approval/request',
      { agent: { session: { id: 'session-owned' } } },
      () => Promise.resolve('unavailable'),
    )
    expect(result).toBe('unavailable')
  })
})

describe('endpoint lifecycle', () => {
  it('releases the port when the plugin context is disposed', async () => {
    const port = await freePort()
    const root = new Context()
    const config = pluginConfig({ port })
    apply(root, config)
    await waitForEndpoint(`http://127.0.0.1:${port}/mcp`)

    await root.fiber.dispose()

    // Re-binding the same port proves the listener really closed.
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })

  it('generates and persists a bearer token when none is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-as-mcp-apply-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const root = new Context()
      contexts.push(root)
      apply(root, pluginConfig({ port: 0, token: '', enabled: false }))

      const path = join(home, 'dsh-as-mcp', 'token')
      const token = (await readFile(path, 'utf8')).trim()
      expect(token.length).toBeGreaterThan(20)
      // The token is a secret: the file must not be group- or world-readable.
      const mode = (await stat(path)).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('does not start a listener when the endpoint is disabled', async () => {
    const port = await freePort()
    await bootWithContext(() => pluginConfig({ port, enabled: false }))
    await expect(fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow()
  })
})
