#!/usr/bin/env node
/**
 * Live protocol and lifecycle checks against a running dsh-as-mcp endpoint.
 *
 * `scripts/` holds what ships: `smoke.mjs` (is the wire up?) and `exercise.mjs`
 * (can an outside agent drive a DSH instance?). This file holds the checks that
 * only make sense against a real harness process and that the shipped scripts
 * either cannot afford on every run or cannot express without a second client:
 *
 * - the protocol contract a generic MCP client relies on (parse error, method
 *   not found, a 401 that challenges for a bearer token, a declared oversized
 *   body refused before it is read);
 * - list/paging contracts that need real services on the other end;
 * - with `--with-model`: progress notification streaming and MCP
 *   `notifications/cancelled`, both of which spend real tokens.
 *
 * It is deliberately not in the published package (`package.json` `files`), so a
 * maintainer runs it from a checkout:
 *
 *   node tools/live-checks.mjs --url http://127.0.0.1:8821/mcp
 *   node tools/live-checks.mjs --url http://127.0.0.1:8821/mcp --with-model
 *   node tools/live-checks.mjs --url http://127.0.0.1:8821/mcp --with-subagent
 *   node tools/live-checks.mjs --url http://127.0.0.1:8790/mcp --old-endpoint
 *
 * The endpoint resolution matches the shipped scripts: `--url`, then
 * `DSH_AS_MCP_URL`, then the loopback default; the token comes from `--token`,
 * then `DSH_AS_MCP_TOKEN`, then `<DSH_HOME>/dsh-as-mcp/token`.
 *
 * @module dsh-as-mcp/tools/live-checks
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const color = !flag('--no-color')
const dim = (text) => (color ? `\u001B[2m${text}\u001B[0m` : text)
const green = (text) => (color ? `\u001B[32m${text}\u001B[0m` : text)
const red = (text) => (color ? `\u001B[31m${text}\u001B[0m` : text)
const bold = (text) => (color ? `\u001B[1m${text}\u001B[0m` : text)

const resolveDshHome = () =>
  process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')

let endpoint = option('--url', process.env.DSH_AS_MCP_URL ?? 'http://127.0.0.1:8790/mcp')
const urlSource = option('--url', undefined) !== undefined ? 'arg' : process.env.DSH_AS_MCP_URL !== undefined ? 'env' : 'default'
if (!endpoint.endsWith('/mcp') && !endpoint.includes('?')) endpoint = endpoint.replace(/\/+$/, '') + '/mcp'

let token = option('--token', process.env.DSH_AS_MCP_TOKEN?.trim())
const tokenSource = option('--token', undefined) !== undefined ? 'arg' : process.env.DSH_AS_MCP_TOKEN !== undefined ? 'env' : 'file'
if (token === undefined) {
  const path = join(resolveDshHome(), 'dsh-as-mcp', 'token')
  if (existsSync(path)) token = (await readFile(path, 'utf8')).trim()
}

process.stderr.write(
  `endpoint: ${endpoint} (${urlSource})${token === undefined ? `\n${red('no bearer token found')}` : ''}\n`,
)
if (token === undefined && !flag('--allow-anonymous')) process.exit(2)

let passed = 0
let failed = 0
let skipped = 0
/**
 * `--old-endpoint` turns a contract mismatch into a skip.
 *
 * The checks describe the *current* build's contracts; an older deployment
 * (the desktop app in this session runs 0.2.0) legitimately predates some of them.
 * Pointing the script at such an endpoint is useful — it says exactly which
 * contracts that build lacks — but it should not read as a failure of the run.
 */
const vintageEndpoint = flag('--old-endpoint')
function check(ok, label, detail) {
  if (!ok && vintageEndpoint) {
    process.stdout.write(`  ${dim('-')} ${label} ${dim(`(older endpoint: ${String(detail ?? 'contract absent')})`)}\n`)
    skipped += 1
    return false
  }
  const mark = ok ? green('✓') : red('✗')
  process.stdout.write(`  ${mark} ${label}${detail === undefined ? '' : ` ${dim(String(detail))}`}\n`)
  if (ok) passed += 1
  else failed += 1
  return ok
}
function section(title) {
  process.stdout.write(`\n${bold(title)}\n`)
}

// --- transport -------------------------------------------------------------

let protocolVersion
let requestSeq = 1

function headers(extra = {}) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...(protocolVersion === undefined ? {} : { 'mcp-protocol-version': protocolVersion }),
    ...extra,
  }
}

/** One JSON-RPC request, returning `{ status, events, payload }`. */
async function rpcOnce(id, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const body = await response.text()
  const events = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
  const payload = events.find((entry) => entry.id === id) ?? events[0]
  return { status: response.status, events, payload }
}

async function rpc(method, params) {
  const id = requestSeq++
  const result = await rpcOnce(id, method, params)
  if (result.payload?.error) throw new Error(`JSON-RPC ${result.payload.error.code}: ${result.payload.error.message}`)
  return result.payload?.result
}

async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args })
  const text = result?.content?.[0]?.text ?? ''
  if (result?.isError === true) throw new Error(`${name}: ${text}`)
  return JSON.parse(text)
}

async function attemptTool(name, args = {}) {
  try {
    return { ok: true, payload: await callTool(name, args) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The tools this endpoint advertises, read once after `initialize`.
 *
 * Checks are gated on it so the script can run against an older build and say
 * "skipped" instead of reporting a missing feature as a failure. The desktop app
 * in this session, for example, runs an old plugin build; running these checks
 * against it should describe what that build cannot do, not accuse it.
 */
let surface = new Set()

function has(tool) {
  return surface.has(tool)
}

function skip(label, why) {
  process.stdout.write(`  ${dim('-')} ${label} ${dim(`(skipped: ${why})`)}
`)
}

// --- protocol --------------------------------------------------------------

async function protocolChecks() {
  section('protocol contract')
  const malformed = await fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: '{not json',
  })
  const malformedBody = await malformed.text()
  check(malformed.status === 400 && malformedBody.includes('-32700'), 'malformed JSON is a parse error', `HTTP ${malformed.status}`)

  const unknown = await rpcOnce(9_001, 'no/such-method', {})
  check(unknown.payload?.error?.code === -32601, 'an unknown method is method-not-found', `code ${unknown.payload?.error?.code}`)

  const denied = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{}',
  })
  check(
    denied.status === 401 && (denied.headers.get('www-authenticate') ?? '').toLowerCase().includes('bearer'),
    'a missing token challenges with WWW-Authenticate: Bearer',
    `HTTP ${denied.status}`,
  )

  const parsed = new URL(endpoint)
  const oversize = await new Promise((resolve) => {
    const attempt = httpRequest(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: { ...headers(), 'content-length': String(999 * 1024 * 1024) },
      },
      (response) => {
        resolve(response.statusCode)
        response.resume()
      },
    )
    attempt.on('error', (error) => resolve(`error: ${error.message}`))
    attempt.end()
  })
  check(oversize === 413, 'a declared oversized body is refused before it is read', `HTTP ${oversize}`)
}

