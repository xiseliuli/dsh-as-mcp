#!/usr/bin/env node
/**
 * Live checks for the session-orchestration surface: slash commands and durable goals.
 *
 * These are the two moves a human makes in the DSH composer that do not spend a
 * model turn — `/compact`, `/plan`, `/goal`, `/export` go straight to a command
 * handler, and the goal strip reads and writes the harness's durable goal store.
 * A stub can prove the mapping; only a real boot proves that the command names this
 * build admits are the ones the profile actually registers, and that a goal
 * mutation round-trips through the harness's own revision guard.
 *
 * Run it against the throwaway instance `tools/isolated-harness.mjs start` booted:
 *
 *   node tools/live-orchestration-checks.mjs --url http://127.0.0.1:PORT/mcp \
 *     --token-file /tmp/dsh-live-XXXX/dsh-as-mcp/token
 *
 * It creates one throwaway directory and one session (archived afterwards; the
 * harness has no session delete), and touches no other session.
 *
 * @module dsh-as-mcp/tools/live-orchestration-checks
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The tool count this build registers; the orchestration release must not change it accidentally. */
const TOOL_COUNT = 45
/** The commands this endpoint admits; everything else must be refused. */
const PERMITTED = ['compact', 'plan', 'goal', 'export']
/** The two shipped commands deliberately refused. */
const REFUSED = ['permission', 'feedback']

