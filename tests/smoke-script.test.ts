import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TOKEN, boot, stubDriver, testConfig } from './harness.js'

const smokePath = fileURLToPath(new URL('../scripts/smoke.mjs', import.meta.url))

/** Run the smoke script and collect its output. */
async function runSmoke(args: string[], env: Record<string, string> = {}): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  const child = spawn(process.execPath, [smokePath, ...args], {
    env: { ...process.env, DSH_AS_MCP_TOKEN: TOKEN, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  for await (const chunk of child.stdout) stdout += chunk
  for await (const chunk of child.stderr) stderr += chunk
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  return { code, stdout, stderr }
}

describe('scripts/smoke.mjs', () => {
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

  it('reports every read-only step against a live endpoint', async () => {
    const { code, stdout, stderr } = await runSmoke(['--url', url])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout).toContain('initialize')
    expect(stdout).toContain('dsh-as-mcp')
    expect(stdout).toContain('tools/list')
    expect(stdout).toContain('tools/call dsh_info')
    expect(stdout).toContain('endpoint status')
    expect(stdout).toContain('listening=true')
    expect(stdout).toContain('tools/call workspace_list')
    expect(stdout).toContain('OK —')
  })

  it('explains a missing settings entry instead of failing the run', async () => {
    // The endpoint is still fully usable without a settings section, so an
    // absent settings provider must be reported, not treated as a failure.
    const { code, stdout } = await runSmoke(['--url', url])
    expect(code).toBe(0)
    expect(stdout).toContain('settings=absent')
    expect(stdout).toContain('No settings entry')
  })

  it('runs a full workspace → session → agent round trip with --prompt', async () => {
    const { code, stdout } = await runSmoke(['--url', url, '--prompt', 'say hi'])
    expect(code).toBe(0)
    expect(stdout).toContain('--prompt mode')
    expect(stdout).toContain('workspace_create')
    expect(stdout).toContain('session_create')
    expect(stdout).toContain('session_prompt')
    expect(stdout).toContain('session-1')
  })

  it('fails loudly on a wrong token instead of reporting success', async () => {
    const { code, stdout } = await runSmoke(['--url', url], { DSH_AS_MCP_TOKEN: 'wrong-token' })
    expect(code).toBe(1)
    expect(stdout).toContain('401')
    expect(stdout).not.toContain('OK —')
  })

  it('refuses to run when no token can be found', async () => {
    const { code, stdout } = await runSmoke(['--url', url], {
      DSH_AS_MCP_TOKEN: '',
      DSH_HOME: '/nonexistent-dsh-home-for-smoke',
    })
    expect(code).toBe(1)
    expect(stdout).toContain('No bearer token found')
  })

  it('fails loudly when nothing is listening', async () => {
    // Port 1 is reserved and never served.
    const { code, stdout } = await runSmoke(['--url', 'http://127.0.0.1:1/mcp'])
    expect(code).toBe(1)
    expect(stdout).toContain('smoke test failed')
  })

  it('flags a profile that mounted no driveable service', async () => {
    // A row with every tool group on but no harness service behind it: the
    // script must say so rather than print a green tick.
    const bare = await boot(stubDriver({ describeCapabilities: () => ({}) }))
    try {
      const { stdout } = await runSmoke(['--url', bare.url])
      expect(stdout).toContain('mounted no driveable harness service')
    } finally {
      await bare.stop()
    }
  })

  it('describes itself on --help without touching the network', async () => {
    const { code, stdout } = await runSmoke(['--help'], { DSH_AS_MCP_URL: 'http://127.0.0.1:1/mcp' })
    expect(code).toBe(0)
    expect(stdout).toContain('Smoke-test a running dsh-as-mcp endpoint')
  })
})

describe('testConfig sanity', () => {
  it('keeps a free-ish default port distinct from the live DSH web port', () => {
    // The plugin's default must not collide with the DSH web surface.
    expect(testConfig().http.port).toBe(0)
  })
})
