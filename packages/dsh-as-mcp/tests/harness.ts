import type { Config } from '../src/config.js'
import type { DshLogger } from '../src/dsh/types.js'
import { createRequestHandler, startListener, type EndpointHandle } from '../src/mcp/http.js'
import type { ConnectionInfo, McpDriver } from '../src/mcp/tools.js'

export const TOKEN = 'test-token-0123456789'

export const silentLog: DshLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** A driver stub: the MCP layer is what is under test, not the harness. */
export function stubDriver(overrides: Partial<McpDriver> = {}): McpDriver {
  return {
    describeCapabilities: () => ({ sessionController: true, shell: false }),
    createWorkspace: async ({ path, title }) => ({
      created: true,
      workspace: {
        id: 'ws-1',
        path,
        title: title ?? 'stub',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        sessionCount: 0,
        status: 'ok',
      },
    }),
    listWorkspaces: async () => [],
    createSession: async () => ({ sessionId: 'session-1' }),
    listSessions: async () => [],
    promptSession: async () => ({ accepted: true }),
    cancelSession: () => ({ accepted: true }),
    readTranscript: async () => [],
    readFile: async ({ path }) => ({ path, text: 'hello', truncated: false }),
    writeFile: async ({ path }) => ({ path, operation: 'create' }),
    listDirectory: async ({ path }) => ({ path, entries: [] }),
    runShell: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: 'ok',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
    ...overrides,
  }
}

/** A complete config with every section filled, overridable per field. */
export function testConfig(overrides: Partial<Config['tools']> = {}, port = 0): Config {
  return {
    http: { enabled: true, host: '127.0.0.1', port, path: '/mcp', mountOnWebServer: false },
    auth: { token: TOKEN },
    tools: { workspace: true, session: true, files: true, shell: false, ...overrides },
    session: { agentPreset: '', provider: '', model: '', promptTimeoutMs: 1000 },
    limits: { maxReadBytes: 1024, shellTimeoutMs: 1000 },
    approval: { policy: 'inherit' },
  }
}

/** Bring up one listener over the given driver and return its URL plus teardown. */
export async function boot(driver: McpDriver, config: Config = testConfig()): Promise<{
  url: string
  stop: () => Promise<void>
}> {
  const connection = (): ConnectionInfo => ({
    url: 'http://127.0.0.1:0/mcp',
    token: TOKEN,
    tokenSource: 'test',
    mountedOnWebServer: false,
  })
  const requestHandler = createRequestHandler({
    deps: { driver, config, connection },
    token: TOKEN,
    log: silentLog,
  })
  const handle: EndpointHandle = await startListener({ config, handler: requestHandler.handle, log: silentLog })
  return {
    url: handle.url,
    stop: async () => {
      await handle.dispose()
      await requestHandler.close()
    },
  }
}

/** POST one JSON-RPC message and return the raw response. */
export async function rpc(
  url: string,
  message: unknown,
  options: { token?: string | null; protocolVersion?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`
  if (options.protocolVersion !== undefined) headers['mcp-protocol-version'] = options.protocolVersion
  return await fetch(url, { method: 'POST', headers, body: JSON.stringify(message) })
}

/**
 * Read one JSON-RPC reply out of either framing.
 *
 * The transport answers ordinary requests as a single `event: message` SSE
 * frame and only uses a bare JSON body for some protocol paths, so a client
 * has to handle both. Doing it here keeps the tests honest about the wire.
 */
export async function readJsonRpc(response: Response, id: number): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? ''
  const body = await response.text()
  if (!contentType.includes('text/event-stream')) {
    return JSON.parse(body) as Record<string, unknown>
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const parsed = JSON.parse(line.slice(5).trim()) as { id?: number }
    if (parsed.id === id) return parsed as Record<string, unknown>
  }
  throw new Error(`no SSE frame carried a reply for id ${id}: ${body.slice(0, 300)}`)
}

/** POST a `tools/call` and return its first text content block. */
export async function callTool(url: string, name: string, args: unknown): Promise<{
  isError: boolean
  text: string
}> {
  const response = await rpc(url, {
    jsonrpc: '2.0',
    id: 99,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const body = (await readJsonRpc(response, 99)) as {
    result?: { content?: { text?: string }[]; isError?: boolean }
  }
  return { isError: body.result?.isError === true, text: body.result?.content?.[0]?.text ?? '' }
}
