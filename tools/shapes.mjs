#!/usr/bin/env node
/**
 * Verify the endpoint in each deployment shape this project documents.
 *
 * The README carries a table of "tool groups enabled → advertised tools → last
 * result". That table was hand-measured round by round, which is how it once
 * printed 130 for a build that no longer had 130 checks. This script produces the
 * same numbers from one command: for each shape it boots a throwaway profile with
 * that shape's `tools` block, installs the current tarball, waits for the endpoint,
 * runs `tools/live-checks.mjs`, and prints the count.
 *
 * Every temporary profile and process is cleaned up, including on failure. It
 * spends real money for the shapes that pass `--with-model`, exactly like a manual
 * run would.
 *
 * @module dsh-as-mcp/tools/shapes
 *
 * Usage:
 *   node tools/shapes.mjs                          # all shapes, no model spend
 *   node tools/shapes.mjs --with-model             # include the turn-running shapes
 *   node tools/shapes.mjs --shapes full,session    # a subset
 *   node tools/shapes.mjs --tarball /tmp/x.tgz     # reuse a built tarball
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const RUNTIME = process.env.DSH_RUNTIME ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const HOME = homedir()
const DSH_HOME = process.env.DSH_HOME ?? join(HOME, '.dsh')

const SHAPES = [
  {
    id: 'full',
    label: 'all six groups',
    groups: { workspace: true, session: true, files: true, shell: true, agentTools: true, usage: true },
    liveArgs: [],
    model: true,
  },
  {
    id: 'session',
    label: 'session + usage',
    groups: { workspace: false, session: true, files: false, shell: false, agentTools: false, usage: true },
    liveArgs: [],
    model: true,
  },
  {
    id: 'narrow',
    label: 'workspace + session + agentTools + usage',
    groups: { workspace: true, session: true, files: false, shell: false, agentTools: true, usage: true },
    liveArgs: [],
    model: false,
  },
  {
    id: 'files-shell',
    label: 'files + shell',
    groups: { workspace: false, session: false, files: true, shell: true, agentTools: false, usage: false },
    liveArgs: [],
    model: false,
  },
]

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

function flag(name) {
  return process.argv.includes(name)
}

const only = arg('--shapes')
const selected = only === undefined ? SHAPES : SHAPES.filter((shape) => only.split(',').includes(shape.id))
if (selected.length === 0) {
  process.stderr.write(`no matching shape in --shapes ${only}\n`)
  process.exit(2)
}

const tarball = arg('--tarball', join('/tmp', `dsh-as-mcp-${JSON.parse(readFileSync('package.json', 'utf8')).version}.tgz`))
if (!existsSync(tarball)) {
  process.stderr.write(`missing tarball ${tarball}; run \`npm pack --pack-destination /tmp\`\n`)
  process.exit(2)
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: options.quiet === true ? 'ignore' : 'inherit', ...options })
    child.on('exit', (code, signal) => resolve({ code, signal }))
    child.on('error', () => resolve({ code: 1, signal: 'error' }))
  })
}

/** Two free loopback ports, chosen by the OS rather than assumed. */
function allocatePorts() {
  return new Promise((resolve, reject) => {
    const servers = []
    const listen = () => new Promise((done) => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => { servers.push(server); done(server) })
    })
    ;(async () => {
      try {
        const first = await listen()
        const second = await listen()
        const ports = [first.address().port, second.address().port]
        for (const server of servers) server.close()
        resolve(ports)
      } catch (error) {
        reject(error)
      }
    })()
  })
}

async function waitForEndpoint(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: '{}',
        signal: AbortSignal.timeout(2_000),
      })
      // 401 without a token still proves the listener is up and answering.
      if (response.status === 401 || response.status === 200) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/** Wait until the harness services behind the endpoint are mounted, not just the socket. */
async function waitForServices(url, timeoutMs) {
  const tokenPath = join(DSH_HOME, 'dsh-as-mcp', 'token')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const token = readFileSync(tokenPath, 'utf8').trim()
      const initialize = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shapes', version: '1' } } }),
        signal: AbortSignal.timeout(2_000),
      })
      const initText = await initialize.text()
      const version = (/"protocolVersion":"([^"]+)"/.exec(initText) ?? [])[1]
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          ...(version === undefined ? {} : { 'mcp-protocol-version': version }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_info', arguments: {} } }),
        signal: AbortSignal.timeout(5_000),
      })
      const text = await response.text()
      const events = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
      const payload = events.find((event) => event.id === 2) ?? events[0]
      const info = JSON.parse(payload.result.content[0].text)
      // `sessionController` is the last service a composed profile needs; once it is
      // visible, the harness is fully mounted. The socket answers before that.
      if (info.harnessServices?.sessionController === true) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function parseCount(output) {
  // live-checks colors its summary line; strip the escapes before reading numbers.
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '')
  const match = /ALL GOOD\s*—\s*(\d+) passed, (\d+) failed/.exec(plain)
  const fail = /FAILURES\s*—\s*(\d+) passed, (\d+) failed/.exec(plain)
  const found = match ?? fail
  return found === null ? undefined : { passed: Number(found[1]), failed: Number(found[2]) }
}

