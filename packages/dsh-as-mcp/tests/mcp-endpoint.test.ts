import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TOKEN, boot, callTool, readJsonRpc, rpc, silentLog, stubDriver, testConfig } from './harness.js'
import { createRequestHandler, startListener } from '../src/mcp/http.js'

describe('MCP Streamable HTTP endpoint', () => {
  let url: string
  let stop: () => Promise<void>

  beforeAll(async () => {
    const booted = await boot(stubDriver())
    url = booted.url
    stop = booted.stop
  })

  afterAll(async () => {
    await stop()
  })

  it('reports the OS-assigned port, not the requested 0', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  })

  it('rejects a request with no token', async () => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null })
    expect(response.status).toBe(401)
  })

  it('rejects a request with a wrong token', async () => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'nope' })
    expect(response.status).toBe(401)
  })

  it('accepts the token as a query parameter, for clients with no header support', async () => {
    const response = await rpc(`${url}?token=${TOKEN}`, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
      params: {},
    }, { token: null })
    expect(response.status).toBe(200)
  })

  it('404s on any other path', async () => {
    const response = await fetch(url.replace('/mcp', '/other'), { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('completes the initialize handshake', async () => {
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } },
    })
    expect(response.status).toBe(200)
    const body = (await readJsonRpc(response, 1)) as {
      result?: { serverInfo?: { name?: string }; protocolVersion?: string }
    }
    expect(body.result?.serverInfo?.name).toBe('dsh-as-mcp')
    expect(typeof body.result?.protocolVersion).toBe('string')
  })

  it('lists the enabled tools and hides a disabled group', async () => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const body = (await readJsonRpc(response, 2)) as { result?: { tools?: { name: string }[] } }
    const names = (body.result?.tools ?? []).map((tool) => tool.name)
    expect(names).toContain('dsh_info')
    expect(names).toContain('workspace_create')
    expect(names).toContain('session_prompt')
    expect(names).toContain('file_read')
    expect(names).not.toContain('shell_run')
  })

  it('calls a tool and returns its JSON payload', async () => {
    const { isError, text } = await callTool(url, 'dsh_info', {})
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toMatchObject({
      bearerToken: TOKEN,
      enabledToolGroups: { shell: false, session: true },
    })
  })

  it('routes a tool argument through to the driver', async () => {
    const { text } = await callTool(url, 'workspace_create', { path: '/tmp/example', title: 'Example' })
    const payload = JSON.parse(text) as { created: boolean; workspace: { path: string; title: string } }
    expect(payload.created).toBe(true)
    expect(payload.workspace.path).toBe('/tmp/example')
    expect(payload.workspace.title).toBe('Example')
  })

  it('reports a harness failure as a tool error, not a transport error', async () => {
    const failing = await boot(
      stubDriver({
        listWorkspaces: async () => {
          throw new Error('harness exploded')
        },
      }),
    )
    try {
      const { isError, text } = await callTool(failing.url, 'workspace_list', {})
      expect(isError).toBe(true)
      expect(text).toContain('harness exploded')
      // The stack goes to the DSH log, not into another agent's context.
      expect(text).not.toMatch(/\n\s+at /)
      expect(text).not.toContain('driver.ts')
    } finally {
      await failing.stop()
    }
  })

  it('rejects an unknown tool at the protocol layer', async () => {
    // The SDK answers an unregistered name with a JSON-RPC error rather than a
    // tool result, so a client that only inspects `result.isError` would miss it.
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 88,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    })
    const body = (await readJsonRpc(response, 88)) as {
      result?: unknown
      error?: { code: number; message: string }
    }
    expect(body.result).toBeUndefined()
    expect(body.error?.message).toContain('no_such_tool')
  })

  it('serves a second listener independently, so two profiles can coexist', async () => {
    const other = await boot(stubDriver(), testConfig({ workspace: false }))
    try {
      const response = await rpc(other.url, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} })
      const body = (await readJsonRpc(response, 7)) as { result?: { tools?: { name: string }[] } }
      const names = (body.result?.tools ?? []).map((tool) => tool.name)
      expect(names).not.toContain('workspace_create')
      expect(names).toContain('dsh_info')
    } finally {
      await other.stop()
    }
  })

  it('releases the port when disposed, so a restart does not fail', async () => {
    const first = await boot(stubDriver())
    const port = new URL(first.url).port
    await first.stop()
    const config = testConfig({}, Number(port))
    const requestHandler = createRequestHandler({
      deps: {
        driver: stubDriver(),
        getConfig: () => config,
        status: () => ({
          listening: true,
          url: first.url,
          mountedOnWebServer: false,
          error: null,
          tokenSource: 'test',
          settingsRegistered: false,
        }),
        connection: () => ({ url: first.url, token: 'x', tokenSource: 'test', mountedOnWebServer: false }),
        log: silentLog,
      },
      getToken: () => 'x',
      log: silentLog,
    })
    const second = await startListener({ config, handler: requestHandler.handle, log: silentLog })
    expect(new URL(second.url).port).toBe(port)
    await second.dispose()
    await requestHandler.close()
  })

  it('rejects an MCP-Protocol-Version header that matches no negotiated revision', async () => {
    // A client must echo the revision the server actually chose. Sending the
    // requested one after a downgrade is the failure mode the stdio bridge has
    // to avoid, and the server reports it as an in-band JSON-RPC error body.
    const response = await rpc(
      url,
      { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
      { protocolVersion: '2026-07-28' },
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain('2026-07-28')
  })
})