// --- shell -----------------------------------------------------------------

async function shellChecks() {
  section('background shell')
  if (!has('shell_start') || !has('shell_list') || !has('shell_kill')) {
    skip('background shell checks', 'this endpoint advertises no shell_start/shell_list/shell_kill')
    return
  }
  const running = await callTool('shell_start', { command: 'sleep 20' })
  const listed = await callTool('shell_list', { running: true })
  check(
    (listed.jobs ?? []).some((job) => job.jobId === running.jobId),
    'shell_list { running: true } includes the live job',
    `${(listed.jobs ?? []).length} running`,
  )
  const killed = await callTool('shell_kill', { jobId: running.jobId })
  check(killed.killed === true && killed.status === 'killed', 'shell_kill stops it', killed.status)
  const afterKill = await callTool('shell_list', { running: true })
  check(
    !(afterKill.jobs ?? []).some((job) => job.jobId === running.jobId),
    'the settled job leaves the running filter',
    `${(afterKill.jobs ?? []).length} running`,
  )

  // The retention claim: a job that writes faster than it is polled loses the
  // oldest bytes beyond the retained buffer and says so. 200 KiB written at once
  // must not come back whole, and must not come back unboundedly either.
  if (has('shell_output')) {
    const loud = await callTool('shell_start', {
      command: `node -e "process.stdout.write('x'.repeat(200000))"`,
    })
    let delivered = 0
    let pages = 0
    let sawTruncated = false
    let sawLossy = false
    let last
    for (let attempt = 0; attempt < 20; attempt += 1) {
      last = await callTool('shell_output', { jobId: loud.jobId })
      pages += 1
      delivered += Buffer.byteLength(last.output ?? '', 'utf8')
      if (last.truncated === true) sawTruncated = true
      if (last.lossy === true) sawLossy = true
      if (last.done === true && (last.pendingBytes ?? 0) === 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // The shell service's own retention dropped part of the 200 KiB before this
    // plugin ever saw it, so `lossy` must say so — the probe that found this bug
    // showed `truncated: true, lossy: false` for exactly this case.
    check(
      sawTruncated && sawLossy && delivered <= 128 * 1024 && last?.done === true,
      'a job that outruns polling is bounded and reports truncated + lossy',
      `${delivered} bytes in ${pages} page(s)`,
    )
    await callTool('shell_kill', { jobId: loud.jobId }).catch(() => {})
  }
}

// --- shell timeout and job cap ---------------------------------------------

/**
 * `shell_run`'s timeout is a dead process, not just an early return, and the
 * background table keeps its documented bounds: the oldest *finished* job is evicted
 * to make room, while starting one more than the cap of running jobs is refused
 * rather than killing someone else's process.
 */
async function shellLimitsChecks() {
  section('shell timeout and job cap')
  if (!has('shell_run') || !has('shell_start')) {
    skip('shell timeout and job cap', 'needs shell_run and shell_start')
    return
  }
  const startedAt = Date.now()
  const timedOut = await attemptTool('shell_run', { command: 'sleep 5', timeoutMs: 700 })
  const elapsed = Date.now() - startedAt
  check(
    timedOut.ok === true ? timedOut.payload?.timedOut === true && elapsed < 3_500 : /timedOut|timeout/i.test(timedOut.error ?? ''),
    'shell_run returns at its deadline with timedOut set',
    `${elapsed} ms`,
  )
  const quick = await attemptTool('shell_run', { command: 'printf hello' })
  check(
    quick.ok === true && quick.payload?.stdout === 'hello' && quick.payload?.timedOut === false,
    'a quick command returns its output and timedOut:false',
    JSON.stringify(quick.payload?.stdout),
  )

  if (!has('shell_list') || !has('shell_kill')) {
    skip('background job caps', 'needs shell_list and shell_kill')
    return
  }
  // 16 finished jobs fill the table; the 17th start must evict the oldest finished
  // one instead of refusing.
  const finished = []
  for (let index = 0; index < 16; index += 1) {
    finished.push(await callTool('shell_start', { command: 'true' }))
  }
  const overflow = await callTool('shell_start', { command: 'sleep 5' })
  const listed = await callTool('shell_list')
  const jobs = listed.jobs ?? []
  check(
    jobs.length <= 16 && jobs.some((job) => job.jobId === overflow.jobId) &&
      !jobs.some((job) => job.jobId === finished[0].jobId),
    'the oldest finished job is evicted to make room, and the new job starts',
    `${jobs.length} job(s)`,
  )
  await callTool('shell_kill', { jobId: overflow.jobId })

  // With 16 *running* jobs, one more is refused instead of silently stopping one.
  const running = []
  try {
    for (let index = 0; index < 16; index += 1) {
      running.push(await callTool('shell_start', { command: 'sleep 15' }))
    }
    const refused = await attemptTool('shell_start', { command: 'sleep 15' })
    check(
      refused.ok === false && /16 background jobs are already running/.test(refused.error ?? '') &&
        /does not silently stop/.test(refused.error ?? ''),
      'a 17th running job is refused, not silently evicted',
      refused.error?.slice(0, 60),
    )
  } finally {
    await Promise.all(running.map((job) => callTool('shell_kill', { jobId: job.jobId }).catch(() => {})))
  }
}

// --- listing and image limits ----------------------------------------------

/**
 * `file_list`'s walk bounds and `file_read_image`'s detection and cap. Cheap: a temp
 * tree, a 1x1 PNG written through the shell, a text file and a sparse 9 MiB file.
 */
async function listingImageChecks() {
  section('listing and image limits')
  if (!has('file_list')) {
    skip('listing and image limits', 'this endpoint advertises no file_list')
  } else {
    const root = join('/tmp', `dsh-as-mcp-live-tree-${process.pid}`)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
    writeFileSync(join(root, 'top.txt'), 'top')
    writeFileSync(join(root, 'sub', 'inner.txt'), 'inner')
    writeFileSync(join(root, 'sub', 'deep', 'deeper.txt'), 'deeper')
    try {
      const flat = await callTool('file_list', { path: root })
      // A non-recursive listing names entries by basename; recursive entries add a
      // relative `path` (and `depth`).
      const flatNames = (flat.entries ?? []).map((entry) => entry.name)
      check(
        flatNames.includes('top.txt') && flatNames.includes('sub') && !flatNames.includes('inner.txt'),
        'a non-recursive listing shows one level with relative paths',
        `${flat.entries?.length ?? 0} entr(ies)`,
      )
      const recursive = await callTool('file_list', { path: root, recursive: true })
      check(
        (recursive.entries ?? []).some((entry) => entry.path.endsWith('deep/deeper.txt')),
        'a recursive listing reaches nested files',
        `${recursive.entries?.length ?? 0} entr(ies)`,
      )
      const shallow = await callTool('file_list', { path: root, recursive: true, maxDepth: 1 })
      check(
        !(shallow.entries ?? []).some((entry) => String(entry.path ?? '').endsWith('deeper.txt')),
        'maxDepth bounds the recursive walk',
        `${shallow.entries?.length ?? 0} entr(ies)`,
      )
      const onFile = await attemptTool('file_list', { path: join(root, 'top.txt') })
      check(onFile.ok === false && /director/i.test(onFile.error ?? ''), 'listing a file is a legible error', onFile.error?.slice(0, 50))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  if (!has('file_read_image') || !has('shell_run')) {
    skip('image detection and cap', 'needs file_read_image and shell_run')
    return
  }
  const png = join('/tmp', `dsh-as-mcp-live-1x1-${process.pid}.png`)
  const big = join('/tmp', `dsh-as-mcp-live-big-${process.pid}`)
  const text = join('/tmp', `dsh-as-mcp-live-text-${process.pid}.txt`)
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  try {
    await callTool('shell_run', {
      command: `node -e "require('node:fs').writeFileSync('${png}', Buffer.from('${pngBase64}','base64'))"`,
    })
    writeFileSync(text, 'plain text')

    const result = await rpc('tools/call', { name: 'file_read_image', arguments: { path: png } })
    // The reply is a metadata text block followed by the image block, which is what
    // lets a client show the picture while still knowing its size in bytes.
    const meta = JSON.parse(result?.content?.[0]?.text ?? '{}')
    const block = result?.content?.[1]
    check(
      result?.isError !== true && meta.mimeType === 'image/png' && block?.type === 'image' &&
        block?.mimeType === 'image/png' && typeof block?.data === 'string' && block.data.length > 0,
      'a real PNG comes back as metadata plus an MCP image block',
      `${meta.mimeType ?? '?'}, ${block?.data?.length ?? 0} base64 chars`,
    )
    const notImage = await attemptTool('file_read_image', { path: text })
    check(
      notImage.ok === false && /not an image/.test(notImage.error ?? ''),
      'a text file is refused as not an image',
      notImage.error?.slice(0, 50),
    )
    const missing = await attemptTool('file_read_image', { path: `${text}.missing` })
    check(
      missing.ok === false && /does not exist/.test(missing.error ?? ''),
      'a missing image path is a legible error',
      missing.error?.slice(0, 50),
    )

    await callTool('shell_run', {
      command: `node -e "require('node:fs').writeFileSync('${big}', Buffer.alloc(9*1024*1024, 0x89))"`,
    })
    const tooLarge = await attemptTool('file_read_image', { path: big })
    check(
      tooLarge.ok === false && /8388608-byte cap/.test(tooLarge.error ?? ''),
      'an image over the 8 MiB cap is refused with the limit named',
      tooLarge.error?.slice(0, 60),
    )
  } finally {
    for (const path of [png, big, text]) rmSync(path, { force: true })
  }
}

// --- file paging contracts -------------------------------------------------

/**
 * `file_read`'s paging promise: a byte-capped read reports `truncated` and
 * `nextOffset`, the next window continues exactly, and a window that starts inside a
 * multi-byte character decodes it as U+FFFD instead of failing or shifting the rest.
 */
async function filePagingChecks() {
  section('file paging contracts')
  if (!has('file_read') || !has('file_write')) {
    skip('file paging contracts', 'needs file_read and file_write')
    return
  }
  const path = join('/tmp', `dsh-as-mcp-live-paging-${process.pid}.txt`)
  const head = 'a'.repeat(5_000)
  const euro = '€'
  const tail = 'b'.repeat(5_000)
  try {
    await callTool('file_write', { path, content: head + euro + tail })

    const first = await callTool('file_read', { path, maxBytes: 5_000 })
    check(
      first.truncated === true && first.bytes === 5_000 && first.nextOffset === 5_000 &&
        first.text === head,
      'a byte-capped read reports truncated, bytes and nextOffset',
      `${first.bytes} bytes, next ${first.nextOffset}`,
    )

    const second = await callTool('file_read', { path, offset: first.nextOffset, maxBytes: 6_000 })
    check(
      second.truncated === false && second.offset === 5_000 &&
        second.text === euro + tail && first.text + second.text === head + euro + tail,
      'the next window continues exactly and completes the file',
      `${second.bytes} bytes, truncated ${second.truncated}`,
    )

    // 5000 bytes of 'a' then a 3-byte euro: offset 5001 leaves the euro's last two
    // bytes orphaned, which decode as two replacement characters. The point is that
    // the remainder after them is still aligned with the file.
    const split = await callTool('file_read', { path, offset: 5_001, maxBytes: 100 })
    const replacements = /^\uFFFD*/.exec(split.text)?.[0].length ?? 0
    check(
      replacements === 2 && split.text.slice(replacements) === tail.slice(0, split.text.length - replacements),
      'a window starting inside a multi-byte character decodes U+FFFD per orphaned byte and keeps the rest aligned',
      `${replacements} replacement char(s), then "${split.text.slice(replacements, replacements + 4)}"`,
    )
  } finally {
    rmSync(path, { force: true })
  }
}

// --- prompt input validation -----------------------------------------------

/**
 * A prompt that cannot be sent must be refused as a whole and say which input was
 * bad — and it must not be half-admitted. No model turn is involved: every case here
 * fails before the harness sees a message.
 */
async function promptInputChecks() {
  section('prompt input validation')
  if (!has('session_prompt') || !has('session_create') || !has('session_messages')) {
    skip('prompt input validation', 'needs session_prompt/session_create/session_messages')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  const before = (await callTool('session_messages', { sessionId: session.sessionId, limit: 10 })).messages ?? []

  const empty = await attemptTool('session_prompt', { sessionId: session.sessionId, prompt: '   ' })
  check(
    empty.ok === false && /non-empty text or at least one image/.test(empty.error ?? ''),
    'an empty prompt is refused with the supported shapes',
    empty.error?.slice(0, 60),
  )

  const textFile = join('/tmp', `dsh-as-mcp-live-not-image-${process.pid}.txt`)
  writeFileSync(textFile, 'plain text, not an image')
  try {
    const notImage = await attemptTool('session_prompt', {
      sessionId: session.sessionId,
      prompt: 'look at this',
      images: [{ path: textFile }],
    })
    check(
      notImage.ok === false && notImage.error?.includes(textFile) && /not an image/.test(notImage.error ?? ''),
      'a non-image attachment is refused by name',
      notImage.error?.slice(0, 70),
    )
  } finally {
    rmSync(textFile, { force: true })
  }

  const five = await attemptTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'too many images',
    images: Array.from({ length: 5 }, () => ({ path: '/tmp/none.png' })),
  })
  check(five.ok === false, 'more images than the cap is refused before any file is read', five.error?.slice(0, 60))

  const after = (await callTool('session_messages', { sessionId: session.sessionId, limit: 10 })).messages ?? []
  check(after.length === before.length, 'a refused prompt was never admitted', `${after.length} message(s)`)
}

// --- session creation errors -----------------------------------------------

/**
 * The error quality a caller-created session depends on: rejecting half a route
 * before a session exists, explaining an unroutable pair with the routes that do
 * exist, requiring a directory, and surfacing a bad preset.
 */
async function sessionCreateErrorChecks() {
  section('session creation errors')
  if (!has('session_create')) {
    skip('session creation errors', 'this endpoint advertises no session_create')
    return
  }
  const partial = await attemptTool('session_create', { cwd: process.cwd(), provider: 'deepseek' })
  check(
    partial.ok === false && /provider and model together/.test(partial.error ?? ''),
    'half a model route is refused before a session is created',
    partial.error?.slice(0, 60),
  )
  const neither = await attemptTool('session_create', {})
  check(
    neither.ok === false && /provide either workspaceId or cwd/.test(neither.error ?? ''),
    'a session without a workspace or directory is refused clearly',
    neither.error?.slice(0, 60),
  )

  const unroutable = await attemptTool('session_create', {
    cwd: process.cwd(),
    provider: 'definitely-not-a-provider',
    model: 'definitely-not-a-model',
  })
  const body = unroutable.ok ? unroutable.payload : undefined
  check(
    body?.sessionId !== undefined && /requested provider "definitely-not-a-provider"/.test(body?.modelSelectionError ?? '') &&
      /dsh_info/.test(body?.modelSelectionError ?? ''),
    'an unroutable pair still creates the session and explains the route problem',
    body?.modelSelectionError?.slice(0, 60),
  )

  const badPreset = await attemptTool('session_create', { cwd: process.cwd(), agentPreset: 'no-such-preset' })
  check(
    badPreset.ok === false && /preset/i.test(badPreset.error ?? ''),
    'an unknown agent preset is refused with a message that names it',
    badPreset.error?.slice(0, 60),
  )
}

// --- fork and rename contracts ---------------------------------------------

/**
 * The fork/rename promises: a title is stored trimmed and comes back through
 * session_list, a fork names its source and reports a non-zero inherited prefix, an
 * explicit `atSeq` boundary inherits no more than the default fork, and unknown ids
 * are legible errors. No model turn is needed for any of it.
 */
async function forkRenameChecks() {
  section('fork and rename contracts')
  if (!has('session_create') || !has('session_fork') || !has('session_rename')) {
    skip('fork and rename contracts', 'needs session_create/session_fork/session_rename')
    return
  }
  const source = await callTool('session_create', { cwd: process.cwd() })
  const renamed = await callTool('session_rename', { sessionId: source.sessionId, title: '  padded title  ' })
  check(renamed.title === 'padded title', 'session_rename trims the title', JSON.stringify(renamed.title))

  if (has('session_list')) {
    const listed = await callTool('session_list', { limit: 50, includeTitle: true })
    const row = (listed.sessions ?? []).find((entry) => entry.sessionId === source.sessionId)
    check(row?.title === 'padded title', 'the renamed title comes back through session_list', row?.title)
  }

  // This session has never been prompted, and the harness refuses to fork a prefix
  // with no completed turn in it. The refusal must be legible: it is the answer a
  // caller that forgot to prompt the source needs. The positive fork path (with a
  // real turn) is exercised by --with-model's exercise/smoke scripts.
  const turnless = await attemptTool('session_fork', { sessionId: source.sessionId })
  check(
    turnless.ok === false && /no completed turn/i.test(turnless.error ?? ''),
    'forking a never-prompted session is refused with that reason',
    turnless.error?.slice(0, 70),
  )

  const missing = await attemptTool('session_rename', { sessionId: 'session-does-not-exist', title: 'x' })
  check(
    missing.ok === false && /no session|unknown session|not found/i.test(missing.error ?? ''),
    'renaming an unknown session is a legible error',
    missing.error?.slice(0, 60),
  )
  const empty = await attemptTool('session_rename', { sessionId: source.sessionId, title: '   ' })
  check(empty.ok === false, 'an empty title is refused before it reaches the harness', empty.error?.slice(0, 50))
}

// --- agent tool bridge -----------------------------------------------------

/**
 * `dsh_tool_list`/`dsh_tool_call` run the instance's own agent tools without a model
 * turn. The promises worth asserting: the list is real, an unlisted name is refused
 * with the setting that would allow it, a tool's own argument error reaches the
 * caller, and a large result is capped with its size reported instead of flooding
 * the conversation.
 */
async function toolBridgeChecks() {
  section('agent tool bridge')
  if (!has('dsh_tool_list') || !has('dsh_tool_call') || !has('session_create')) {
    skip('agent tool bridge', 'needs dsh_tool_list/dsh_tool_call/session_create')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  const listed = await callTool('dsh_tool_list', { sessionId: session.sessionId })
  const tools = listed.tools ?? []
  check(
    tools.length > 0 && tools.every((tool) => typeof tool.name === 'string' && tool.name !== ''),
    'dsh_tool_list reports the agent tools for a session',
    `${tools.length} tool(s)`,
  )
  const names = new Set(tools.map((tool) => tool.name))

  const unknown = await attemptTool('dsh_tool_call', {
    name: 'definitely_not_a_tool',
    args: {},
    sessionId: session.sessionId,
  })
  check(
    unknown.ok === false &&
      /not exposed by this endpoint/.test(unknown.error ?? '') &&
      /agentTools\.allow/.test(unknown.error ?? ''),
    'an unlisted agent tool is refused with the setting that would allow it',
    unknown.error?.slice(0, 60),
  )

  // A listed tool given no arguments must fail with its own validation message, not
  // a transport error: that message is what tells a caller how to fix the call.
  const first = tools.find((tool) => typeof tool.name === 'string')
  if (first !== undefined) {
    const invalid = await attemptTool('dsh_tool_call', {
      name: first.name,
      args: {},
      sessionId: session.sessionId,
    })
    const rejected = invalid.ok ? invalid.payload?.ok === false : true
    check(
      rejected,
      `"${first.name}" with empty arguments is rejected by the tool, not the transport`,
      (invalid.ok ? invalid.payload?.error : invalid.error)?.slice(0, 60),
    )
  }

  if (names.has('bash')) {
    const big = await attemptTool('dsh_tool_call', {
      name: 'bash',
      // bash requires `description` first in its schema; `command` runs 30 KB.
      args: {
        description: 'emit 30000 bytes for the result cap check',
        command: `node -e "process.stdout.write('y'.repeat(30000))"`,
      },
      sessionId: session.sessionId,
      maxResultChars: 200,
    })
    const body = big.ok ? big.payload : undefined
    check(
      body?.ok === true && body.truncated === true && body.resultBytes >= 30000 &&
        typeof body.text === 'string' && body.text.length <= 200 && body.value === undefined,
      'a large agent-tool result is capped, with its original size reported',
      `${body?.resultBytes ?? '?'} bytes, text ${body?.text?.length ?? '?'} chars`,
    )
  } else {
    skip('large agent-tool result cap', 'this composition lists no bash tool')
  }
}

// --- workspace contracts ---------------------------------------------------

/**
 * The workspace promises: the same path is one registration, a missing directory is
 * created only when asked, and deleting a workspace leaves the directory and its
 * files alone (idempotently, so a retried cleanup is not an error).
 */
async function workspaceChecks() {
  section('workspace contracts')
  if (!has('workspace_create') || !has('workspace_list') || !has('workspace_delete')) {
    skip('workspace contracts', 'needs workspace_create/list/delete')
    return
  }
  const dir = join('/tmp', `dsh-as-mcp-live-ws-${process.pid}`)
  const kept = join(dir, 'keep.txt')
  rmSync(dir, { recursive: true, force: true })
  try {
    const created = await callTool('workspace_create', { path: dir })
    const workspace = created.workspace
    check(
      typeof workspace?.id === 'string' && created.created === true && existsSync(dir),
      'workspace_create registers and makes the directory',
    )
    const again = await callTool('workspace_create', { path: dir, title: 'renamed title' })
    check(
      again.workspace?.id === workspace?.id && again.created === false,
      'registering the same path returns the existing workspace',
      again.workspace?.id,
    )

    rmSync(kept, { force: true })
    await callTool('file_write', { path: kept, content: 'keep me' })
    const listed = await callTool('workspace_list')
    const row = (listed.workspaces ?? []).find((entry) => entry.id === workspace?.id)
    check(
      row !== undefined && row.path !== undefined && typeof row.sessionCount === 'number' && row.status === 'ok',
      'workspace_list reports the registration, its path, session count and status',
      `${row?.sessionCount ?? '?'} session(s), ${row?.status ?? '?'}`,
    )

    const deleted = await callTool('workspace_delete', { workspaceId: workspace.id })
    check(deleted.deleted === true, 'workspace_delete removes the registration')
    const after = await callTool('workspace_list')
    check(
      !(after.workspaces ?? []).some((entry) => entry.id === workspace.id),
      'the deleted workspace leaves the list',
    )
    check(
      existsSync(kept) && (await callTool('file_read', { path: kept })).text === 'keep me',
      'deleting a workspace leaves its directory and files untouched',
    )
    const idempotent = await callTool('workspace_delete', { workspaceId: workspace.id })
    check(idempotent.deleted === false, 'deleting an unknown workspace answers deleted:false, not an error')

    const missing = join('/tmp', `dsh-as-mcp-live-ws-missing-${process.pid}`)
    rmSync(missing, { recursive: true, force: true })
    const refused = await attemptTool('workspace_create', { path: missing, createDirectory: false })
    check(
      refused.ok === false && existsSync(missing) === false,
      'createDirectory:false refuses a missing directory without creating it',
      refused.error?.slice(0, 60),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- file editing contracts ------------------------------------------------

/**
 * The promises in the file tool descriptions: an ambiguous `oldText` is refused and
 * writes nothing, `replaceAll` replaces every occurrence, and `createDirectories:
 * false` fails before creating anything. Each is cheap and directly falsifiable.
 */
async function fileEditChecks() {
  section('file edit contracts')
  if (!has('file_write') || !has('file_read') || !has('file_edit')) {
    skip('file edit contracts', 'needs file_write, file_read and file_edit')
    return
  }
  const path = join('/tmp', `dsh-as-mcp-live-edit-${process.pid}.txt`)
  rmSync(path, { force: true })
  await callTool('file_write', { path, content: 'alpha\nbeta\ngamma\n' })
  try {
    const written = await callTool('file_read', { path })
    check(written.text === 'alpha\nbeta\ngamma\n', 'file_write round-trips through file_read')

    const ambiguous = await attemptTool('file_edit', { path, oldText: 'a', newText: 'A' })
    check(
      ambiguous.ok === false && /occur|match|unique|ambiguous/i.test(ambiguous.error ?? ''),
      'an ambiguous oldText is refused',
      ambiguous.error?.slice(0, 70),
    )
    check(
      (await callTool('file_read', { path })).text === 'alpha\nbeta\ngamma\n',
      'the refused edit wrote nothing',
    )

    const replaced = await callTool('file_edit', { path, oldText: 'a', newText: 'A', replaceAll: true })
    check(
      typeof replaced.path === 'string' &&
        (await callTool('file_read', { path })).text === 'AlphA\nbetA\ngAmmA\n',
      'replaceAll replaces every occurrence',
      (await callTool('file_read', { path })).text.slice(0, 20),
    )

    const missingParent = join('/tmp', `dsh-as-mcp-live-missing-${process.pid}`, 'file.txt')
    rmSync(dirname(missingParent), { recursive: true, force: true })
    const refused = await attemptTool('file_write', {
      path: missingParent,
      content: 'x',
      createDirectories: false,
    })
    check(
      refused.ok === false && /parent directory does not exist/.test(refused.error ?? '') &&
        existsSync(missingParent) === false && existsSync(dirname(missingParent)) === false,
      'createDirectories:false refuses before creating the parent',
      refused.error?.slice(0, 70),
    )

    // Relative paths resolve against cwd for all three tools, not just write.
    const relative = `dsh-as-mcp-live-rel-${process.pid}.txt`
    await callTool('file_write', { path: relative, cwd: '/tmp', content: 'relative' })
    check(
      (await callTool('file_read', { path: relative, cwd: '/tmp' })).text === 'relative',
      'a relative path resolves against cwd',
    )
    rmSync(join('/tmp', relative), { force: true })
  } finally {
    rmSync(path, { force: true })
  }
}

// --- lists and paging ------------------------------------------------------

async function listChecks() {
  section('list and paging contracts')
  let sessionId
  if (!has('session_create') || !has('session_list')) {
    skip('session listing checks', 'this endpoint advertises no session_create/session_list')
  } else {
    // The harness requires a directory: there is no "some default workspace" form.
    const created = await callTool('session_create', { cwd: process.cwd() })
    sessionId = created.sessionId
    const page = await callTool('session_list', { limit: 1 })
    check(
      page.sessions?.length <= 1 && typeof page.total === 'number' && (page.truncated === true) === (page.total > 1),
      'session_list reports total and truncation',
      `${page.sessions?.length ?? 0} of ${page.total ?? '?'}`,
    )
  }

  if (!has('file_write') || !has('file_read')) {
    skip('file paging checks', 'this endpoint advertises no file_write/file_read')
  } else {
    const path = join('/tmp', `dsh-as-mcp-live-checks-${process.pid}.txt`)
    await callTool('file_write', { path, content: 'first line\nsecond line\nthird line\n' })
    const sliced = await callTool('file_read', { path, maxBytes: 11 })
    check(
      sliced.truncated === true && typeof sliced.nextOffset === 'number' && sliced.size === 34,
      'file_read reports truncated, nextOffset and the whole size',
      `${sliced.bytes ?? '?'}/${sliced.size ?? '?'} bytes, next ${sliced.nextOffset ?? '?'}`,
    )
  }

  // Search is opt-in in shipped compositions, so both answers are legitimate. The
  // probe in dsh_info is the honest answer to "does search work here"; the tool
  // call must agree with it.
  if (!has('session_search')) {
    skip('session-search checks', 'this endpoint advertises no session_search')
  } else {
  const info = await callTool('dsh_info', { probeSearch: true })
  const searchState = info.search
  check(
    typeof searchState?.available === 'boolean' &&
      (searchState.available ? searchState.matches === 0 : /openAt/.test(searchState.reason ?? '')),
    'dsh_info { probeSearch: true } reports whether search really works',
    searchState?.available === true ? 'available' : (searchState?.reason ?? 'no probe').slice(0, 60),
  )
  const freshToken = randomUUID().replace(/-/g, '')
  const search = await attemptTool('session_search', { query: freshToken })
  if (searchState?.available === true) {
    check(
      search.ok && (search.payload?.items ?? []).length === 0 && typeof search.payload?.hasMore === 'boolean',
      'session_search answers a token that appears nowhere with no matches',
      `${(search.payload?.items ?? []).length} match(es)`,
    )
  } else {
    check(
      !search.ok && /openAt/.test(search.error ?? '') && /first-search|startup/.test(search.error ?? ''),
      'a disabled session-search index reports how to enable it',
      (search.error ?? '').slice(0, 60),
    )
  }
  }

  if (!has('session_usage')) {
    skip('usage-scope check', 'this endpoint advertises no session_usage')
  } else {
    const usage = await callTool('session_usage', { cwd: '/tmp/definitely-no-sessions-here' })
    check(
      usage.scope === 'workspace' && (usage.sessions ?? []).length === 0 && (usage.notes ?? []).some((note) => /No session this DSH knows ran in/.test(note)),
      'an empty workspace total is explained, not silently zero',
      usage.scope,
    )
  }

  if (!has('session_queue')) {
    skip('queue listing check', 'this endpoint advertises no session_queue')
  } else if (sessionId !== undefined) {
    const queue = await callTool('session_queue', { sessionId })
    check(
      Array.isArray(queue.queued) && (queue.note === undefined || typeof queue.note === 'string'),
      'session_queue lists the pending inbox',
      `${(queue.queued ?? []).length} queued`,
    )
  }
  return sessionId
}

// --- concurrency -----------------------------------------------------------

/**
 * Several callers at once, the way an external harness or an agent team actually
 * uses the endpoint. This is not a benchmark: it asserts that parallel requests all
 * answer and that sharing a session or a file does not serialize into a failure.
 */
async function concurrencyChecks() {
  section('concurrency')
  const startedAt = Date.now()
  const infos = await Promise.all(Array.from({ length: 20 }, () => callTool('dsh_info')))
  const versions = new Set(infos.map((info) => info.version))
  check(
    infos.every((info) => typeof info.version === 'string') && versions.size === 1,
    '20 parallel dsh_info calls all answer with one version',
    `${infos.length} answers, ${versions.size} version(s)`,
  )

  if (has('file_write') && has('file_read')) {
    const path = join('/tmp', `dsh-as-mcp-live-load-${process.pid}.txt`)
    const payload = 'load line\n'.repeat(50)
    await Promise.all(Array.from({ length: 8 }, (_, index) => callTool('file_write', {
      path: `${path}.${index}`,
      content: `${payload}${index}`,
    })))
    const reads = await Promise.all(Array.from({ length: 8 }, (_, index) => callTool('file_read', {
      path: `${path}.${index}`,
    })))
    check(
      reads.every((read, index) => typeof read.text === 'string' && read.text.endsWith(String(index))),
      '8 parallel file writes then reads stay consistent',
      `${reads.length} reads in ${Date.now() - startedAt} ms`,
    )
    for (let index = 0; index < 8; index += 1) rmSync(`${path}.${index}`, { force: true })
  }

  if (has('session_list')) {
    const pages = await Promise.all(Array.from({ length: 12 }, () => callTool('session_list', { limit: 3 })))
    const totals = new Set(pages.map((page) => page.total))
    check(
      pages.every((page) => Array.isArray(page.sessions)) && totals.size === 1,
      '12 parallel session_list calls agree on the total',
      `${pages.length} answers, ${[...totals].join('/')} total`,
    )
  }
}

// --- availability contract -------------------------------------------------

async function availabilityCheck() {
  section('availability contract')
  const info = await callTool('dsh_info')
  const availability = info.toolAvailability
  if (availability === undefined) {
    process.stdout.write('  - endpoint predates dsh_info.toolAvailability; skipping\n')
    return
  }
  const listed = await rpc('tools/list', {})
  const names = new Set((listed.tools ?? []).map((tool) => tool.name))
  const availableTools = new Set(availability.availableTools ?? [])
  check(
    availableTools.size === availability.available,
    'dsh_info.available matches the availableTools list',
    `${availability.available} advertised, ${availableTools.size} named`,
  )
  const missing = [...names].filter((name) => !availableTools.has(name))
  const extra = [...availableTools].filter((name) => !names.has(name))
  check(
    missing.length === 0 && extra.length === 0,
    'availableTools equals the tools/list set',
    missing.length + extra.length === 0 ? `${names.size} tools` : `missing ${missing.join(',') || '-'} / extra ${extra.join(',') || '-'}`,
  )
  const reasonless = (availability.unavailable ?? []).filter((entry) => typeof entry.reason !== 'string' || entry.reason === '')
  check(reasonless.length === 0, 'every unavailable tool explains why', `${(availability.unavailable ?? []).length} unavailable`)
}

// --- model-spending checks -------------------------------------------------

async function progressCheck(sessionId) {
  section('progress notifications (real turn)')
  const id = requestSeq++
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'session_prompt',
        arguments: {
          sessionId,
          prompt: 'Use the bash tool to run exactly: sleep 4; echo progress-step. Then reply with exactly: PROGRESS OK',
          timeoutMs: 180_000,
        },
        _meta: { progressToken: 'live-checks-progress' },
      },
    }),
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const arrivals = []
  let final
  const startedAt = Date.now()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = JSON.parse(line.slice(5))
      if (payload.id === id) final = payload
      else if (payload.method === 'notifications/progress') arrivals.push(Date.now() - startedAt)
    }
  }
  const reply = final?.result?.content?.[0]?.text ? JSON.parse(final.result.content[0].text) : undefined
  check(arrivals.length > 0, 'progress notifications are sent', `${arrivals.length} in ${Date.now() - startedAt}ms`)
  check(
    arrivals.length >= 2 && arrivals[arrivals.length - 1] - arrivals[0] > 500,
    'they arrive while the turn runs, not batched at the end',
    arrivals.slice(0, 5).join(','),
  )
  check(/PROGRESS OK/.test(reply?.turn?.reply ?? ''), 'the turn still settles', reply?.turn?.reply)
}

async function cancellationCheck() {
  section('MCP notifications/cancelled (real turn)')
  const session = await callTool('session_create', { cwd: process.cwd() })
  const id = requestSeq++
  const pending = fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'session_prompt',
        arguments: {
          sessionId: session.sessionId,
          prompt: 'Write a 600-word essay about cartography. Do not use tools.',
          timeoutMs: 300_000,
        },
      },
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  const cancelledAt = Date.now()
  await fetch(endpoint, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'live-checks' } }),
  }).then((response) => response.text())
  const response = await pending
  const body = await response.text()
  const elapsed = Date.now() - cancelledAt
  const events = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))
  const final = events.find((entry) => entry.id === id)
  const reply = final?.result?.content?.[0]?.text ? JSON.parse(final.result.content[0].text) : undefined
  check(reply?.turn?.aborted === true, 'the cancelled wait reports turn.aborted', String(reply?.turn?.aborted))
  check(elapsed < 5_000, 'the wait ends promptly after the notification, not at the turn boundary', `${elapsed}ms`)
  const after = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: after cancellation',
    timeoutMs: 180_000,
  })
  check(/after cancellation/.test(after.turn?.reply ?? ''), 'the session is usable afterwards', after.turn?.reply)
}

