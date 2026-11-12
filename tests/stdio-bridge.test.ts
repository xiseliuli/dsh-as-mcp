import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { TOKEN, boot, stubDriver } from './harness.js'

const bridgePath = fileURLToPath(new URL('../bin/mcp-stdio.mjs', import.meta.url))

/** One run of the bridge: send lines, collect stdout lines, report the exit code. */
async function runBridge(input: {
  env: Record<string, string>
  lines: string[]
  /** Wait for this many stdout lines before closing stdin. */
  expectLines: number
}): Promise<{ stdout: string[]; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, [bridgePath], {
    env: { ...process.env, ...input.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const stdout: string[] = []
  let stderr = ''
  let buffer = ''

  const collected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge timed out; stderr:\n${stderr}`)), 20_000)
    // stderr is wired before the early return below. Attaching it after made
    // `expect(stderr).not.toContain(...)` in the exit-status-only tests vacuously
    // true — stderr stayed '' no matter what the child printed.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    // Nothing to wait for: the caller only wants the exit status.
    if (input.expectLines === 0) {
      clearTimeout(timer)
      resolve()
      return
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line !== '') stdout.push(line)
        newline = buffer.indexOf('\n')
      }
      if (stdout.length >= input.expectLines) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  for (const line of input.lines) child.stdin.write(`${line}\n`)
  await collected
  child.stdin.end()
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  return { stdout, stderr, code }
}

/** One request the bridge sent to a fake endpoint, as the fake saw it. */
interface FakeRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

/** A fake Streamable HTTP endpoint the bridge can run against. */
interface FakeEndpoint {
  url: string
  requests: FakeRequest[]
  close: () => Promise<void>
}

/**
 * Start a fake endpoint on an ephemeral loopback port.
 *
 * The handler gets a fully buffered request; hanging SSE responses are tracked
 * and ended by `close()`, so a broken assertion cannot leak the test process.
 */
async function startFakeEndpoint(
  handle: (request: FakeRequest, response: ServerResponse) => void,
): Promise<FakeEndpoint> {
  const requests: FakeRequest[] = []
  const responses = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    responses.add(response)
    response.on('close', () => responses.delete(response))
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const fake: FakeRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(fake)
      try {
        handle(fake, response)
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      for (const response of responses) {
        if (!response.writableEnded) response.end()
      }
      server.closeAllConnections()
      await closed
    },
  }
}

/** Answer a bridge POST the way a minimal stateful MCP endpoint would. */
function respondToPost(
  request: FakeRequest,
  response: ServerResponse,
  options: { sessionId?: string } = {},
): void {
  const message = JSON.parse(request.body) as { id?: number; method?: string }
  if (message.method === 'initialize') {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.sessionId) headers['mcp-session-id'] = options.sessionId
    response.writeHead(200, headers)
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'fake-endpoint', version: '0' },
      },
    }))
    return
  }
  if (message.method === 'tools/list') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [{ name: 'dsh_info' }] },
    }))
    return
  }
  // Notifications are acknowledged without a body.
  response.writeHead(202)
  response.end()
}

/** Begin a text/event-stream response and flush its headers to the bridge. */
function startEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()
}

/** Write one SSE event carrying a JSON-RPC payload. */
function writeEvent(response: ServerResponse, payload: unknown, id?: string): void {
  const lines: string[] = []
  if (id !== undefined) lines.push(`id: ${id}`)
  lines.push('event: message', `data: ${JSON.stringify(payload)}`, '', '')
  response.write(lines.join('\n'))
}

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest-bridge', version: '0' },
  },
}

/**
 * A live bridge child with polling helpers.
 *
 * The push tests need to observe stderr and server state at arbitrary times, so
 * they cannot use `runBridge` (which resolves on a stdout line count and closes
 * stdin immediately). Waiting is always a poll on real state, never a fixed
 * sleep.
 */
class BridgeRun {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly lines: string[] = []
  private readonly exited: Promise<number | null>
  private stdoutBuffer = ''
  private stderr = ''

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exited = new Promise((resolve) => {
      this.child.on('close', resolve)
    })
    this.child.on('error', (error) => {
      this.stderr += `\n[bridge spawn error] ${error.message}`
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk
      let newline = this.stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim()
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
        if (line !== '') this.lines.push(line)
        newline = this.stdoutBuffer.indexOf('\n')
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
    })
  }

  send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  stdoutLines(): string[] {
    return [...this.lines]
  }

  stderrText(): string {
    return this.stderr
  }

  /** Poll until `check` is true; fail with the collected stderr on timeout. */
  async waitFor(check: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${description}; stderr:\n${this.stderr}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /** Close stdin and resolve with the exit code. */
  async close(): Promise<number | null> {
    if (this.child.exitCode === null) this.child.stdin.end()
    return await this.exited
  }

  kill(): void {
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
  }
}

describe('stdio bridge push channel', () => {
  const bridges: BridgeRun[] = []

  function startBridge(env: Record<string, string>): BridgeRun {
    const bridge = new BridgeRun(env)
    bridges.push(bridge)
    return bridge
  }

  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.kill()
  })

  it('forwards notifications and server requests from the GET stream while requests keep working', async () => {
    const fake = await startFakeEndpoint((request, response) => {
      if (request.method === 'GET') {
        startEventStream(response)
        writeEvent(response, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
        // A server→client request must be forwarded too, with its id intact.
        writeEvent(response, {
          jsonrpc: '2.0',
          id: 'srv-1',
          method: 'sampling/createMessage',
          params: { maxTokens: 8 },
        })
        writeEvent(response, {
          jsonrpc: '2.0',
          method: 'notifications/resources/updated',
          params: { uri: 'dsh://session/session-1/turn' },
        }, '5')
        return
      }
      respondToPost(request, response, { sessionId: 'fake-session-a' })
    })
    const bridge = startBridge({ DSH_AS_MCP_URL: fake.url, DSH_AS_MCP_TOKEN: TOKEN })

    try {
      bridge.send(INITIALIZE_REQUEST)
      bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      await bridge.waitFor(
        () => bridge.stdoutLines().length >= 5,
        'the two request replies and the three pushed messages',
      )

      // Every line is a complete JSON document: no partial or concatenated writes.
      const messages = bridge.stdoutLines().map((line) => JSON.parse(line) as {
        id?: number | string
        method?: string
        result?: { tools?: { name: string }[] }
      })
      expect(messages).toHaveLength(5)
      expect(messages.filter((message) => message.id === 1)).toHaveLength(1)
      expect(messages.find((message) => message.id === 2)?.result?.tools?.map((tool) => tool.name))
        .toContain('dsh_info')
      expect(messages.map((message) => message.method).filter(Boolean)).toEqual([
        'notifications/tools/list_changed',
        'sampling/createMessage',
        'notifications/resources/updated',
      ])
      expect(messages.find((message) => message.id === 'srv-1')?.method).toBe('sampling/createMessage')

      // Pushed messages are stdout-only: nothing is echoed back over HTTP.
      const posted = fake.requests
        .filter((request) => request.method === 'POST')
        .map((request) => (JSON.parse(request.body) as { method?: string }).method)
      expect(posted).not.toContain('sampling/createMessage')

      // The channel is opened with the stateful headers the protocol requires.
      const getRequests = fake.requests.filter((request) => request.method === 'GET')
      expect(getRequests).toHaveLength(1)
      const headers = getRequests[0]?.headers ?? {}
      expect(headers['mcp-session-id']).toBe('fake-session-a')
      expect(headers['mcp-protocol-version']).toBe('2025-06-18')
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(String(headers.accept)).toContain('text/event-stream')
      expect(bridge.stderrText()).not.toContain('push disabled')
    } finally {
      // Clean up the endpoint first: a failing assertion below must not leak it.
      const code = await bridge.close()
      await fake.close()
      expect(code).toBe(0)
    }
  })

  it('stays push-silent when initialize issues no session id', async () => {
    const fake = await startFakeEndpoint((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(405)
        response.end()
        return
      }
      // A stateless endpoint: no mcp-session-id on the initialize reply.
      respondToPost(request, response)
    })
    const bridge = startBridge({ DSH_AS_MCP_URL: fake.url, DSH_AS_MCP_TOKEN: TOKEN })

    try {
      bridge.send(INITIALIZE_REQUEST)
      await bridge.waitFor(
        () => bridge.stderrText().includes('push disabled'),
        'the stateless push-disabled note',
      )
      expect(bridge.stderrText()).toContain('mcp-session-id')

      bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      await bridge.waitFor(
        () => bridge.stdoutLines().some((line) => (JSON.parse(line) as { id?: number }).id === 2),
        'the tools/list reply from the stateless endpoint',
      )
    } finally {
      const code = await bridge.close()
      await fake.close()
      const stderr = bridge.stderrText()
      expect(code).toBe(0)
      // One note, and no GET is attempted at all on a stateless endpoint.
      expect(stderr.match(/push disabled/g)).toHaveLength(1)
      expect(fake.requests.filter((request) => request.method === 'GET')).toHaveLength(0)
    }
  })

  it('logs one push-disabled note after a 405 GET and keeps request/reply working', async () => {
    const fake = await startFakeEndpoint((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(405, { allow: 'POST' })
        response.end('method not allowed')
        return
      }
      respondToPost(request, response, { sessionId: 'fake-session-b' })
    })
    const bridge = startBridge({ DSH_AS_MCP_URL: fake.url, DSH_AS_MCP_TOKEN: TOKEN })

    try {
      bridge.send(INITIALIZE_REQUEST)
      await bridge.waitFor(
        () => bridge.stderrText().includes('push disabled'),
        'the one push-disabled note',
      )
      expect(bridge.stderrText()).toContain('405')
      expect(bridge.stderrText().match(/push disabled/g)).toHaveLength(1)

      // The request/reply path must be untouched by a stateless endpoint.
      bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      await bridge.waitFor(
        () => bridge.stdoutLines().some((line) => (JSON.parse(line) as { id?: number }).id === 2),
        'the tools/list reply after push was disabled',
      )
      const reply = bridge.stdoutLines()
        .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } })
        .find((message) => message.id === 2)
      expect((reply?.result?.tools ?? []).length).toBeGreaterThan(0)
    } finally {
      const code = await bridge.close()
      await fake.close()
      const stderr = bridge.stderrText()
      expect(code).toBe(0)
      // Never retried: one note, one GET attempt, even after shutdown.
      expect(stderr.match(/push disabled/g)).toHaveLength(1)
      expect(fake.requests.filter((request) => request.method === 'GET')).toHaveLength(1)
    }
  })

  it('reconnects the GET stream with backoff and replays the last SSE id', async () => {
    const getStartedAt: number[] = []
    const fake = await startFakeEndpoint((request, response) => {
      if (request.method === 'GET') {
        getStartedAt.push(Date.now())
        startEventStream(response)
        if (getStartedAt.length === 1) {
          writeEvent(response, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, '7')
          response.end()
        }
        return
      }
      respondToPost(request, response, { sessionId: 'fake-session-c' })
    })
    const bridge = startBridge({ DSH_AS_MCP_URL: fake.url, DSH_AS_MCP_TOKEN: TOKEN })

    try {
      bridge.send(INITIALIZE_REQUEST)
      await bridge.waitFor(
        () => fake.requests.filter((request) => request.method === 'GET').length >= 2,
        'a second GET after the first stream closed',
      )

      const getRequests = fake.requests.filter((request) => request.method === 'GET')
      expect(getRequests[0]?.headers['mcp-session-id']).toBe('fake-session-c')
      expect(getRequests[1]?.headers['mcp-session-id']).toBe('fake-session-c')
      // The first stream had no resume point; the second replays the SSE id.
      expect(getRequests[0]?.headers['last-event-id']).toBeUndefined()
      expect(getRequests[1]?.headers['last-event-id']).toBe('7')
      // Backoff is real: the reconnect waited close to the 500 ms base delay
      // instead of spinning on a dead stream.
      expect((getStartedAt[1] ?? 0) - (getStartedAt[0] ?? 0)).toBeGreaterThanOrEqual(400)

      // The notification delivered before the close is forwarded exactly once.
      const notifications = bridge.stdoutLines()
        .map((line) => JSON.parse(line) as { method?: string })
        .filter((message) => message.method === 'notifications/tools/list_changed')
      expect(notifications).toHaveLength(1)
    } finally {
      // Clean up the endpoint first: a failing assertion below must not leak it.
      const code = await bridge.close()
      await fake.close()
      expect(code).toBe(0)
    }
  })
})

describe('stdio ⇄ HTTP bridge', () => {
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

  it('completes the handshake, lists tools, and calls one over stdio', async () => {
    const { stdout, stderr, code } = await runBridge({
      env: { DSH_AS_MCP_URL: url, DSH_AS_MCP_TOKEN: TOKEN },
      lines: [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'vitest-stdio', version: '0' },
          },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'dsh_info', arguments: {} },
        }),
      ],
      expectLines: 3,
    })

    expect(code).toBe(0)
    expect(stderr).not.toContain('request failed')

    const replies = stdout.map((line) => JSON.parse(line) as {
      id?: number
      result?: Record<string, unknown>
    })

    // One reply per request id, and nothing for the notification.
    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3])

    const initialize = replies[0]?.result as { serverInfo?: { name?: string }; protocolVersion?: string }
    expect(initialize.serverInfo?.name).toBe('dsh-as-mcp')

    const list = replies[1]?.result as { tools?: { name: string }[] }
    expect((list.tools ?? []).map((tool) => tool.name)).toContain('workspace_create')

    const call = replies[2]?.result as { content?: { text: string }[] }
    // Reaching a tool result at all proves the bridge forwarded the same token
    // the endpoint demands: a wrong or missing one is a 401 before any tool runs.
    const payload = JSON.parse(call.content?.[0]?.text ?? '{}') as { tokenSource?: string }
    expect(typeof payload.tokenSource).toBe('string')
    // And the result must not hand the credential back.
    expect(call.content?.[0]?.text ?? '').not.toContain(TOKEN)
  })

  it('reads the token from <DSH_HOME>/dsh-as-mcp/token when no env token is set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-as-mcp-home-'))
    await mkdir(join(home, 'dsh-as-mcp'), { recursive: true })
    await writeFile(join(home, 'dsh-as-mcp', 'token'), `${TOKEN}\n`, { mode: 0o600 })

    const { stdout, stderr, code } = await runBridge({
      env: { DSH_AS_MCP_URL: url, DSH_HOME: home, DSH_AS_MCP_TOKEN: '' },
      lines: [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })],
      expectLines: 1,
    })

    expect(code).toBe(0)
    expect(stderr).not.toContain('no bearer token')
    const reply = JSON.parse(stdout[0] ?? '{}') as { result?: { tools?: unknown[] } }
    expect((reply.result?.tools ?? []).length).toBeGreaterThan(0)
  })

  it('answers a request in-band when the endpoint rejects the token', async () => {
    const { stdout, code } = await runBridge({
      env: { DSH_AS_MCP_URL: url, DSH_AS_MCP_TOKEN: 'wrong-token' },
      lines: [JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} })],
      expectLines: 1,
    })

    expect(code).toBe(0)
    const reply = JSON.parse(stdout[0] ?? '{}') as { id?: number; error?: { code: number; message: string } }
    // A stdio client has no HTTP status to inspect, so the failure must arrive
    // as a JSON-RPC error or that client waits forever.
    expect(reply.id).toBe(42)
    expect(reply.error?.code).toBe(-32603)
    expect(reply.error?.message).toContain('401')
  })

  it('prints a help page naming the endpoint and token state', async () => {
    const child = spawn(process.execPath, [bridgePath, '--help'], {
      env: { ...process.env, DSH_AS_MCP_URL: url, DSH_AS_MCP_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    child.stdout.setEncoding('utf8')
    for await (const chunk of child.stdout) text += chunk
    await new Promise((resolve) => child.on('close', resolve))

    expect(text).toContain('dsh-as-mcp')
    expect(text).toContain(url)
    expect(text).toContain('Token:    set')
  })
})

describe('the bridge does not exfiltrate the persisted token', () => {
  /** A scratch DSH_HOME whose token file holds the test token. */
  async function homeWithTokenFile(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-as-mcp-home-'))
    await mkdir(join(home, 'dsh-as-mcp'), { recursive: true })
    await writeFile(join(home, 'dsh-as-mcp', 'token'), `${TOKEN}\n`, { mode: 0o600 })
    return home
  }

  it('refuses to run when the file token would be sent off-host', async () => {
    const home = await homeWithTokenFile()
    const child = spawn(process.execPath, [bridgePath], {
      env: {
        ...process.env,
        DSH_AS_MCP_URL: 'http://example.invalid:8790/mcp',
        DSH_HOME: home,
        DSH_AS_MCP_TOKEN: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))

    // A copied or generated client config with an off-host URL must not be able
    // to silently send the machine-local credential there.
    expect(code).not.toBe(0)
    expect(stderr).toContain('non-loopback')
  })

  it('proceeds when the token was set explicitly, even for an off-host URL', async () => {
    // The opt-in path must not depend on reaching the remote: with an explicit
    // token the guard lets the bridge run, and an immediately-closed stdin means
    // it exits cleanly without the guard's refusal.
    const home = await homeWithTokenFile()
    const { code, stderr } = await runBridge({
      env: {
        ...process.env,
        DSH_AS_MCP_URL: 'http://example.invalid:8790/mcp',
        DSH_HOME: home,
        DSH_AS_MCP_TOKEN: TOKEN,
      },
      lines: [],
      expectLines: 0,
    })
    expect(code).toBe(0)
    expect(stderr).not.toContain('non-loopback')
  })

  /**
   * The guard's host test, driven through the process rather than by importing
   * it, because what matters is whether the token travels.
   *
   * A loopback target exits 0: the bridge is lazy, reaching stdin without
   * opening a connection, so a closed port is never touched. The signal is
   * therefore stderr, not the status code.
   */
  it.each([
    ['http://127.0.0.1:8790/mcp', true],
    ['127.0.0.1:8790/mcp', true],
    ['localhost:8790/mcp', true],
    ['http://localhost.:8790/mcp', true],
    ['http://[::1]:8790/mcp', true],
    ['http://127.5.5.5:8790/mcp', true],
    // The domain-shaped cases are the point of the exact match: a `127.` prefix
    // test accepted every one of these and sent the machine-local token to a host
    // whose DNS the attacker controls.
    ['http://127.0.0.1.attacker.example:8790/mcp', false],
    ['http://127.evil.example:8790/mcp', false],
    ['http://128.0.0.1:8790/mcp', false],
    ['http://example.com:8790/mcp', false],
    ['not a url', false],
  ])('treats %s as loopback: %s', async (target, loopback) => {
    const home = await homeWithTokenFile()
    const { stderr, code } = await runBridge({
      env: { ...process.env, DSH_AS_MCP_URL: target, DSH_HOME: home, DSH_AS_MCP_TOKEN: '' },
      lines: [],
      expectLines: 0,
    })
    if (loopback) {
      expect(stderr).not.toContain('non-loopback')
      expect(code).toBe(0)
      return
    }
    expect(stderr).toContain('non-loopback')
    expect(code).toBe(1)
  })
})

