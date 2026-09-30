import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