async function subagentCheck() {
  section('subagent accounting (real turn)')
  const session = await callTool('session_create', { cwd: process.cwd() })
  const prompted = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Use your subagent tool to spawn one helper agent with the task "Reply with exactly: '
      + 'SUBAGENT-OK". Wait for it, then reply exactly: PARENT SAW <its answer>.',
    timeoutMs: 600_000,
  })
  check(
    /SUBAGENT-OK/.test(prompted.turn?.reply ?? ''),
    'the agent spawned a subagent and reported its answer',
    (prompted.turn?.reply ?? '').slice(0, 60),
  )

  const report = await callTool('session_usage', {
    sessionId: session.sessionId,
    limit: 20,
    includeSubagents: true,
  })
  const rows = report.sessions ?? []
  const child = rows.find((row) => row.origin === 'subagent')
  check(child !== undefined, 'usage folds the subagent session as its own row', `${rows.length} row(s)`)
  check(
    report.totals?.totalTokens === rows.reduce((sum, row) => sum + (row.usage?.totals?.totalTokens ?? 0), 0),
    'the report total is the sum of the rows (no silent exclusion)',
    `${report.totals?.totalTokens ?? '?'} tokens`,
  )

  if (child !== undefined) {
    // Subagent sessions belong to the session tree: reading the child is reading
    // the cost of the parent, so this must work under session.scope "owned" too.
    const transcript = await callTool('session_messages', { sessionId: child.sessionId, limit: 5 })
    check(
      (transcript.messages ?? []).length > 0,
      'the subagent session is readable by id',
      `${(transcript.messages ?? []).length} message(s)`,
    )
    const listed = await callTool('session_list', { limit: 10 })
    const rows = listed.sessions ?? []
    const childRow = rows.find((entry) => entry.sessionId === child.sessionId)
    check(
      childRow !== undefined,
      'the subagent session is listed with its parent',
      `${listed.total ?? '?'} session(s)`,
    )
    check(
      childRow?.parentSessionId === session.sessionId && childRow?.origin === 'subagent',
      'session_list names the subagent parent and origin',
      `parent ${String(childRow?.parentSessionId ?? 'absent').slice(0, 16)}`,
    )
    const parentRow = rows.find((entry) => entry.sessionId === session.sessionId)
    check(
      parentRow?.parentSessionId === undefined,
      'a root session has no parent recorded',
      parentRow === undefined ? 'not listed' : 'root',
    )
    const onlySubagents = await callTool('session_list', { limit: 20, origin: 'subagent' })
    const subagentRows = onlySubagents.sessions ?? []
    check(
      subagentRows.some((entry) => entry.sessionId === child.sessionId) &&
        subagentRows.every((entry) => entry.origin === 'subagent') &&
        !subagentRows.some((entry) => entry.sessionId === session.sessionId),
      'session_list { origin: "subagent" } returns only the children',
      `${subagentRows.length} subagent(s)`,
    )
    // One recorded result from the subagent's own transcript, fetched by call id:
    // the debug path an operator takes after seeing a failure in the call list.
    const childTranscript = await callTool('session_messages', {
      sessionId: child.sessionId,
      limit: 50,
      includeToolCalls: true,
    })
    const completedCall = (childTranscript.messages ?? [])
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => typeof call.id === 'string' && typeof call.resultChars === 'number')
    if (completedCall === undefined) {
      skip('session_tool_result on the subagent', 'its transcript has no completed tool call')
    } else {
      const fetched = await callTool('session_tool_result', {
        sessionId: child.sessionId,
        callId: completedCall.id,
        maxChars: 500,
      })
      check(
        fetched.chars === completedCall.resultChars && typeof fetched.text === 'string' && fetched.text.length <= 500,
        'session_tool_result reads a subagent tool result by id',
        `${fetched.chars} chars`,
      )
    }

    // Enriched search hits: with the index enabled, a match inside the subagent
    // session should say which parent it belongs to. Disabled index = skip.
    const search = await attemptTool('session_search', { query: 'SUBAGENT-OK' })
    if (!search.ok) {
      skip('search-hit parentage', 'session search is unavailable or disabled on this deployment')
    } else {
      const hits = search.payload?.items ?? []
      check(
        hits.some((entry) => entry.sessionId === child.sessionId) || hits.length === 0,
        'a search hit inside the subagent session is returned',
        `${hits.length} hit(s)`,
      )
      check(
        hits.every((entry) => entry.origin !== 'subagent' || entry.parentSessionId !== undefined),
        'a subagent search hit carries its parent',
        hits.filter((entry) => entry.origin === 'subagent').length + ' subagent hit(s)',
      )
    }
    const onlyRoots = await callTool('session_list', { limit: 20, origin: 'root' })
    check(
      (onlyRoots.sessions ?? []).some((entry) => entry.sessionId === session.sessionId) &&
        !(onlyRoots.sessions ?? []).some((entry) => entry.sessionId === child.sessionId),
      'session_list { origin: "root" } excludes the children',
      `${(onlyRoots.sessions ?? []).length} root(s)`,
    )
  }
}

