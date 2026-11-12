#!/usr/bin/env node
/**
 * Live checks for the observability surface: live agents, the subagent tree and skills.
 *
 * All three read harness state a stub cannot prove: the live agent registry only holds
 * sessions that are currently in memory, the subagent topology comes from the sessions
 * the harness itself recorded, and the skill catalog is assembled from the profile's
 * project/user instruction files. The checks therefore distinguish "the call works and
 * answers honestly" from "the profile happens to have data":
 *
 * - `agent_list` must contain the session this script just created (it is live), and
 *   every row must carry a status and root flag;
 * - `subagent_tree` on a session with no children must answer an empty list (creating a
 *   real subagent would spend a model turn and credentials this boot has none of);
 * - `skill_list` must succeed and report `complete`; `skill_read` is exercised for one
 *   name when the catalog has one, and for an unknown name to prove the exact error.
 *
 *   node tools/live-observability-checks.mjs --url http://127.0.0.1:PORT/mcp \
 *     --token-file /tmp/dsh-live-XXXX/dsh-as-mcp/token
 *
 * @module dsh-as-mcp/tools/live-observability-checks
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The tool count this build registers. */
const TOOL_COUNT = 54

/** Parse `--flag value` arguments and reject unknown ones. */
function parseArgs(argv) {
  const options = { keep: false }
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
    if (payload?.error !== undefined) throw new Error(`${name}: ${payload.error.message ?? JSON.stringify(payload.error)}`)
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
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-observability-live-'))
  let sessionId

  console.log(`endpoint ${url}`)
  console.log(`scratch  ${scratch}\n`)

  try {
    await runner.check('dsh_info reports the subagent and skill probes', async () => {
      const info = await client.callTool('dsh_info', {})
      const services = info.harnessServices ?? {}
      for (const probe of ['subagents', 'skills', 'agents']) {
        if (services[probe] !== true) throw new Error(`harnessServices.${probe}=${JSON.stringify(services[probe])}`)
      }
      const unavailable = (info.toolAvailability?.unavailable ?? []).map((entry) => entry.tool)
      for (const tool of ['agent_list', 'subagent_tree', 'skill_list', 'skill_read']) {
        if (unavailable.includes(tool)) throw new Error(`${tool} reported unavailable`)
      }
      return `${info.toolAvailability?.available} tools available`
    })

    await runner.check('tools/list advertises the four observability tools', async () => {
      const { payload } = await client.rpc('tools/list', {})
      const names = (payload?.result?.tools ?? []).map((tool) => tool.name)
      if (names.length !== TOOL_COUNT) throw new Error(`expected ${TOOL_COUNT} tools, got ${names.length}`)
      for (const tool of ['agent_list', 'subagent_tree', 'skill_list', 'skill_read']) {
        if (!names.includes(tool)) throw new Error(`${tool} missing from tools/list`)
      }
      return `${names.length} tools`
    })

    const created = await client.callTool('session_create', { cwd: scratch })
    sessionId = created.sessionId
    console.log(`PASS  session_create creates a live session — ${sessionId}`)

    await runner.check('agent_list reports the live session with a status and root flag', async () => {
      const listed = await client.callTool('agent_list', {})
      if (typeof listed.count !== 'number') throw new Error('count is not a number')
      const row = (listed.agents ?? []).find((agent) => agent.sessionId === sessionId)
      if (row === undefined) {
        throw new Error(
          `the session created a moment ago is not live: ${JSON.stringify((listed.agents ?? []).map((agent) => agent.sessionId))}`,
        )
      }
      if (typeof row.status !== 'string') throw new Error(`status=${JSON.stringify(row.status)}`)
      if (typeof row.root !== 'boolean') throw new Error(`root=${JSON.stringify(row.root)}`)
      return `${listed.count} live agent(s); this session status=${row.status} root=${row.root}`
    })

    await runner.check('subagent_tree answers an empty child list for a fresh session', async () => {
      const tree = await client.callTool('subagent_tree', { sessionId })
      if (tree.sessionId !== sessionId) throw new Error(`sessionId=${String(tree.sessionId)}`)
      if (!Array.isArray(tree.children)) throw new Error('children is not an array')
      if (tree.children.length !== 0) {
        throw new Error(`a fresh session reported children: ${JSON.stringify(tree.children)}`)
      }
      const deep = await client.callTool('subagent_tree', { sessionId, includeDescendants: true })
      if (!Array.isArray(deep.descendants)) throw new Error('descendants is not an array when asked for')
      if (deep.descendants.length !== 0) throw new Error('a fresh session reported descendants')
      return 'children=[] and descendants=[]'
    })

    let firstSkillName
    await runner.check('skill_list reports the instance catalog and its completeness', async () => {
      // With a live session the catalog comes from that session's agent preset, which
      // is where the shipped presets' bundled skills live.
      const listed = await client.callTool('skill_list', { sessionId })
      if (!Array.isArray(listed.skills)) throw new Error('skills is not an array')
      if (typeof listed.complete !== 'boolean') throw new Error('complete is not a boolean')
      firstSkillName = listed.skills[0]?.name
      return `${listed.skills.length} skill(s) via the session preset, complete=${listed.complete}`
    })

    await runner.check('skill_read returns the body of a listed skill, bounded', async () => {
      if (firstSkillName === undefined) {
        // An empty catalog is a legitimate profile; the read path is covered by the
        // unknown-name check below and by unit tests.
        return 'catalog is empty on this profile; nothing to read'
      }
      const read = await client.callTool('skill_read', { sessionId, name: firstSkillName, maxChars: 64 })
      if (read.name !== firstSkillName) throw new Error(`name=${String(read.name)}`)
      if (read.skill === undefined) throw new Error('no skill body in the reply')
      const body = read.skill.content ?? ''
      if (body.length > 64) throw new Error(`body is ${body.length} chars, above the 64-char cap`)
      if (typeof read.skill.description !== 'string') throw new Error('description missing')
      return `${firstSkillName}: ${body.length} char(s)${read.textTruncated === true ? ' (truncated)' : ''}`
    })

    await runner.check('skill_read refuses an unknown name with the exact-name hint', async () => {
      let message = ''
      try {
        await client.callTool('skill_read', { name: 'dsh-as-mcp-no-such-skill' })
      } catch (error) {
        message = String(error.message)
      }
      if (!/no skill named "dsh-as-mcp-no-such-skill"/.test(message)) {
        throw new Error(`unexpected refusal: ${message.slice(0, 160)}`)
      }
      if (!/skill_list/.test(message)) throw new Error('the refusal does not point at skill_list')
      return 'unknown skill refused with the hint'
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

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