const results = []
try {
  for (const [index, shape] of selected.entries()) {
    const profile = `dsh-as-mcp-shapes-${process.pid}-${index}`
    const [endpointPort, webPort] = await allocatePorts()
    const profileDir = join(DSH_HOME, 'profiles', profile)
    process.stdout.write(`\n== ${shape.label}\n`)
    rmSync(profileDir, { recursive: true, force: true })
    mkdirSync(profileDir, { recursive: true })

    const created = await run(RUNTIME, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { quiet: true })
    if (created.code !== 0) {
      process.stdout.write('  could not create the profile\n')
      results.push({ shape, passed: 0, failed: 1, detail: 'profile creation failed' })
      continue
    }
    const installed = await run(RUNTIME, ['plugin', '--profile', profile, 'add', tarball], { quiet: true })
    if (installed.code !== 0) {
      process.stdout.write('  could not install the plugin\n')
      results.push({ shape, passed: 0, failed: 1, detail: 'install failed' })
      continue
    }
    writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: dsh-as-mcp
  config:
    http: { enabled: true, host: 127.0.0.1, port: ${endpointPort}, path: /mcp, mountOnWebServer: false }
    tools: { ${Object.entries(shape.groups).map(([group, on]) => `${group}: ${on}`).join(', ')} }
    agentTools: { allow: [], deny: [] }
    session: { agentPreset: '', provider: '', model: '', promptTimeoutMs: 900000, scope: all }
    limits: { maxReadBytes: 1048576, shellTimeoutMs: 120000, agentToolTimeoutMs: 120000 }
    approval: { policy: inherit }
`)

    const serverLog = `/tmp/dsh-as-mcp-shapes-${process.pid}-${index}.log`
    const logFd = openSync(serverLog, 'w')
    const server = spawn(RUNTIME, ['--profile', profile, '--no-open', '--port', String(webPort)], {
      cwd: '/tmp',
      stdio: ['ignore', logFd, logFd],
      detached: false,
    })
    try {
      const ready = await waitForEndpoint(`http://127.0.0.1:${endpointPort}/mcp`, 60_000)
        && await waitForServices(`http://127.0.0.1:${endpointPort}/mcp`, 60_000)
      if (!ready) {
        process.stdout.write(`  endpoint never answered; server log:\n${readFileSync(serverLog, 'utf8').split('\n').slice(-6).join('\n')}\n`)
        results.push({ shape, passed: 0, failed: 1, detail: 'endpoint never answered' })
        continue
      }
      const liveArgs = [...shape.liveArgs, ...(flag('--with-model') && shape.model ? ['--with-model'] : [])]
      const output = await new Promise((resolve) => {
        const child = spawn(process.execPath, [
          'tools/live-checks.mjs',
          '--url', `http://127.0.0.1:${endpointPort}/mcp`,
          ...liveArgs,
        ], {
          cwd: process.cwd(),
          env: { ...process.env, DSH_HOME },
          stdio: 'pipe',
        })
        let text = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => { text += chunk })
        child.stderr.on('data', (chunk) => { text += chunk })
        child.on('exit', (code) => resolve({ code, text }))
      })
      const counts = parseCount(output.text)
      if (counts === undefined) {
        process.stdout.write(output.text.split('\n').slice(-4).join('\n'))
        results.push({ shape, passed: 0, failed: 1, detail: 'no summary line from live-checks' })
      } else {
        results.push({ shape, ...counts })
        process.stdout.write(`  ${counts.passed} passed, ${counts.failed} failed\n`)
        if (counts.failed > 0) {
          const plain = output.text.replace(/\x1b\[[0-9;]*m/g, '')
          for (const line of plain.split('\n')) {
            if (line.includes('✗')) process.stdout.write(`${line}\n`)
          }
        }
      }
    } finally {
      server.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      rmSync(profileDir, { recursive: true, force: true })
      rmSync(serverLog, { force: true })
    }
  }
} finally {
  process.stdout.write('\n== shapes\n')
  let failed = 0
  for (const result of results) {
    failed += result.failed
    process.stdout.write(
      `  ${result.shape.label.padEnd(42)} ${String(result.passed).padStart(4)} passed, ${result.failed} failed`
        + `${result.detail === undefined ? '' : ` (${result.detail})`}\n`,
    )
  }
  process.stdout.write(failed === 0 ? 'all shapes passed\n' : 'SHAPE FAILURES\n')
  process.exitCode = failed === 0 ? 0 : 1
}