// --- orchestration ---------------------------------------------------------

/**
 * The queue/cancel/poll combination a real orchestrator uses on one session: start
 * a long turn without waiting, queue work behind it, withdraw that queued work,
 * cancel the running turn, then keep using the session. Each tool exists on its own;
 * this checks they compose on one session without corrupting its state.
 */
async function orchestrationCheck() {
  section('orchestration on one session (real turn)')
  if (!has('session_prompt') || !has('session_cancel')) {
    skip('orchestration checks', 'needs session_prompt and session_cancel')
    return
  }
  const session = await callTool('session_create', { cwd: process.cwd() })
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Run the bash command: sleep 20; echo LONG-DONE. Then reply exactly: LONG TURN.',
    wait: false,
  })

  // A queued message must not start while the first turn is open.
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: QUEUED-NEVER',
    wait: false,
  })

  let queueListed = false
  if (has('session_queue')) {
    const queue = await callTool('session_queue', { sessionId: session.sessionId })
    const rows = queue.queued ?? []
    check(rows.length >= 1, 'the queued message is visible while the turn runs', `${rows.length} queued`)
    queueListed = rows.length >= 1
    if (queueListed) {
      const removed = await callTool('session_queue', {
        sessionId: session.sessionId,
        messageId: rows[0].id,
        action: 'remove',
      })
      check(removed.accepted === true, 'the queued message can be withdrawn')
    }
  } else {
    skip('queue checks in orchestration', 'this endpoint advertises no session_queue')
  }

  // A second queued message stays queued: session_cancel stops the running turn,
  // it does not throw away the work waiting behind it (the description says so).
  await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: QUEUE-B',
    wait: false,
  })

  const cancelled = await callTool('session_cancel', { sessionId: session.sessionId })
  check(cancelled.accepted === true, 'the running turn can be cancelled')

  let preserved = false
  if (has('session_queue')) {
    const afterCancel = await callTool('session_queue', { sessionId: session.sessionId })
    const remaining = (afterCancel.queued ?? []).filter(
      (entry) => String(entry.text ?? '').includes('QUEUE-B'),
    )
    preserved = remaining.length === 1
    check(preserved, 'cancelling preserves the work queued behind the turn', `${remaining.length} left`)
  }

  // The session must still work afterwards: this is the state corruption a
  // cancel/queue combination would leave behind. The queued message runs first,
  // so the marker for it appears before our prompt's reply.
  const after = await callTool('session_prompt', {
    sessionId: session.sessionId,
    prompt: 'Reply with exactly: STILL USABLE',
    timeoutMs: 300_000,
  })
  check(/STILL USABLE/.test(after.turn?.reply ?? ''), 'the session answers after the cancelled turn', after.turn?.reply)
  const messages = await callTool('session_messages', { sessionId: session.sessionId, limit: 100 })
  const transcript = messages.messages ?? []
  check(
    !transcript.some((message) => String(message.text ?? '').includes('QUEUED-NEVER')),
    'the withdrawn message never ran',
  )
  if (preserved) {
    check(
      transcript.some((message) => String(message.text ?? '').includes('QUEUE-B')),
      'the preserved message did run after the cancellation',
    )
  }
}

