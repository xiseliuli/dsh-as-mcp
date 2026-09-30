import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { createRequestHandler, startListener, type EndpointHandle } from '../src/mcp/http.js'
import type { ConnectionInfo } from '../src/mcp/tools.js'
import type { EndpointStatus } from '../src/status.js'
import { callTool, readJsonRpc, rpc, silentLog, stubDriver, testConfig, TOKEN } from './harness.js'

/**
 * A running endpoint whose configuration can be swapped underneath it, exactly
 * as the settings panel does: the handler reads the current value per request
 * rather than a value captured when it was built.
 */
async function mountMutable(initial: Config, driver = stubDriver()): Promise<{
  url: string
  set: (next: Config) => void
  stop: () => Promise<void>
}> {
  let config = initial
  const connection = (): ConnectionInfo => ({
    url: 'http://127.0.0.1:0/mcp',
    token: config.auth.token,
    tokenSource: 'test',
    mountedOnWebServer: false,
  })
  const status = (): EndpointStatus => ({
    listening: true,
    url: 'http://127.0.0.1:0/mcp',
    mountedOnWebServer: false,
    error: null,
    tokenSource: 'test',
    settingsRegistered: true,
    tokenFile: '/tmp/dsh-as-mcp/token',
    enabledToolGroups: ['workspace', 'session', 'files'],
  })
  const handler = createRequestHandler({
    deps: { driver, getConfig: () => config, connection, status, log: silentLog },
    getToken: () => config.auth.token,
    log: silentLog,
  })
  const handle: EndpointHandle = await startListener({ config, handler: handler.handle, log: silentLog })
  return {
    url: handle.url,
    set: (next) => {
      config = next
    },
    stop: async () => {
      await handle.dispose()
      await handler.close()
    },
  }
}

/** The tool names the endpoint currently advertises. */
async function toolNames(url: string, token: string = TOKEN): Promise<string[]> {
  const response = await rpc(
    url,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { token },
  )
  const body = (await readJsonRpc(response, 1)) as { result?: { tools?: { name: string }[] } }
  return (body.result?.tools ?? []).map((tool) => tool.name)
}

const running: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const stop of running.splice(0)) await stop()
})

describe('configuration changes reach the next request', () => {
  it('drops a tool group from tools/list without restarting the endpoint', async () => {
    const endpoint = await mountMutable(testConfig({ shell: true }))
    running.push(endpoint.stop)

    const before = await toolNames(endpoint.url)
    expect(before).toContain('file_read')
    expect(before).toContain('shell_run')

    // What the settings panel writes: only the toggles, nothing else.
    endpoint.set(testConfig({ files: false, shell: true }))

    const after = await toolNames(endpoint.url)
    expect(after).not.toContain('file_read')
    expect(after).not.toContain('file_write')
    expect(after).not.toContain('file_list')
    // The groups that stayed on are untouched, and the endpoint never moved.
    expect(after).toContain('shell_run')
    expect(after).toContain('workspace_create')
  })

  it('stops answering a tool it no longer advertises', async () => {
    const endpoint = await mountMutable(testConfig())
    running.push(endpoint.stop)
    endpoint.set(testConfig({ files: false }))

    const response = await rpc(endpoint.url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'file_read', arguments: { path: '/tmp/x' } },
    })
    const body = (await readJsonRpc(response, 2)) as { result?: unknown; error?: { message?: string } }
    // A disabled group is genuinely absent, not registered-but-refusing.
    expect(body.result).toBeUndefined()
    expect(body.error?.message).toContain('file_read')
  })

  it('hands the next call the new limit rather than the one captured at boot', async () => {
    const seen: number[] = []
    const driver = stubDriver({
      readFile: async ({ path, maxBytes }) => {
        seen.push(maxBytes)
        return { path, text: 'hello', truncated: false }
      },
    })
    const endpoint = await mountMutable(testConfig({ files: true }), driver)
    running.push(endpoint.stop)

    await callTool(endpoint.url, 'file_read', { path: '/tmp/x' })
    expect(seen).toEqual([1024])

    endpoint.set({ ...testConfig({ files: true }), limits: { maxReadBytes: 4242, shellTimeoutMs: 111, agentToolTimeoutMs: 111 } })
    await callTool(endpoint.url, 'file_read', { path: '/tmp/x' })

    // The second call saw the raised limit, which it can only do by reading the
    // configuration at call time.
    expect(seen).toEqual([1024, 4242])
  })
})

describe('token rotation', () => {
  it('accepts the new token and rejects the old one immediately', async () => {
    const endpoint = await mountMutable(testConfig())
    running.push(endpoint.stop)

    expect((await rpc(endpoint.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200)

    endpoint.set({ ...testConfig(), auth: { token: 'rotated-token-value' } })

    const stale = await rpc(endpoint.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(stale.status).toBe(401)

    const rotated = await rpc(endpoint.url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, {
      token: 'rotated-token-value',
    })
    expect(rotated.status).toBe(200)
    expect(await toolNames(endpoint.url, 'rotated-token-value')).toContain('dsh_info')
  })

  it('keeps the endpoint closed when the token is cleared to empty', async () => {
    const endpoint = await mountMutable(testConfig())
    running.push(endpoint.stop)
    endpoint.set({ ...testConfig(), auth: { token: '' } })

    // An empty expected token must never mean "admit everything": every
    // presentation is refused rather than matched against "".
    const anonymous = await rpc(endpoint.url, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { token: null })
    expect(anonymous.status).toBe(401)
    const empty = await rpc(endpoint.url, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { token: '' })
    expect(empty.status).toBe(401)
  })
})
