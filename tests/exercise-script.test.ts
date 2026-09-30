import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { TOKEN, boot, stubDriver } from './harness.js'

const exercisePath = fileURLToPath(new URL('../scripts/exercise.mjs', import.meta.url))

/** Run the exercise script and collect its output. */
async function runExercise(args: string[], env: Record<string, string> = {}): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  const child = spawn(process.execPath, [exercisePath, ...args], {
    // No ambient DSH_AS_MCP_TOKEN here, unlike smoke's helper: each test below
    // is specifically about which of --token/env/file wins, so the baseline
    // must start with no token available anywhere. DSH_HOME points somewhere
    // that cannot exist rather than '' — an empty value falls back to the
    // real home directory, which could pick up this machine's actual token.
    env: { ...process.env, DSH_HOME: '/nonexistent-dsh-home-for-exercise-test', DSH_AS_MCP_TOKEN: '', ...env },
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

describe('scripts/exercise.mjs', () => {
  let url: string
  let stop: () => Promise<void>
  const scratchDirs: string[] = []

  beforeAll(async () => {
    const booted = await boot(stubDriver())
    url = booted.url
    stop = booted.stop
  })

  afterAll(async () => {
    await stop()
  })

  afterEach(async () => {
    // Each test below passes its own unique --dir; clean up whatever it created.
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  function freshScratchDir(name: string): string {
    const dir = join(tmpdir(), `dsh-as-mcp-exercise-test-${name}-${process.pid}`)
    scratchDirs.push(dir)
    return dir
  }

  it('describes itself and the LLM cost on --help without touching the network', async () => {
    const { code, stdout, stderr } = await runExercise(['--help'], { DSH_AS_MCP_URL: 'http://127.0.0.1:1/mcp' })
    expect(code).toBe(0)
    expect(stdout).toContain('Full acceptance run against a live dsh-as-mcp endpoint')
    expect(stdout.toLowerCase()).toContain('real llm calls')
    expect(stdout.toLowerCase()).toContain('costs real money')
    // --help must exit before the endpoint is even resolved, let alone printed.
    expect(stderr).toBe('')
  })

  it('prefers --url over DSH_AS_MCP_URL when both are given', async () => {
    // The env value is a reserved, never-bound port: if the script picked it
    // instead of the flag, this would print the wrong source.
    const { stderr } = await runExercise(
      ['--url', url, '--token', TOKEN, '--dir', freshScratchDir('arg-over-env')],
      { DSH_AS_MCP_URL: 'http://127.0.0.1:2/mcp' },
    )
    expect(stderr).toContain(`endpoint: ${url} (arg)\n`)
  })

  it('falls back to DSH_AS_MCP_URL when --url is not given', async () => {
    // A reserved port: this only proves the env var was read, not that the
    // request succeeded (nothing is listening there).
    const { stderr } = await runExercise([], { DSH_AS_MCP_URL: 'http://127.0.0.1:1/mcp' })
    expect(stderr).toContain('endpoint: http://127.0.0.1:1/mcp (env)\n')
  })

  it('authenticates with DSH_AS_MCP_TOKEN when --token is not given', async () => {
    // This is the regression case: before the fix, exercise.mjs only ever read
    // --token or the token file, so a token supplied purely via the env var
    // was silently dropped and every request went out unauthenticated.
    const { stdout } = await runExercise(
      ['--url', url, '--dir', freshScratchDir('token-from-env')],
      { DSH_AS_MCP_TOKEN: TOKEN },
    )
    expect(stdout).not.toContain('no bearer token found')
    expect(stdout).toContain('✓ initialize')
  })

  it('prefers --token over DSH_AS_MCP_TOKEN when both are given', async () => {
    const { stdout } = await runExercise(
      ['--url', url, '--token', TOKEN, '--dir', freshScratchDir('token-arg-over-env')],
      { DSH_AS_MCP_TOKEN: 'wrong-token' },
    )
    expect(stdout).toContain('✓ initialize')
  })
})