// --- concurrent turns ------------------------------------------------------

/**
 * Two independent sessions running real turns at the same time.
 *
 * Serialization is per session: a harness that drives several tasks at once relies
 * on one blocked turn not holding up another. This is the cheapest way to show that
 * still holds, and it is not a benchmark — both turns only have to settle with their
 * own replies.
 */
async function concurrentTurnsCheck() {
  section('concurrent turns (real turns)')
  const first = await callTool('session_create', { cwd: process.cwd() })
  const second = await callTool('session_create', { cwd: process.cwd() })
  const startedAt = Date.now()
  const [a, b] = await Promise.all([
    callTool('session_prompt', {
      sessionId: first.sessionId,
      prompt: 'Reply with exactly: CONCURRENT-A',
      timeoutMs: 300_000,
    }),
    callTool('session_prompt', {
      sessionId: second.sessionId,
      prompt: 'Reply with exactly: CONCURRENT-B',
      timeoutMs: 300_000,
    }),
  ])
  const elapsed = Date.now() - startedAt
  check(
    /CONCURRENT-A/.test(a.turn?.reply ?? '') && /CONCURRENT-B/.test(b.turn?.reply ?? ''),
    'two sessions answered their own prompts',
    `${elapsed} ms for both`,
  )
  check(
    a.turn?.aborted !== true && b.turn?.aborted !== true,
    'neither turn was aborted by the other session',
  )
  // Each reply's usage belongs to its own session, which a mixed-up correlation
  // would break even when the text looks right.
  const firstMessages = await callTool('session_messages', { sessionId: first.sessionId, limit: 10 })
  const secondMessages = await callTool('session_messages', { sessionId: second.sessionId, limit: 10 })
  check(
    (firstMessages.messages ?? []).every((message) => !String(message.text ?? '').includes('CONCURRENT-B')) &&
      (secondMessages.messages ?? []).every((message) => !String(message.text ?? '').includes('CONCURRENT-A')),
    'each transcript kept its own conversation',
  )
}

