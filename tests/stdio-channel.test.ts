import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const bridgePath = fileURLToPath(new URL('../bin/mcp-stdio.mjs', import.meta.url))

interface FakeSession {
  running: boolean
  lastTurn: { turn: number; endedAt: string; reason: unknown } | null
  failure: { kind: string; message: string } | null
  title?: string
  origin?: 'subagent'
}

interface Seen {
  method: string
  session: string | undefined
  body: any
}

/**
 * A fake stateful legacy MCP endpoint. It keeps session state the bridge reads
 * through `resources/read`, and can push `notifications/resources/updated` on
 * every open GET stream.
 */
class FakeDsh {
  readonly seen: Seen[] = []
  readonly sessions = new Map<string, FakeSession>()
  initializeParams: any[] = []
  upstreamInstructions: string | undefined = 'UPSTREAM-INSTRUCTIONS'
  /** Status answered to every GET (404 simulates an endpoint with no usable stream). */
  getStatus = 0
  /** Status answered to `initialize` instead of a session (0 = serve normally). */
  initializeStatus = 0
  /** Answer the first `notifications/initialized` with 404. */
  dropInitializedOnce = false
  sessionPrefix = 'sess'
  private server: Server | undefined
  private readonly streams = new Set<ServerResponse>()
  private live = new Set<string>()
  private counter = 0
  port = 0

  async listen(port = 0): Promise<void> {
    this.server = createServer((request, response) => this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(port, '127.0.0.1', resolve)
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.end()
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }

  /** Forget every session, as a restarted endpoint would. */
  restart(): void {
    this.forget()
    for (const stream of this.streams) stream.end()
  }

  /** Forget every session but leave the streams open. */
  forget(): void {
    this.live.clear()
  }

  add(id: string, extra: Partial<FakeSession> = {}): FakeSession {
    const session: FakeSession = { running: false, lastTurn: null, failure: null, ...extra }
    this.sessions.set(id, session)
    return session
  }

  endTurn(id: string, turn: number, reason: unknown = { kind: 'completed' }, failure: FakeSession['failure'] = null): void {
    const session = this.sessions.get(id)!
    session.running = false
    session.lastTurn = { turn, endedAt: new Date().toISOString(), reason }
    session.failure = failure
  }

  push(uri: string): void {
    const payload = { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } }
    for (const stream of this.streams) stream.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  count(predicate: (seen: Seen) => boolean): number {
    return this.seen.filter(predicate).length
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const session = request.headers['mcp-session-id'] as string | undefined
    if (request.method === 'GET') {
      if (this.getStatus !== 0) {
        response.writeHead(this.getStatus).end()
        return
      }
      if (session === undefined || !this.live.has(session)) {
        response.writeHead(404).end()
        return
      }
      this.seen.push({ method: 'GET', session, body: undefined })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.flushHeaders()
      this.streams.add(response)
      response.on('close', () => this.streams.delete(response))
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      this.seen.push({ method: body.method, session, body })
      this.answer(body, session, response)
    })
  }

  private json(response: ServerResponse, id: unknown, result: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(200, { 'content-type': 'application/json', ...headers })
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }

  private answer(body: any, session: string | undefined, response: ServerResponse): void {
    if (body.method === 'initialize') {
      if (this.initializeStatus !== 0) {
        response.writeHead(this.initializeStatus, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'refused' }))
        return
      }
      this.initializeParams.push(body.params)
      this.counter += 1
      const issued = `${this.sessionPrefix}-${this.counter}`
      this.live.add(issued)
      this.json(response, body.id, {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {}, resources: { subscribe: true } },
        serverInfo: { name: 'fake-dsh', version: '0' },
        ...(this.upstreamInstructions === undefined ? {} : { instructions: this.upstreamInstructions }),
      }, { 'mcp-session-id': issued })
      return
    }
    if (body.method === 'notifications/initialized' && this.dropInitializedOnce) {
      this.dropInitializedOnce = false
      response.writeHead(404).end()
      return
    }
    if (session === undefined || !this.live.has(session)) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }))
      return
    }
    if (body.id === undefined) {
      response.writeHead(202).end()
      return
    }
    if (body.method === 'resources/subscribe') return this.json(response, body.id, {})
    if (body.method === 'resources/read') {
      const uri: string = body.params.uri
      return this.json(response, body.id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(this.read(uri)) }] })
    }
    if (body.method === 'tools/call') {
      const name = body.params.name
      let payload: unknown = { accepted: true }
      if (name === 'session_create') {
        this.add('abcdef12-created')
        payload = { sessionId: 'abcdef12-created' }
      }
      return this.json(response, body.id, { content: [{ type: 'text', text: JSON.stringify(payload) }] })
    }
    this.json(response, body.id, {})
  }

  private read(uri: string): unknown {
    if (uri === 'dsh://sessions') {
      return {
        sessions: [...this.sessions].map(([sessionId, s]) => ({
          sessionId,
          running: s.running,
          updatedAt: 0,
          ...(s.origin === undefined ? {} : { origin: s.origin }),
        })),
        total: this.sessions.size,
      }
    }
    const match = /^dsh:\/\/session\/([^/]+)\/(status|projections)$/.exec(uri)
    const s = match === null ? undefined : this.sessions.get(match[1]!)
    if (match === null || s === undefined) return {}
    if (match[2] === 'projections') return s.title === undefined ? {} : { title: s.title }
    return { sessionId: match[1], running: s.running, lastTurn: s.lastTurn, failure: s.failure, stalled: false, idleMs: 0 }
  }
}

