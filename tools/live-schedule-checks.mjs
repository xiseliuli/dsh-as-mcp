#!/usr/bin/env node
/**
 * Live checks for Host scheduled automation.
 *
 * A schedule is the one surface here whose effect outlives the process: the harness
 * stores it, and delivers the prompt at each occurrence even with no MCP client
 * connected. A stub can prove the request building; only a real boot proves that the
 * Host accepts the timing forms this endpoint emits, that a stored task round-trips
 * through `list`/`view`, and that the lost-update guard is the Host's own check
 * rather than something this plugin fakes.
 *
 * The checks deliberately never let a task fire: every timing is far in the future
 * (or a long interval), and every task created here is deleted again.
 *
 *   node tools/live-schedule-checks.mjs --url http://127.0.0.1:PORT/mcp \
 *     --token-file /tmp/dsh-live-XXXX/dsh-as-mcp/token
 *
 * It also asserts the owned-scope boundary indirectly by checking that the endpoint
 * reports the schedule probe, so a profile that mounts the store is distinguishable
 * from one that does not.
 *
 * @module dsh-as-mcp/tools/live-schedule-checks
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The tool count this build registers. */
const TOOL_COUNT = 45
/** A one-shot far enough out that it cannot fire during the run. */
const SAFE_AFTER_SECONDS = 86_400

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