/** Parse `--flag value` arguments and reject unknown ones. */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep') {
      options.keep = true
      continue
    }
    if (!['--url', '--token', '--token-file'].includes(arg)) throw new Error(`unknown argument ${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    options[arg.slice(2)] = value
    index += 1
  }
  if (options.url === undefined) throw new Error('--url is required, e.g. --url http://127.0.0.1:18990/mcp')
  return options
}

/** The bearer token, from the flag, a file, or the plugin's default location. */
function resolveToken(options) {
  if (options.token !== undefined) return options.token
  const file = options['token-file']
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-as-mcp', 'token')
  return readFileSync(file, 'utf8').trim()
}

/** A tiny JSON-RPC client: one request per POST, either framing accepted. */
function createClient(url, token) {
  let nextId = 1
  /** Read one reply out of a JSON or SSE body. */
  async function readReply(response) {
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    if (contentType.includes('text/event-stream')) {
      for (const frame of text.split('\n\n')) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            return JSON.parse(line.slice(5).trim())
          } catch {
            // keep scanning
          }
        }
      }
      return undefined
    }
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  async function rpc(method, params) {
    const id = nextId++
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
    })
    return { status: response.status, payload: await readReply(response) }
  }
  /** Call a tool; throws with the tool's own error text on failure. */
  async function callTool(name, args) {
    const { payload } = await rpc('tools/call', { name, arguments: args })
    if (payload?.error !== undefined) {
      throw new Error(`${name}: ${payload.error.message ?? JSON.stringify(payload.error)}`)
    }
    const text = payload?.result?.content?.[0]?.text
    if (text === undefined) throw new Error(`${name} returned no text content`)
    return JSON.parse(text)
  }
  /** Call a tool expecting the endpoint to refuse it; returns the refusal text. */
  async function expectToolError(name, args) {
    const { payload } = await rpc('tools/call', { name, arguments: args })
    if (payload?.result?.isError === true) {
      return payload.result.content?.[0]?.text ?? ''
    }
    if (payload?.error !== undefined) {
      return payload.error.message ?? JSON.stringify(payload.error)
    }
    throw new Error(`${name} was expected to be refused, but it succeeded: ${JSON.stringify(payload)}`)
  }
  return { rpc, callTool, expectToolError }
}

/** Install one check runner with PASS/FAIL accounting. */
function createRunner() {
  const results = []
  return {
    results,
    async check(name, body) {
      try {
        const detail = await body()
        results.push({ name, ok: true, detail })
        console.log(`PASS  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
      } catch (error) {
        results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
        console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    summary() {
      const failed = results.filter((result) => !result.ok)
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
      for (const result of failed) console.log(`  FAILED: ${result.name} — ${result.detail}`)
      return failed.length
    },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const token = resolveToken(options)
  const url = options.url
  const client = createClient(url, token)
  const runner = createRunner()
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-orchestration-live-'))
  let sessionId

  console.log(`endpoint ${url}`)
  console.log(`scratch  ${scratch}\n`)

  try {
    await runner.check('dsh_info reports the commands and goals probes', async () => {
      const info = await client.callTool('dsh_info', {})
      const services = info.harnessServices ?? {}
      if (services.commands !== true) throw new Error(`harnessServices.commands=${JSON.stringify(services.commands)}`)
      if (services.goals !== true) throw new Error(`harnessServices.goals=${JSON.stringify(services.goals)}`)
      const unavailable = (info.toolAvailability?.unavailable ?? []).map((entry) => entry.tool)
      for (const tool of ['session_command_list', 'session_command', 'session_goal']) {
        if (unavailable.includes(tool)) throw new Error(`${tool} reported unavailable`)
      }
      return `28+ probes; availability names ${info.toolAvailability?.available} tools`
    })

    await runner.check('tools/list advertises the three orchestration tools', async () => {
      const { payload } = await client.rpc('tools/list', {})
      const names = (payload?.result?.tools ?? []).map((tool) => tool.name)
      if (names.length !== TOOL_COUNT) throw new Error(`expected ${TOOL_COUNT} tools, got ${names.length}`)
      for (const tool of ['session_command_list', 'session_command', 'session_goal']) {
        if (!names.includes(tool)) throw new Error(`${tool} missing from tools/list`)
      }
      return `${names.length} tools`
    })

    const created = await client.callTool('session_create', { cwd: scratch })
    sessionId = created.sessionId
    console.log(`PASS  session_create creates a probe session — ${sessionId}`)

    await runner.check('session_command_list names the registered commands and the permitted subset', async () => {
      const listed = await client.callTool('session_command_list', { sessionId })
      const byName = new Map((listed.commands ?? []).map((command) => [command.name, command]))
      for (const name of PERMITTED) {
        const entry = byName.get(name)
        if (entry === undefined) throw new Error(`/${name} is not registered on this profile`)
        if (entry.permitted !== true) throw new Error(`/${name} was reported not permitted`)
        if (typeof entry.description !== 'string' || entry.description === '') {
          throw new Error(`/${name} has no description`)
        }
      }
      for (const name of REFUSED) {
        const entry = byName.get(name)
        if (entry === undefined) continue
        if (entry.permitted !== false) throw new Error(`/${name} was reported permitted`)
      }
      return `${listed.commands.length} commands: ${[...byName.keys()].join(', ')}`
    })

    await runner.check('session_command runs /compact with or without the leading slash', async () => {
      const first = await client.callTool('session_command', { sessionId, command: 'compact' })
      if (typeof first.commandId !== 'string') throw new Error('no commandId in the reply')
      if (typeof first.ok !== 'boolean') throw new Error('no ok flag in the reply')
      // The registry parses the slash form; a bare name must be normalised to it.
      const second = await client.callTool('session_command', { sessionId, command: '/plan' })
      if (typeof second.commandId !== 'string') throw new Error('/plan produced no commandId')
      // Leave plan mode again so the session is not left in a mode.
      const off = await client.callTool('session_command', { sessionId, command: '/plan off' })
      return `compact ok=${first.ok}; plan ok=${second.ok}; plan off ok=${off.ok}`
    })

    await runner.check('session_command refuses /permission and /feedback with the admitted set', async () => {
      for (const name of REFUSED) {
        const message = await client.expectToolError('session_command', {
          sessionId,
          command: `/${name}`,
        })
        if (!/not a command this endpoint runs/.test(message)) {
          throw new Error(`/${name} refusal did not name the allow-list: ${message.slice(0, 160)}`)
        }
        if (!/\/compact, \/plan, \/goal, \/export/.test(message)) {
          throw new Error(`/${name} refusal did not list the admitted commands: ${message.slice(0, 200)}`)
        }
      }
      return '/permission and /feedback refused before any handler ran'
    })

    await runner.check('session_goal starts empty and round-trips create → pause → resume → complete → clear', async () => {
      const empty = await client.callTool('session_goal', { sessionId, action: 'get' })
      if (empty.goal !== null) throw new Error(`a fresh session already has a goal: ${JSON.stringify(empty.goal)}`)
      const createdGoal = await client.callTool('session_goal', {
        sessionId,
        action: 'create',
        objective: 'verify the orchestration surface',
        maxGoalRounds: 4,
      })
      const goal = createdGoal.goal
      if (goal?.objective !== 'verify the orchestration surface') {
        throw new Error(`create reported ${JSON.stringify(goal)}`)
      }
      if (!['active', 'paused', 'blocked', 'complete'].includes(goal.phase)) {
        throw new Error(`unexpected phase ${String(goal.phase)}`)
      }
      if (goal.maxGoalRounds !== 4) throw new Error(`maxGoalRounds=${String(goal.maxGoalRounds)}`)
      const paused = await client.callTool('session_goal', { sessionId, action: 'pause' })
      if (paused.goal?.phase !== 'paused') throw new Error(`pause reported ${JSON.stringify(paused.goal)}`)
      const resumed = await client.callTool('session_goal', { sessionId, action: 'resume' })
      if (resumed.goal?.phase !== 'active') throw new Error(`resume reported ${JSON.stringify(resumed.goal)}`)
      const completed = await client.callTool('session_goal', { sessionId, action: 'complete' })
      if (completed.goal?.phase !== 'complete') {
        throw new Error(`complete reported ${JSON.stringify(completed.goal)}`)
      }
      const cleared = await client.callTool('session_goal', { sessionId, action: 'clear' })
      if (cleared.goal !== null) throw new Error(`clear reported ${JSON.stringify(cleared.goal)}`)
      const after = await client.callTool('session_goal', { sessionId, action: 'get' })
      if (after.goal !== null) throw new Error(`the goal survived clear: ${JSON.stringify(after.goal)}`)
      return `phase mirrors the harness store; revision ${String(goal.revision)}`
    })

    await runner.check('session_goal edit rewrites the objective and the round cap', async () => {
      const made = await client.callTool('session_goal', {
        sessionId,
        action: 'create',
        objective: 'first objective',
        maxGoalRounds: 2,
      })
      const edited = await client.callTool('session_goal', {
        sessionId,
        action: 'edit',
        objective: 'second objective',
        maxGoalRounds: 6,
      })
      if (edited.goal?.objective !== 'second objective') {
        throw new Error(`edit reported ${JSON.stringify(edited.goal)}`)
      }
      if (edited.goal.maxGoalRounds !== 6) throw new Error(`maxGoalRounds=${String(edited.goal.maxGoalRounds)}`)
      // A stale revision must be refused, the same guard the UI conflict uses.
      const refusal = await client.expectToolError('session_goal', {
        sessionId,
        action: 'pause',
        expectedRevision: (made.goal?.revision ?? 0) - 1,
      })
      if (!/expected revision/.test(refusal)) {
        throw new Error(`stale revision was not refused with the guard message: ${refusal.slice(0, 160)}`)
      }
      return `edit + stale-revision refusal (was ${String(made.goal?.revision)}, now ${String(edited.goal?.revision)})`
    })

    await runner.check('a goal mutation is pushed on the projections feed to a modern client', async () => {
      // The feed collector publishes dsh://session/<id>/projections on goal/changed,
      // so a supervising client learns about the objective without polling.
      const projectionsUri = `dsh://session/${encodeURIComponent(sessionId)}/projections`
      const meta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'live-orchestration', version: '1' },
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'subscriptions/listen',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 900,
          method: 'subscriptions/listen',
          params: { notifications: { resourceSubscriptions: [projectionsUri] }, _meta: meta },
        }),
      })
      if (response.status !== 200) throw new Error(`listen answered ${response.status}`)
      const events = []
      let buffer = ''
      const decoder = new TextDecoder()
      const reader = response.body.getReader()
      const draining = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let boundary
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue
                try {
                  events.push(JSON.parse(line.slice(5).trim()))
                } catch {
                  // keep scanning
                }
              }
            }
          }
        } catch {
          // An aborted read closes the stream.
        }
      })()
      try {
        const acknowledged = await waitFor(
          () => events.some((event) => event?.method === 'notifications/subscriptions/acknowledged'),
          5_000,
        )
        if (!acknowledged) throw new Error('no subscriptions/acknowledged frame')
        await client.callTool('session_goal', {
          sessionId,
          action: 'edit',
          objective: 'pushed projection check',
        })
        const pushed = await waitFor(
          () => events.some((event) => (
            event?.method === 'notifications/resources/updated'
            && event?.params?.uri === projectionsUri
          )),
          8_000,
        )
        if (!pushed) throw new Error('no resources/updated for the projections feed after a goal change')
        return 'goal change → notifications/resources/updated on dsh://session/<id>/projections'
      } finally {
        await reader.cancel().catch(() => {})
        await draining.catch(() => {})
      }
    })
  } finally {
    if (sessionId !== undefined) {
      await client.callTool('session_archive', { sessionId }).catch(() => {})
    }
    if (options.keep !== true) {
      const resolved = resolve(scratch)
      if (resolved.startsWith(resolve(tmpdir()) + '/')) rmSync(resolved, { recursive: true, force: true })
    } else {
      console.log(`\nkept scratch ${scratch}`)
    }
    const failed = runner.summary()
    process.exitCode = failed === 0 ? 0 : 1
  }
}

/** Await a truthy result for at most `timeoutMs`. */
async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - startedAt > timeoutMs) return false
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