class Bridge {
  readonly lines: any[] = []
  stderr = ''
  exitCode: number | null | undefined
  private readonly child: ChildProcessWithoutNullStreams
  private buffer = ''
  private nextId = 100

  constructor(url: string, args: string[] = ['--channel'], env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [bridgePath, ...args], {
      env: { ...process.env, DSH_AS_MCP_URL: url, DSH_AS_MCP_TOKEN: 'test-token', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.on('close', (code) => { this.exitCode = code })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line !== '') this.lines.push(JSON.parse(line))
        newline = this.buffer.indexOf('\n')
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => { this.stderr += chunk })
  }

  send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    this.send({ jsonrpc: '2.0', id, method, params })
    await waitFor(() => this.lines.some((line) => line.id === id), `reply to ${method}\n${this.stderr}`)
    return this.lines.find((line) => line.id === id)
  }

  async handshake(protocolVersion = '2026-07-28'): Promise<any> {
    const reply = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'vitest-channel', version: '0' },
    })
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return reply
  }

  channel(): any[] {
    return this.lines.filter((line) => line.method === 'notifications/claude/channel')
  }

  /** Close stdin and report how long the process took to exit, and with what code. */
  async closeAndTime(limitMs = 10_000): Promise<{ ms: number; code: number | null | undefined }> {
    const started = Date.now()
    this.child.stdin.end()
    await waitFor(() => this.exitCode !== undefined, 'bridge exit', limitMs)
    return { ms: Date.now() - started, code: this.exitCode }
  }

  async stop(): Promise<void> {
    const exited = new Promise<void>((resolve) => this.child.on('close', () => resolve()))
    this.child.stdin.end()
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => { this.child.kill(); resolve() }, 5000))])
  }
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const settle = async (ms = 400): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

