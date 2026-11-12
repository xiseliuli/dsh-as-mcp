#!/usr/bin/env node
/**
 * Live checks for the human-in-the-loop guard (`approval.guardMutations`).
 *
 * The guard is the one part of the approval bridge this plugin owns end to end, so it
 * can be verified without a model turn: `shell_run` is held before it executes, the
 * pending request is visible through `approval_list` and `dsh://approvals`, and
 * `approval_decide` releases it. Three paths matter, and each is a separate check:
 *
 * - **allow** — the command runs and the caller sees its output;
 * - **reject** — the caller gets a tool error and the command never runs;
 * - **silence** — with no answer the request times out and the caller gets a rejection,
 *   because the bridge must fail closed, never allow by omission.
 *
 *   node tools/live-approval-checks.mjs --url http://127.0.0.1:PORT/mcp \
 *     --token-file /tmp/dsh-live-XXXX/dsh-as-mcp/token
 *
 * @module dsh-as-mcp/tools/live-approval-checks
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The tool count this build registers. */
const TOOL_COUNT = 56

/** Parse `--flag value` arguments. */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep') {
      options.keep = true
      continue
    }
    if (!['--url', '--token', '--token-file'].includes(arg)) throw new Error(`unknown argument ${arg}`)
    options[arg.slice(2)] = argv[index + 1]
    index += 1
  }
  if (options.url === undefined) throw new Error('--url is required')
  return options
}

function resolveToken(options) {
  if (options.token !== undefined) return options.token
  return readFileSync(
    options['token-file'] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-as-mcp', 'token'),
    'utf8',
  ).trim()
}

/** A JSON-RPC client whose tool calls can be left in flight. */
function createClient(url, token) {
  let nextId = 1
  async function rpc(method, params, timeoutMs = 60_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }),
        signal: controller.signal,
      })
      const text = await response.text()
      const frames = [...text.matchAll(/data: (\{.*\})/g)]
      const payload = frames.length > 0 ? JSON.parse(frames[frames.length - 1][1]) : JSON.parse(text)
      return payload
    } finally {
      clearTimeout(timer)
    }
  }
  async function callTool(name, args, timeoutMs = 60_000) {
    const payload = await rpc('tools/call', { name, arguments: args }, timeoutMs)
    if (payload?.error !== undefined) return { isError: true, text: payload.error.message ?? 'transport error' }
    if (payload?.result?.isError === true) return { isError: true, text: payload.result.content?.[0]?.text ?? '' }
    const text = payload?.result?.content?.[0]?.text ?? '{}'
    try {
      return { isError: false, body: JSON.parse(text) }
    } catch {
      return { isError: false, body: { text } }
    }
  }
  return { rpc, callTool, startToolCall: (name, args, timeoutMs) => callTool(name, args, timeoutMs) }
}

