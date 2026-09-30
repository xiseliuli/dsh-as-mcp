#!/usr/bin/env node
/**
 * Smoke-test a running dsh-as-mcp endpoint.
 *
 * Read-only by default: it shakes hands, lists tools, and calls `dsh_info` and
 * `workspace_list`. With `--prompt <text>` it also runs one real round trip —
 * create a workspace in a temp directory, start a session, hand the DSH agent a
 * task, and print what came back.
 *
 * Configuration:
 *   DSH_AS_MCP_URL    endpoint URL, default http://127.0.0.1:8790/mcp
 *   DSH_AS_MCP_TOKEN  bearer token; otherwise read from
 *                     <DSH_HOME>/dsh-as-mcp/token
 *
 * Usage:
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --prompt "Create a file named hello.txt containing hi"
 *
 * Exit status is 0 only when every step succeeded, so it works as a CI gate.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'Smoke-test a running dsh-as-mcp endpoint.\n\n'
    + '  node scripts/smoke.mjs [--prompt <text>] [--url <url>] [--token <token>]\n\n'
    + 'Environment: DSH_AS_MCP_URL, DSH_AS_MCP_TOKEN, DSH_HOME\n',
  )
  process.exit(0)
}

/** Read `--flag value` from argv. */
function flag(name) {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv ? fromEnv : join(homedir(), '.dsh')
}

function tokenFilePath() {
  return join(resolveDshHome(), 'dsh-as-mcp', 'token')
}

// An explicit flag wins, then the environment variable, then the default — and
// the caller is told which one resolved before anything is sent, since
// silently landing on the default endpoint is exactly how a stray run once
// hit a real, already-running DSH instance instead of a test fixture.
const urlFromArg = flag('url')
const urlFromEnv = process.env.DSH_AS_MCP_URL?.trim()
const endpoint = urlFromArg ?? urlFromEnv ?? 'http://127.0.0.1:8790/mcp'
const endpointSource = urlFromArg ? 'arg' : urlFromEnv ? 'env' : 'default'
const token = flag('token') ?? process.env.DSH_AS_MCP_TOKEN?.trim() ?? readToken()
const prompt = flag('prompt')

process.stderr.write(`endpoint: ${endpoint} (${endpointSource})\n`)

function readToken() {
  try {
    return readFileSync(tokenFilePath(), 'utf8').trim()
  } catch {
    return ''
  }
}

let protocolVersion
let nextId = 1
let failures = 0

// Colour only on a terminal: piping to a log or a CI capture should produce
// plain text, and an ANSI reset mid-line breaks naive grep/diff consumers.
const useColor = process.stdout.isTTY === true && !argv.includes('--no-color')
const dim = (text) => (useColor ? `\u001b[2m${text}\u001b[0m` : text)
const green = (text) => (useColor ? `\u001b[32m${text}\u001b[0m` : text)
const red = (text) => (useColor ? `\u001b[31m${text}\u001b[0m` : text)

function step(ok, label, detail) {
  const mark = ok ? green('✓') : red('✗')
  process.stdout.write(`${mark} ${label.padEnd(26)}${detail ? dim(detail) : ''}\n`)
  if (!ok) failures += 1
}

/** POST one JSON-RPC message, reading either framing the transport may use. */
async function rpc(method, params) {
  const id = nextId++
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })

  if (response.status === 401) throw new Error('401 unauthorized — wrong or missing bearer token')
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail.trim()}` : ''}`)
  }

  const body = await response.text()
  const payload = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
      .find((entry) => entry.id === id)
    : JSON.parse(body)

  if (payload === undefined) throw new Error(`no reply for id ${id}: ${body.slice(0, 200)}`)
  if (payload.error) throw new Error(`JSON-RPC ${payload.error.code}: ${payload.error.message}`)
  return payload.result
}

/** Call one tool and return its parsed JSON payload. */
async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result?.content?.[0]?.text ?? ''
  if (result?.isError) throw new Error(text)
  return JSON.parse(text)
}