/** A tiny JSON-RPC client over one Streamable HTTP endpoint. */
function createClient(url, token) {
  let nextId = 1
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
  async function callTool(name, args) {
    const { payload } = await rpc('tools/call', { name, arguments: args })
    if (payload?.error !== undefined) {
      throw new Error(`${name}: ${payload.error.message ?? JSON.stringify(payload.error)}`)
    }
    if (payload?.result?.isError === true) {
      throw new Error(`${name}: ${payload.result.content?.[0]?.text ?? 'tool error'}`)
    }
    const text = payload?.result?.content?.[0]?.text
    if (text === undefined) throw new Error(`${name} returned no text content`)
    return JSON.parse(text)
  }
  return { rpc, callTool }
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
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-schedule-live-'))
  const created = []
  let sessionId

  console.log(`endpoint ${url}`)
  console.log(`scratch  ${scratch}\n`)

  try {
    await runner.check('dsh_info reports the schedule probe and the four tools as available', async () => {
      const info = await client.callTool('dsh_info', {})
      const services = info.harnessServices ?? {}
      if (services.schedule !== true) throw new Error(`harnessServices.schedule=${JSON.stringify(services.schedule)}`)
      const unavailable = (info.toolAvailability?.unavailable ?? []).map((entry) => entry.tool)
      for (const tool of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']) {
        if (unavailable.includes(tool)) throw new Error(`${tool} reported unavailable`)
      }
      return `probes include schedule; ${info.toolAvailability?.available} tools available`
    })

    await runner.check('tools/list advertises the four schedule tools', async () => {
      const { payload } = await client.rpc('tools/list', {})
      const names = (payload?.result?.tools ?? []).map((tool) => tool.name)
      if (names.length !== TOOL_COUNT) throw new Error(`expected ${TOOL_COUNT} tools, got ${names.length}`)
      for (const tool of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']) {
        if (!names.includes(tool)) throw new Error(`${tool} missing from tools/list`)
      }
      return `${names.length} tools`
    })

    const session = await client.callTool('session_create', { cwd: scratch })
    sessionId = session.sessionId
    console.log(`PASS  session_create creates a probe session — ${sessionId}`)

    await runner.check('schedule_create stores a one-shot task targeting an existing conversation', async () => {
      const reply = await client.callTool('schedule_create', {
        title: 'live one-shot check',
        prompt: 'this must never run during the verification',
        afterSeconds: SAFE_AFTER_SECONDS,
        target: 'session',
        sessionId,
      })
      const task = reply.task
      if (task === undefined) throw new Error('no task in the reply')
      created.push(task.id)
      if (task.kind !== 'after') throw new Error(`task kind=${String(task.kind)}, expected "after"`)
      if (task.status !== 'active') throw new Error(`task status=${String(task.status)}`)
      if (task.target?.kind !== 'session' || task.target?.sessionId !== sessionId) {
        throw new Error(`task target=${JSON.stringify(task.target)}`)
      }
      if (typeof task.scheduledAt !== 'string') throw new Error('task has no scheduledAt')
      return `${task.id} kind=${task.kind} status=${task.status} at ${task.scheduledAt}`
    })

    await runner.check('schedule_create stores a recurring task for a new conversation per delivery', async () => {
      const reply = await client.callTool('schedule_create', {
        title: 'live recurring check',
        prompt: 'this must never run during the verification',
        everySeconds: SAFE_AFTER_SECONDS,
        target: 'new',
        cwd: scratch,
      })
      const task = reply.task
      created.push(task.id)
      if (task.kind !== 'every') throw new Error(`task kind=${String(task.kind)}`)
      if (task.target?.kind !== 'new') throw new Error(`task target=${JSON.stringify(task.target)}`)
      return `${task.id} kind=${task.kind} target=new`
    })

    await runner.check('schedule_create accepts the two-line RRULE form the DSH UI writes', async () => {
      const reply = await client.callTool('schedule_create', {
        title: 'live rrule check',
        prompt: 'this must never run during the verification',
        rrule: 'DTSTART;TZID=Asia/Singapore:20990101T080000\nRRULE:FREQ=DAILY;COUNT=1',
        target: 'new_once',
        cwd: scratch,
      })
      const task = reply.task
      created.push(task.id)
      if (task.kind !== 'rrule') throw new Error(`task kind=${String(task.kind)}`)
      if (typeof task.rrule !== 'string' || !task.rrule.includes('RRULE:FREQ=DAILY')) {
        throw new Error(`task rrule=${String(task.rrule)}`)
      }
      return `${task.id} kind=${task.kind}`
    })

    await runner.check('schedule_list and schedule_view read the stored tasks back', async () => {
      const listed = await client.callTool('schedule_list', { active: true, limit: 50 })
      const ids = (listed.items ?? []).map((task) => task.id)
      for (const id of created) {
        if (!ids.includes(id)) throw new Error(`${id} missing from schedule_list (${listed.total} total)`)
      }
      const viewed = await client.callTool('schedule_view', { scheduleId: created[0] })
      if (viewed.found !== true) throw new Error(`schedule_view reported ${JSON.stringify(viewed)}`)
      if (viewed.task?.id !== created[0]) throw new Error(`schedule_view returned ${String(viewed.task?.id)}`)
      const missing = await client.callTool('schedule_view', { scheduleId: 'schedule-does-not-exist' })
      if (missing.found !== false) throw new Error(`a missing id answered ${JSON.stringify(missing)}`)
      return `${listed.total} active task(s); missing id answered found=false`
    })

    await runner.check('schedule_edit pauses, resumes and re-times a task', async () => {
      const id = created[0]
      const paused = await client.callTool('schedule_edit', { scheduleId: id, action: 'update', active: false })
      if (paused.updated !== true) throw new Error(`pause reported ${JSON.stringify(paused)}`)
      if (paused.task?.status !== 'paused') throw new Error(`status after pause=${String(paused.task?.status)}`)
      const resumed = await client.callTool('schedule_edit', { scheduleId: id, action: 'update', active: true })
      if (resumed.task?.status !== 'active') throw new Error(`status after resume=${String(resumed.task?.status)}`)
      const retimed = await client.callTool('schedule_edit', {
        scheduleId: id,
        action: 'update',
        title: 'live one-shot check (retimed)',
        everySeconds: SAFE_AFTER_SECONDS * 2,
      })
      if (retimed.task?.kind !== 'every') throw new Error(`kind after re-time=${String(retimed.task?.kind)}`)
      if (retimed.task?.title !== 'live one-shot check (retimed)') {
        throw new Error(`title after re-time=${String(retimed.task?.title)}`)
      }
      return `paused → active → ${retimed.task.kind}`
    })

    await runner.check('schedule_edit refuses a stale expectedUpdatedAt and changes nothing', async () => {
      const id = created[1]
      const before = await client.callTool('schedule_view', { scheduleId: id })
      if (before.task === undefined) throw new Error('the task disappeared before the conflict check')
      const titleBefore = before.task.title
      // A revision that cannot be the stored one: the harness answers a conflict
      // instead of overwriting, the same guard the UI shows as a conflict.
      const refusal = await client.callTool('schedule_edit', {
        scheduleId: id,
        action: 'update',
        title: 'must not be applied',
        expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      })
      if (refusal.conflict !== true) throw new Error(`stale revision answered ${JSON.stringify(refusal)}`)
      const after = await client.callTool('schedule_view', { scheduleId: id })
      if (after.task?.title !== titleBefore) {
        throw new Error(`the refused update was applied anyway: ${String(after.task?.title)}`)
      }
      return `conflict: true, title stayed ${JSON.stringify(titleBefore)}`
    })

    await runner.check('schedule_edit deletes tasks and a repeat delete answers found: false', async () => {
      for (const id of created.splice(0)) {
        const deleted = await client.callTool('schedule_edit', { scheduleId: id, action: 'delete' })
        if (deleted.deleted !== true) throw new Error(`delete reported ${JSON.stringify(deleted)}`)
        const again = await client.callTool('schedule_edit', { scheduleId: id, action: 'delete' })
        if (again.found !== false) throw new Error(`a repeat delete answered ${JSON.stringify(again)}`)
        const view = await client.callTool('schedule_view', { scheduleId: id })
        if (view.found !== false) throw new Error(`${id} still exists after delete`)
      }
      return 'every created task is gone'
    })
  } finally {
    for (const id of created.splice(0)) {
      await client.callTool('schedule_edit', { scheduleId: id, action: 'delete' }).catch(() => {})
    }
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

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