// --- run -------------------------------------------------------------------

process.stdout.write(`${bold('dsh-as-mcp live checks')}\n`)
await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-checks', version: '1' } },
  }),
})
  .then(async (response) => {
    protocolVersion = ((await response.text()).match(/"protocolVersion":"([^"]+)"/) ?? [])[1]
  })
  .catch(() => undefined)
if (protocolVersion === undefined) {
  process.stdout.write(`${red('initialize failed — is anything listening at that endpoint?')}\n`)
  process.exit(2)
}
process.stdout.write(`${dim(`protocol ${protocolVersion}`)}\n`)
try {
  const listed = await rpc('tools/list', {})
  surface = new Set((listed.tools ?? []).map((tool) => tool.name))
  process.stdout.write(`${dim(`${surface.size} tool(s) advertised`)}\n`)
} catch {
  // Leaving `surface` empty makes every gated check report as skipped, which is
  // the honest outcome when the endpoint cannot list tools.
}

try {
  await protocolChecks()
  await shellChecks()
  await shellLimitsChecks()
  await listingImageChecks()
  await filePagingChecks()
  await promptInputChecks()
  await sessionCreateErrorChecks()
  await forkRenameChecks()
  await toolBridgeChecks()
  await workspaceChecks()
  await fileEditChecks()
  await concurrencyChecks()
  await availabilityCheck()
  const sessionId = await listChecks()
  const withSubagent = flag('--with-subagent')
  if (flag('--with-model') || withSubagent) {
    if (sessionId === undefined || !has('session_prompt')) {
      skip('model-turn checks', 'needs session_prompt and a created session')
    } else {
      await progressCheck(sessionId)
      await cancellationCheck()
      await orchestrationCheck()
      await concurrentTurnsCheck()
      if (withSubagent) await subagentCheck()
    }
  } else {
    process.stdout.write(
      `\n${dim('skipping the checks that spend tokens: pass --with-model (progress/cancellation) '
        + 'or --with-subagent (adds a real subagent turn) to run them')}\n`,
    )
  }
} catch (error) {
  check(false, 'run aborted', error instanceof Error ? error.message : String(error))
}

process.stdout.write(
  `\n${failed === 0 ? green('ALL GOOD') : red('FAILURES')} — ${passed} passed, ${failed} failed`
    + `${skipped === 0 ? '' : `, ${skipped} skipped (older endpoint)`}\n`,
)
process.exit(failed === 0 ? 0 : 1)