function createRunner() {
  const results = []
  return {
    async check(name, body) {
      try {
        const detail = await body()
        results.push({ name, ok: true })
        console.log(`PASS  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
      } catch (error) {
        results.push({ name, ok: false, message: String(error instanceof Error ? error.message : error) })
        console.log(`FAIL  ${name} — ${String(error instanceof Error ? error.message : error)}`)
      }
    },
    summary() {
      const failed = results.filter((result) => !result.ok)
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
      for (const result of failed) console.log(`  FAILED: ${result.name} — ${result.message}`)
      return failed.length
    },
  }
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const client = createClient(options.url, resolveToken(options))
  const runner = createRunner()
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-approval-live-'))
  let sessionId

  console.log(`endpoint ${options.url}`)
  console.log(`scratch  ${scratch}\n`)

  try {
    await runner.check('dsh_info reports guardMutations on and the approval tools available', async () => {
      const info = await client.callTool('dsh_info', {})
      const approval = info.body?.config?.approval ?? {}
      if (approval.guardMutations !== true) {
        throw new Error(`config.approval.guardMutations=${JSON.stringify(approval.guardMutations)}`)
      }
      const unavailable = (info.body?.toolAvailability?.unavailable ?? []).map((entry) => entry.tool)
      for (const tool of ['approval_list', 'approval_decide']) {
        if (unavailable.includes(tool)) throw new Error(`${tool} reported unavailable`)
      }
      return `timeout ${approval.humanTimeoutMs}ms`
    })

    await runner.check('tools/list advertises the approval tools', async () => {
      const { result } = await client.rpc('tools/list', {})
      const names = (result?.tools ?? []).map((tool) => tool.name)
      if (names.length !== TOOL_COUNT) throw new Error(`expected ${TOOL_COUNT} tools, got ${names.length}`)
      for (const tool of ['approval_list', 'approval_decide']) {
        if (!names.includes(tool)) throw new Error(`${tool} missing`)
      }
      return `${names.length} tools`
    })

    const created = await client.callTool('session_create', { cwd: scratch })
    sessionId = created.body?.sessionId
    console.log(`PASS  session_create creates a session — ${sessionId}`)

    await runner.check('a guarded shell_run waits in the queue instead of executing', async () => {
      const running = client.startToolCall('shell_run', { command: `touch ${scratch}/ran-allow.txt`, cwd: scratch }, 60_000)
      let pending
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await wait(250)
        const listed = await client.callTool('approval_list', {})
        pending = (listed.body?.pending ?? [])[0]
        if (pending !== undefined) break
      }
      if (pending === undefined) throw new Error('the held call never appeared in approval_list')
      if (pending.toolName !== 'shell_run') throw new Error(`queued tool=${pending.toolName}`)
      // The resource reports the same queue.
      const read = await client.rpc('resources/read', { uri: 'dsh://approvals' })
      const text = read?.result?.contents?.[0]?.text ?? '{}'
      const queue = JSON.parse(text)
      if ((queue.pending ?? []).length === 0) throw new Error('dsh://approvals does not show the pending request')
      const allowed = await client.callTool('approval_decide', {
        approvalId: pending.approvalId,
        decision: 'allow',
        reason: 'live approval check',
      })
      if (allowed.body?.decided !== true) throw new Error(`decide reply=${JSON.stringify(allowed).slice(0, 200)}`)
      const finished = await running
      if (finished.isError === true) throw new Error(`the allowed call failed: ${finished.text.slice(0, 160)}`)
      const stat = await client.callTool('file_read', { path: join(scratch, 'ran-allow.txt') })
      if (stat.isError === true) throw new Error('the allowed command did not run')
      return `${pending.approvalId} held then allowed; command ran`
    })

    await runner.check('a rejected call is refused and never executes', async () => {
      const running = client.startToolCall('shell_run', { command: `touch ${scratch}/ran-reject.txt`, cwd: scratch }, 60_000)
      let pending
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await wait(250)
        const listed = await client.callTool('approval_list', {})
        pending = (listed.body?.pending ?? [])[0]
        if (pending !== undefined) break
      }
      if (pending === undefined) throw new Error('the second held call never appeared')
      await client.callTool('approval_decide', { approvalId: pending.approvalId, decision: 'reject' })
      const finished = await running
      if (finished.isError !== true) throw new Error('a rejected call returned success')
      const stat = await client.callTool('file_list', { directory: scratch })
      const names = (stat.body?.entries ?? []).map((entry) => entry.name ?? entry.path)
      if (names.some((name) => String(name).includes('ran-reject.txt'))) {
        throw new Error('the rejected command still ran')
      }
      return `rejected: ${finished.text.slice(0, 120)}`
    })

    await runner.check('silence answers rejected once the timeout elapses', async () => {
      const started = Date.now()
      const finished = await client.callTool('shell_run', { command: `touch ${scratch}/ran-timeout.txt`, cwd: scratch }, 90_000)
      const elapsed = Date.now() - started
      if (finished.isError !== true) throw new Error('an unanswered call returned success (the bridge must fail closed)')
      if (elapsed < 5_000) throw new Error(`refused after ${elapsed}ms, too early to be the timeout`)
      const listed = await client.callTool('approval_list', { includeSettled: true })
      const settled = (listed.body?.settled ?? []).find((entry) => entry.decidedBy === 'timeout')
      if (settled === undefined) throw new Error('no timeout-settled record in approval_list')
      if (settled.decision !== 'reject') throw new Error(`timeout decision=${settled.decision}`)
      const stat = await client.callTool('file_list', { directory: scratch })
      const names = (stat.body?.entries ?? []).map((entry) => entry.name ?? entry.path)
      if (names.some((name) => String(name).includes('ran-timeout.txt'))) {
        throw new Error('the timed-out command still ran')
      }
      return `rejected after ${Math.round(elapsed / 1000)}s (decidedBy=timeout)`
    })
  } finally {
    if (sessionId !== undefined) await client.callTool('session_archive', { sessionId }).catch(() => {})
    if (options.keep !== true) {
      const resolved = resolve(scratch)
      if (resolved.startsWith(resolve(tmpdir()) + '/')) rmSync(resolved, { recursive: true, force: true })
    }
    process.exitCode = runner.summary() === 0 ? 0 : 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
