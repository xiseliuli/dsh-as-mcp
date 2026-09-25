import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { DEFAULT_AGENT_TOOLS } from '../src/defaults.js'
import { STATUS_ROUTE } from '../src/status.js'
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
    tools: { workspace: true, session: true, files: true, shell: true, agentTools: true, ...overrides.tools },
    agentTools: { allow: [...DEFAULT_AGENT_TOOLS.allow], deny: [...DEFAULT_AGENT_TOOLS.deny] },
    session: { agentPreset: '', provider: '', model: '', promptTimeoutMs: 500 },
    limits: { maxReadBytes: 1024, shellTimeoutMs: 1000 },
    approval: overrides.approval ?? { policy: 'inherit' },
  }
}

/** One fake workspace, enough for the tools that read the registry. */
function fakeWorkspaceRegistry(): {
  list: () => unknown[]
  get: (id: string) => unknown
  resolveByPath: (path: string) => Promise<unknown>
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
    // Faithful to the real service, which canonicalizes through realpath: a path
    // that does not exist REJECTS with ENOENT rather than resolving to undefined.
    // Modelling that faithfully is the point — a friendlier stub here is what let
    // a real "cannot create a new workspace directory" bug through.
    resolveByPath: async (path: string) => {
      if (!existsSync(path)) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), {
          code: 'ENOENT',
        })
      }
      return undefined
    },
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

  it('creates a workspace directory that does not exist yet', async () => {
    // The tool's headline use — register a new project — and the case a real
    // install broke on: `resolveByPath` rejects an absent path instead of
    // returning undefined, so looking it up before creating it failed the whole
    // call with a raw ENOENT.
    const port = await freePort()
    const root = await mkdtemp(join(tmpdir(), 'dsh-as-mcp-ws-'))
    const target = join(root, 'brand-new-project')
    const { url } = await bootWithContext((context) => {
      context.provide('workspaceRegistry', fakeWorkspaceRegistry())
      return pluginConfig({ port })
    })
    expect(existsSync(target)).toBe(false)

    const { text } = await callTool(url, 'workspace_create', { path: target })
    const payload = JSON.parse(text) as { created: boolean; workspace: { path: string } }
    expect(existsSync(target)).toBe(true)
    expect(payload.created).toBe(true)
  })

  it('refuses to create the directory under the read-only file policy', async () => {
    // `workspace_create` is the one mutation the driver cannot route through the
    // fs seam, because the harness has no directory-creation primitive: the seam
    // makes directories as a side effect of writing a file inside the fence, and
    // `workspaceRegistry.create()` rejects a path that does not exist. So it uses
    // `node:fs` — and it must still honour the deployment's policy rather than
    // quietly writing on an instance that has said it is read-only.
    const port = await freePort()
    const root = await mkdtemp(join(tmpdir(), 'dsh-as-mcp-ws-ro-'))
    const target = join(root, 'forbidden')
    const { url } = await bootWithContext((context) => {
      context.provide('workspaceRegistry', fakeWorkspaceRegistry())
      context.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only' }) })
      return pluginConfig({ port })
    })

    const response = await callTool(url, 'workspace_create', { path: target })
    expect(response.text).toMatch(/read-only file policy/)
    expect(existsSync(target)).toBe(false)
  })

  it('explains a missing directory instead of leaking a raw ENOENT', async () => {
    const port = await freePort()
    const root = await mkdtemp(join(tmpdir(), 'dsh-as-mcp-ws-'))
    const target = join(root, 'absent')
    const { url } = await bootWithContext((context) => {
      context.provide('workspaceRegistry', fakeWorkspaceRegistry())
      return pluginConfig({ port })
    })

    const { isError, text } = await callTool(url, 'workspace_create', {
      path: target,
      createDirectory: false,
    })
    expect(isError).toBe(true)
    // Named directory, and the argument that fixes it — not `ENOENT: realpath`.
    expect(text).toContain(target)
    expect(text).toContain('createDirectory')
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

    // Registration happens inside the effect, so wait for it. Only the MCP
    // endpoint goes on the raw web server: the panel's status route rides the
    // connection layer's fence instead, so it must NOT appear here — an exact
    // route on the web server would sit in front of that fence.
    const deadline = Date.now() + 5_000
    while (registered.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const endpoint = registered.find((route) => route.path === '/mcp')
    // An exact route, not a prefix: it must sit in front of the web server's SPA
    // fallback without swallowing the rest of the surface.
    expect(endpoint).toMatchObject({ kind: 'exact', path: '/mcp' })
    expect(registered).toHaveLength(1)

    // Driving the captured handler directly proves the mount is live and that
    // the same bearer check applies on this route. The status route is a
    // different route with no bearer check, so this must name the endpoint.
    const handler = endpoint?.handler as (req: unknown, res: unknown) => Promise<void>
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

  it('serves the panel a status payload that never carries the token', async () => {
    const port = await freePort()
    const routes: { path: string; methods: readonly string[]; fetch: (req: Request) => Promise<Response> }[] = []
    await bootWithContext((root) => {
      root.provide('connection', {
        fetch: {
          register: (route: (typeof routes)[number]) => {
            routes.push(route)
            return () => undefined
          },
        },
      })
      return pluginConfig({ port })
    })

    const deadline = Date.now() + 5_000
    while (routes.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const statusRoute = routes.find((route) => route.path === STATUS_ROUTE)
    expect(statusRoute).toBeDefined()
    // On the connection layer's `/api` channel, which is what puts it inside the
    // Host/Origin and browser-cookie fence rather than in front of it.
    expect(statusRoute?.methods).toEqual(['GET'])
    expect(routes).toHaveLength(1)

    // No token and no cookie: the panel reads this from the DSH web shell,
    // same-origin, where DSH's own authorization has already passed.
    const answer = await statusRoute!.fetch(new Request('http://127.0.0.1/'))
    expect(answer.status).toBe(200)
    const body = await answer.text()

    const payload = JSON.parse(body) as Record<string, unknown>
    expect(payload).toMatchObject({
      listening: true,
      mountedOnWebServer: false,
      error: null,
      settingsRegistered: false,
    })
    expect(typeof payload.url).toBe('string')
    expect(typeof payload.tokenSource).toBe('string')
    expect(typeof payload.tokenFile).toBe('string')
    expect(payload.enabledToolGroups).toContain('workspace')
    // The whole point of a redacted view: the literal must not be reachable from
    // the panel's own read.
    expect(body).not.toContain(TOKEN)
    expect(payload).not.toHaveProperty('token')
  })

  it('picks up the connection service when it arrives after the plugin', async () => {
    const port = await freePort()
    const routes: { path: string; methods: readonly string[] }[] = []
    const root = new Context()
    contexts.push(root)
    apply(root, pluginConfig({ port }))

    // The real shape of the bug: at apply time the service is not there yet, and
    // a single `ctx.get('connection')` meant the status route silently never
    // existed. Waiting for it is the whole point.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(routes).toHaveLength(0)

    root.provide('connection', {
      fetch: {
        register: (route: { path: string; methods: readonly string[] }) => {
          routes.push(route)
          return () => undefined
        },
      },
    })

    const deadline = Date.now() + 5_000
    while (routes.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(routes[0]?.path).toBe(STATUS_ROUTE)
    expect(routes[0]?.methods).toEqual(['GET'])
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

describe('argument ceilings', () => {
  it('rejects a prompt wait long enough to hold the poll loop open forever', async () => {
    // Each waiting call re-reads and replays the whole session log every 200 ms,
    // and the turn queue only serialises per session, so an uncapped timeout lets
    // one caller keep N loops alive. The schema refuses it at the edge.
    const port = await freePort()
    const { url } = await bootWithContext((context) => {
      context.provide('sessionController', {
        create: async () => ({ sessionId: 's' }),
        list: async () => ({ items: [] }),
        prompt: async () => ({ accepted: true }),
        inspect: async () => ({ events: [] }),
      })
      return pluginConfig({ port })
    })

    const response = await callTool(url, 'session_prompt', {
      sessionId: 's',
      prompt: 'go',
      timeoutMs: 24 * 60 * 60 * 1_000,
    })
    expect(response.text).toMatch(/too_big|600000|<=/i)
  })
})

describe('token hygiene in the log', () => {
  it('announces the endpoint with a masked token, never the literal', async () => {
    const port = await freePort()
    const lines: string[] = []
    const root = new Context()
    contexts.push(root)
    const capture =
      (...args: unknown[]) =>
        lines.push(args.map((argument) => String(argument)).join(' '))
    root.logger = { debug: capture, info: capture, warn: capture, error: capture } as never

    apply(root, pluginConfig({ port, token: TOKEN }))
    const url = `http://127.0.0.1:${port}/mcp`
    await waitForEndpoint(url)

    // The announcement runs after the async reconcile, so give it a moment to land.
    const deadline = Date.now() + 2_000
    while (!lines.some((line) => line.includes('fingerprint')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    // The property that matters: a log file is a file, and this one never holds
    // the credential. DSH's own logger masks the value today, but that is a host
    // behaviour the plugin does not control — masking here makes it local.
    expect(lines.some((line) => line.includes(TOKEN))).toBe(false)

    // And the line is still useful for setting up a client.
    const announcement = lines.find((line) => line.includes('fingerprint'))
    expect(announcement).toBeDefined()
    expect(announcement).toContain(`${TOKEN.slice(0, 4)}…`)

    // Nothing is written as `bearer <value>`. DSH's log masker matches that shape
    // and replaces the rest of the line, so the pointer to the token file would be
    // swallowed — masking a fingerprint hides the pointer without hiding a secret.
    for (const line of lines) {
      expect(line).not.toMatch(/bearer\s+\S/i)
    }
  })
})