async function main() {
  process.stdout.write(`dsh-as-mcp smoke test\n`)
  process.stdout.write(`${dim('endpoint')}  ${endpoint}\n`)
  process.stdout.write(
    `${dim('token')}     ${token ? `from ${flag('token') ? '--token' : process.env.DSH_AS_MCP_TOKEN ? 'DSH_AS_MCP_TOKEN' : tokenFilePath()}` : 'MISSING'}\n\n`,
  )

  if (!token) {
    process.stdout.write(`${red('No bearer token found.')} Start DSH once so ${tokenFilePath()} exists,\nset DSH_AS_MCP_TOKEN, or point --url at another endpoint.\n`)
    process.exit(1)
  }

  // --- handshake ---
  const initialize = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-as-mcp-smoke', version: '0' },
  })
  protocolVersion = initialize?.protocolVersion
  step(
    true,
    'initialize',
    `${initialize?.serverInfo?.name} ${initialize?.serverInfo?.version}, protocol ${protocolVersion}`,
  )

  const list = await rpc('tools/list', {})
  const names = (list?.tools ?? []).map((tool) => tool.name)
  step(names.length > 0, 'tools/list', `${names.length} tools`)

  // `dsh_info` is the diagnostic that matters: it reports which harness
  // services this profile actually mounted.
  const info = await callTool('dsh_info')
  const available = Object.entries(info.harnessServices ?? {})
    .filter(([, present]) => present)
    .map(([service]) => service)
  step(available.length > 0, 'tools/call dsh_info', `services: ${available.join(', ') || 'none'}`)
  if (available.length === 0) {
    process.stdout.write(
      `${red('This profile mounted no driveable harness service.')} Sessions, files, and shell need\n`
      + `a profile built on @deepseek-ai/dsh-base and @deepseek-ai/dsh-web-app.\n`,
    )
  }

  // The endpoint's own view of itself. Without this, "the plugin is not mounted"
  // and "the plugin is mounted but its listener never bound" look identical from
  // the outside, and they have entirely different fixes.
  const settingsNote = info.settingsRegistered === true ? 'registered' : 'absent'
  step(info.listening !== false, 'endpoint status', `listening=${info.listening === true} settings=${settingsNote}`)
  if (info.listenError) {
    process.stdout.write(`${red('The listener failed to bind:')} ${info.listenError}\n`)
  }
  if (info.settingsRegistered !== true) {
    process.stdout.write(
      `${dim('No settings entry: this host provided no settings service, or its plugin resolver could')}\n`
      + `${dim('not supply @deepseek-ai/schemastery. Configuration then comes from the plugin row alone:')}\n`
      + `${dim('the endpoint still works, but the settings panel shows no section for it.')}\n`,
    )
  }

  if (names.includes('workspace_list')) {
    const workspaces = await callTool('workspace_list')
    const count = workspaces.workspaces?.length ?? 0
    step(true, 'tools/call workspace_list', `${count} workspace${count === 1 ? '' : 's'}`)
  }

  // --- optional full round trip ---
  if (prompt !== undefined) {
    process.stdout.write(`\n${dim('--prompt mode: one real workspace → session → agent round trip')}\n`)

    const dir = mkdtempSync(join(tmpdir(), 'dsh-as-mcp-smoke-'))
    const created = await callTool('workspace_create', { path: dir, title: 'dsh-as-mcp smoke test' })
    step(true, 'workspace_create', dir)

    const session = await callTool('session_create', { workspaceId: created.workspace.id })
    step(true, 'session_create', session.sessionId)
    if (session.model) process.stdout.write(`${dim('  model')}  ${session.model}\n`)

    const turn = await callTool('session_prompt', { sessionId: session.sessionId, prompt })
    const outcome = turn.turn
    step(!outcome?.timedOut, 'session_prompt', outcome
      ? `turn ${outcome.turn}, ${outcome.toolCalls.length} tool call(s), ${outcome.reply.length} chars`
      : 'accepted, no turn waited')

    if (outcome?.toolCalls?.length) {
      for (const call of outcome.toolCalls) {
        process.stdout.write(`${dim('  tool')}  ${call.name} ${dim(call.arguments?.slice(0, 100) ?? '')}\n`)
      }
    }
    if (outcome?.reply) {
      process.stdout.write(`\n${dim('reply:')}\n${outcome.reply}\n`)
    }
    if (outcome?.timedOut) {
      process.stdout.write(
        `\n${red('The turn did not settle before the timeout.')} The message is queued; inspect the\n`
        + `session in the DSH UI. Raise session.promptTimeoutMs for long tasks.\n`,
      )
    }
  }

  process.stdout.write('\n')
  if (failures > 0) {
    process.stdout.write(`${red(`${failures} step(s) failed.`)}\n`)
    process.exit(1)
  }
  process.stdout.write(`${green('OK')} — the endpoint speaks MCP and can drive this DSH instance.\n`)
}

main().catch((error) => {
  process.stdout.write(`\n${red('smoke test failed:')} ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