describe('stdio bridge --channel', { timeout: 30_000 }, () => {
  const bridges: Bridge[] = []
  const fakes: FakeDsh[] = []
  afterEach(async () => {
    await Promise.all(bridges.splice(0).map(async (bridge) => bridge.stop()))
    await Promise.all(fakes.splice(0).map(async (fake) => fake.close()))
  })

  async function boot(args?: string[]): Promise<{ fake: FakeDsh; bridge: Bridge }> {
    const fake = new FakeDsh()
    await fake.listen()
    fakes.push(fake)
    const bridge = new Bridge(fake.url, args)
    bridges.push(bridge)
    return { fake, bridge }
  }

  /** Run a client session create so the bridge owns `abcdef12-created`, with its subscriptions in place. */
  async function ownCreated(fake: FakeDsh, bridge: Bridge): Promise<string> {
    await bridge.request('tools/call', { name: 'session_create', arguments: {} })
    const id = 'abcdef12-created'
    await waitFor(
      () => fake.count((seen) => seen.method === 'resources/subscribe' && seen.body.params.uri === `dsh://session/${id}/turn`) > 0,
      'turn subscription',
    )
    // The baseline status read must land before the test ends a turn.
    await waitFor(
      () => fake.count((seen) => seen.method === 'resources/read' && seen.body.params.uri === `dsh://session/${id}/status`) > 0,
      'baseline status read',
    )
    return id
  }

  it('rewrites the protocol revision upstream and injects the channel capability', async () => {
    const { fake, bridge } = await boot()
    const reply = await bridge.handshake('2026-07-28')
    expect(fake.initializeParams[0].protocolVersion).toBe('2025-06-18')
    expect(reply.result.protocolVersion).toBe('2025-06-18')
    expect(reply.result.capabilities.experimental['claude/channel']).toEqual({})
    expect(reply.result.capabilities.tools).toEqual({})
    expect(reply.result.instructions.startsWith('UPSTREAM-INSTRUCTIONS')).toBe(true)
    expect(reply.result.instructions).toContain('<channel source="dsh"')
    expect(reply.result.instructions).toContain('session_status')
    await waitFor(() => fake.count((seen) => seen.method === 'resources/subscribe' && seen.body.params.uri === 'dsh://sessions') > 0, 'sessions subscribe')
  })

  it('pushes exactly one notification per owned turn, with correct meta, and never twice', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    const id = await ownCreated(fake, bridge)
    fake.sessions.get(id)!.title = 'Fix the login bug'
    fake.endTurn(id, 3)
    fake.push(`dsh://session/${id}/turn`)
    await waitFor(() => bridge.channel().length === 1, 'channel notification')
    const params = bridge.channel()[0].params
    expect(params.content).toBe('DSH session "Fix the login bug" turn 3 ended: completed')
    expect(params.meta).toEqual({
      session_id: id,
      title: 'Fix the login bug',
      turn: '3',
      reason: 'completed',
      failure_kind: 'none',
    })
    const reads = fake.count((seen) => seen.method === 'resources/read')
    fake.push(`dsh://session/${id}/turn`)
    fake.push(`dsh://session/${id}/status`)
    fake.push('dsh://sessions')
    await waitFor(() => fake.count((seen) => seen.method === 'resources/read') > reads, 'a re-read')
    await settle()
    expect(bridge.channel()).toHaveLength(1)
  })

  it('subscribes before it forwards session_prompt', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    fake.add('existing-1')
    fake.endTurn('existing-1', 2)
    await bridge.request('tools/call', { name: 'session_prompt', arguments: { sessionId: 'existing-1', prompt: 'go', wait: false } })
    const methods = fake.seen.map((seen) => `${seen.method}:${seen.body?.params?.uri ?? seen.body?.params?.name ?? ''}`)
    const subscribe = methods.indexOf('resources/subscribe:dsh://session/existing-1/turn')
    const prompt = methods.indexOf('tools/call:session_prompt')
    expect(subscribe).toBeGreaterThan(-1)
    expect(subscribe).toBeLessThan(prompt)
    // The turn that was already over before the prompt is history, not news.
    await settle()
    expect(bridge.channel()).toHaveLength(0)
    fake.sessions.get('existing-1')!.running = true
    fake.push('dsh://sessions')
    await settle(200)
    fake.endTurn('existing-1', 3)
    fake.push('dsh://session/existing-1/turn')
    await waitFor(() => bridge.channel().length === 1, 'turn 3 notification')
    expect(bridge.channel()[0].params.meta.turn).toBe('3')
  })

  it('ignores sessions it did not dispatch in owned mode', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    await ownCreated(fake, bridge)
    fake.add('foreign-session-1')
    fake.endTurn('foreign-session-1', 1)
    fake.push('dsh://session/foreign-session-1/turn')
    fake.push('dsh://sessions')
    await settle(600)
    expect(bridge.channel()).toHaveLength(0)
  })

  it('tracks foreign sessions in all mode but not sub-agent sessions', async () => {
    const { fake, bridge } = await boot(['--channel', '--channel-scope=all'])
    fake.add('foreign-session-1', { running: true })
    fake.add('child-agent-0001', { running: true, origin: 'subagent' })
    await bridge.handshake()
    await waitFor(
      () => fake.count((seen) => seen.method === 'resources/subscribe' && seen.body.params.uri === 'dsh://session/foreign-session-1/turn') > 0,
      'foreign subscription',
    )
    fake.endTurn('foreign-session-1', 1)
    fake.endTurn('child-agent-0001', 1)
    fake.push('dsh://sessions')
    await waitFor(() => bridge.channel().length === 1, 'all-mode notification')
    await settle()
    expect(bridge.channel()).toHaveLength(1)
    expect(bridge.channel()[0].params.meta.session_id).toBe('foreign-session-1')
    expect(bridge.channel()[0].params.meta.title).toBe('foreign-')
  })

  it('reports a failure in content and failure_kind', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    const id = await ownCreated(fake, bridge)
    const message = `boom ${'x'.repeat(300)}`
    fake.endTurn(id, 2, { kind: 'error', error: { message } }, { kind: 'error', message })
    fake.push(`dsh://session/${id}/turn`)
    await waitFor(() => bridge.channel().length === 1, 'failure notification')
    const params = bridge.channel()[0].params
    expect(params.meta.failure_kind).toBe('error')
    expect(params.meta.reason).toBe('error')
    expect(params.meta.title).toBe('abcdef12')
    expect(params.content.startsWith('DSH session "abcdef12" turn 2 ended: error — failed (error): boom ')).toBe(true)
    expect(params.content.split('): ').at(-1)!.length).toBeLessThanOrEqual(200)
    expect(params.content).not.toContain('\n')
  })

  it('answers initialize locally while DSH is down, then works once it is up', async () => {
    const probe = new FakeDsh()
    await probe.listen()
    const port = probe.port
    await probe.close()
    const bridge = new Bridge(`http://127.0.0.1:${port}/mcp`)
    bridges.push(bridge)
    const reply = await bridge.handshake()
    expect(reply.result.protocolVersion).toBe('2025-06-18')
    expect(reply.result.capabilities.experimental['claude/channel']).toEqual({})
    expect(reply.result.instructions).toContain('<channel source="dsh"')
    const refused = await bridge.request('tools/list', {})
    expect(refused.error.code).toBe(-32603)
    expect((await bridge.request('ping', {})).result).toEqual({})

    const fake = new FakeDsh()
    await fake.listen(port)
    fakes.push(fake)
    await waitFor(() => fake.count((seen) => seen.method === 'notifications/initialized') > 0, 'upstream handshake', 15_000)
    expect(fake.initializeParams[0].protocolVersion).toBe('2025-06-18')
    await waitFor(() => fake.count((seen) => seen.method === 'resources/subscribe') > 0, 'subscription')
    const id = await ownCreated(fake, bridge)
    fake.endTurn(id, 1)
    fake.push(`dsh://session/${id}/turn`)
    await waitFor(() => bridge.channel().length === 1, 'notification after recovery')
  }, 30_000)

  it('re-initializes after a 404 and keeps pushing', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    const id = await ownCreated(fake, bridge)
    fake.restart()
    // The next request hits the forgotten session and must be retried on a new one.
    const reply = await bridge.request('tools/list', {})
    expect(reply.error).toBeUndefined()
    expect(fake.initializeParams).toHaveLength(2)
    await waitFor(
      () => fake.count((seen) => seen.method === 'resources/subscribe' && seen.session === 'sess-2' && seen.body.params.uri === `dsh://session/${id}/turn`) > 0,
      're-subscription on the new session',
    )
    await waitFor(() => fake.count((seen) => seen.method === 'GET' && seen.session === 'sess-2') > 0, 'push stream on the new session')
    // The baseline read on the new session has to land before the turn ends.
    await waitFor(
      () => fake.count((seen) => seen.method === 'resources/read' && seen.session === 'sess-2' && String(seen.body.params.uri).endsWith('/status')) > 0,
      'baseline status read on the new session',
    )
    fake.endTurn(id, 4)
    fake.push(`dsh://session/${id}/turn`)
    await waitFor(() => bridge.channel().length === 1, 'notification on the new session')
    expect(bridge.channel()[0].params.meta.turn).toBe('4')
  })

  it('never writes internal replies to stdout', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    const id = await ownCreated(fake, bridge)
    fake.endTurn(id, 1)
    fake.push(`dsh://session/${id}/turn`)
    await waitFor(() => bridge.channel().length === 1, 'notification')
    const internal = fake.seen.filter((seen) => typeof seen.body?.id === 'string' && seen.body.id.startsWith('dsh-channel:'))
    expect(internal.length).toBeGreaterThan(2)
    for (const line of bridge.lines) {
      expect(typeof line.id === 'string' && line.id.startsWith('dsh-channel:')).toBe(false)
      expect(line.result?.contents).toBeUndefined()
    }
    expect(bridge.stderr).not.toContain('test-token')
  })

  it('still forwards resources/updated to the client', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    await waitFor(() => fake.count((seen) => seen.method === 'GET') > 0, 'push stream')
    fake.push('dsh://jobs')
    await waitFor(() => bridge.lines.some((line) => line.method === 'notifications/resources/updated'), 'forwarded update')
  })

  it('survives internal 404s while the upstream cannot be re-initialized, then recovers', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    const id = await ownCreated(fake, bridge)
    fake.forget()
    fake.initializeStatus = 503
    // Several internal requests hit the forgotten session at once.
    fake.push(`dsh://session/${id}/turn`)
    fake.push(`dsh://session/${id}/status`)
    fake.push('dsh://sessions')
    // The bounded wait for recovery (8 s) expires with nobody to retry it: this used to exit 1.
    await settle(9500)
    expect(bridge.exitCode).toBeUndefined()
    expect(bridge.stderr).not.toContain('unhandled')
    fake.initializeStatus = 0
    await waitFor(() => fake.initializeParams.length === 2, 'background re-initialize', 25_000)
    await waitFor(
      () => fake.count((seen) => seen.method === 'resources/read' && seen.session === 'sess-2' && String(seen.body.params.uri).endsWith(`${id}/status`)) > 0,
      'baseline on the new session',
    )
    fake.endTurn(id, 7)
    fake.push(`dsh://session/${id}/turn`)
    await waitFor(() => bridge.channel().length === 1, 'notification after recovery')
    expect(bridge.exitCode).toBeUndefined()
  }, 60_000)

  it('does not loop on re-initialize when only GET answers 404', async () => {
    const { fake, bridge } = await boot()
    fake.getStatus = 404
    await bridge.handshake()
    await waitFor(() => bridge.stderr.includes('push disabled'), 'push-disabled note')
    await settle(3000)
    expect(fake.initializeParams.length).toBeLessThanOrEqual(2)
    expect(bridge.exitCode).toBeUndefined()
    // Request/reply still works on the same session.
    expect((await bridge.request('tools/list', {})).error).toBeUndefined()
  })

  it('keeps pushing after notifications/initialized fails to forward', async () => {
    const { fake, bridge } = await boot()
    fake.dropInitializedOnce = true
    await bridge.handshake()
    await waitFor(() => fake.initializeParams.length === 2, 're-initialize after the failed forward')
    await waitFor(() => fake.count((seen) => seen.method === 'GET' && seen.session === 'sess-2') > 0, 'push stream')
    const id = await ownCreated(fake, bridge)
    fake.endTurn(id, 1)
    fake.push(`dsh://session/${id}/turn`)
    await waitFor(() => bridge.channel().length === 1, 'notification')
  })

  it('announces a turn that ended during a disconnect exactly once', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    fake.add('existing-1')
    fake.endTurn('existing-1', 2)
    // wait:false, and the bridge never sees the session running.
    await bridge.request('tools/call', { name: 'session_prompt', arguments: { sessionId: 'existing-1', prompt: 'go', wait: false } })
    fake.restart()
    fake.endTurn('existing-1', 3)
    await waitFor(() => bridge.channel().length === 1, 'replayed notification', 20_000)
    expect(bridge.channel()[0].params.meta.turn).toBe('3')
    fake.push('dsh://session/existing-1/turn')
    fake.push('dsh://sessions')
    await settle(800)
    expect(bridge.channel()).toHaveLength(1)
  }, 40_000)

  it('recovers when the upstream restarts on the same port with new session ids', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    const id = await ownCreated(fake, bridge)
    const port = fake.port
    await fake.close()
    fakes.splice(fakes.indexOf(fake), 1)
    await settle(800)
    const next = new FakeDsh()
    next.sessionPrefix = 'reborn'
    next.add(id)
    await next.listen(port)
    fakes.push(next)
    await waitFor(() => next.initializeParams.length === 1, 're-initialize on the restarted upstream', 25_000)
    await waitFor(
      () => next.count((seen) => seen.method === 'resources/read' && seen.session === 'reborn-1' && String(seen.body.params.uri).endsWith(`${id}/status`)) > 0,
      'baseline on the restarted upstream',
      15_000,
    )
    next.endTurn(id, 9)
    next.push(`dsh://session/${id}/turn`)
    await waitFor(() => bridge.channel().length === 1, 'notification after the restart')
    expect(bridge.exitCode).toBeUndefined()
  }, 60_000)

  it('exits promptly after stdin closes, even while the upstream is being retried', async () => {
    const { fake, bridge } = await boot()
    await bridge.handshake()
    await ownCreated(fake, bridge)
    await fake.close()
    fakes.splice(fakes.indexOf(fake), 1)
    await settle(600)
    const { ms, code } = await bridge.closeAndTime()
    expect(code).toBe(0)
    expect(ms).toBeLessThan(6000)
  })

  it('says authentication failed, not unreachable, when initialize is refused with 401', async () => {
    const fake = new FakeDsh()
    fake.initializeStatus = 401
    await fake.listen()
    fakes.push(fake)
    const bridge = new Bridge(fake.url)
    bridges.push(bridge)
    await bridge.handshake()
    const refused = await bridge.request('tools/list', {})
    expect(refused.error.message).toContain('authentication failed')
    expect(bridge.stderr).toContain('authentication failed')
    expect(bridge.stderr).not.toContain('test-token')
  })
})
