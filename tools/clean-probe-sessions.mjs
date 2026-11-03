#!/usr/bin/env node
/**
 * Remove the sessions this project's own live checks left behind — never a session a
 * human has prompted.
 *
 * Every `live-checks`/`exercise` run creates real sessions in `$DSH_HOME/sessions`, and
 * a long-lived checkout accumulates them: on the machine this was written for, 2382
 * session logs / 416 MB, most of them from checks. They are noise in the app's session
 * list, so this removes the ones the checks created.
 *
 * ## Why the rule is positive evidence only
 *
 * The first version of this tool decided a session was a check artifact if its *log
 * contained* one of the exact prompts the checks send. That is wrong: a real developer
 * session that merely reads `tools/live-checks.mjs` (or this file) has those strings in
 * its tool results, and a session that read them is indistinguishable from one the
 * checks drove. On 2026-11-03 that version deleted two real sessions, one of them while
 * the app had it open — see docs/INCIDENT-2026-11-03-session-log-deletion.md. A session
 * running this very command matched the old rule too, because its transcript quoted the
 * marker list.
 *
 * So a session is a check artifact only on evidence the checks *own* it, and a session
 * with any human prompt is kept outright:
 *
 * 1. It has no human prompt. A prompt is a `user/message` event whose source kind is
 *    `user`; a browser prompt carries a plain client uuid, the plugin's carries
 *    `PROBE_RPC_PREFIX` (`dsh-as-mcp-`: a random id, or `dsh-as-mcp-idem-<key>` for
 *    idempotent calls). A `user/message` with no source at all counts as human. This
 *    check runs before any of the recognition rules below, so no key and no content can
 *    override it.
 * 2. Its workspace key is a path only the checks use: a profile directory under
 *    `~/.dsh/profiles-*` or a directory under `/tmp` / `/private/tmp` /
 *    `/var/folders`. A human does not keep their own work in a throwaway home.
 * 3. Every prompt in its log is one the plugin sent (at least one of them). A log with
 *    a plugin prompt and no human one was driven by a check.
 *
 * Anything else is kept — including check sessions created by plugin versions that did
 * not mark their prompts, and empty sessions in a real workspace (one may be a session
 * the user opened and has not typed in yet). Noise is cheaper than data loss.
 *
 * One more brake: a session written to within `--fresh-mins` (default 10) is never
 * deleted, because it may be the session running this command or a check still in
 * flight.
 *
 * Removal is recoverable: `--yes` moves each session directory to
 * `$DSH_HOME/sessions-trash/<timestamp>/`, which the app does not read and a human can
 * move back. `--purge` (with `--yes`) is the only way to delete for good.
 *
 * Usage:
 *   node tools/clean-probe-sessions.mjs                      # report only
 *   node tools/clean-probe-sessions.mjs --yes                # move to the trash
 *   node tools/clean-probe-sessions.mjs --yes --purge        # delete for good
 *   node tools/clean-probe-sessions.mjs --home ~/.dsh --yes  # another store
 *   node tools/clean-probe-sessions.mjs --fresh-mins 0       # disable the freshness brake
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const home = option('--home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const sessionsRoot = join(home, 'sessions')
if (!existsSync(sessionsRoot)) {
  process.stderr.write(`no session store at ${sessionsRoot}\n`)
  process.exit(2)
}

/** How long after its last write a session could still be live. */
const freshMins = Number(option('--fresh-mins', '10'))
if (!Number.isFinite(freshMins) || freshMins < 0) {
  process.stderr.write('--fresh-mins must be a non-negative number of minutes\n')
  process.exit(2)
}
const freshMs = freshMins * 60 * 1000

/** A workspace key the checks own outright (their `cwd` was a throwaway directory). */
const PROBE_KEY = /\.dsh-profiles-|^--(private-)?tmp-|^--var-folders-|^--private-var-folders-/

/**
 * The prefix the plugin gives every prompt request id. The harness stores it as
 * `source.rpcId` on the committed user message, so it is set by the plugin itself —
 * not by prompt wording, which a real transcript can quote. Older plugin versions did
 * not derive ids this way; their sessions are kept rather than guessed at.
 */
const PROBE_RPC_PREFIX = 'dsh-as-mcp-'

/** The log files a session may have, newest format first. */
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']

/** The log file a session directory holds, if any. */
function logOf(dir) {
  for (const name of LOG_NAMES) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return undefined
}

/** Read a session's log, if it has one (all formats the harness has used). */
function readLog(file) {
  const decoded = spawnSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 })
  if (decoded.status !== 0 || decoded.stdout === undefined) return undefined
  return decoded.stdout.toString('utf8')
}

/**
 * Split a log's prompts into the ones a human typed and the ones the plugin sent.
 *
 * Only `user/message` events whose source kind is `user` are prompts; injected context
 * (time snapshots, subagent and team messages) arrives under other source kinds. A
 * `user` message with no readable `rpcId` counts as human: when in doubt, keep.
 */
function promptsOf(text) {
  const human = []
  const plugin = []
  for (const line of text.split('\n')) {
    if (!line.includes('user/message')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    // A `user/message` with no source at all is old or foreign format; it is far more
    // likely a prompt someone typed than one the plugin sent, so it counts as human.
    if (source === undefined || source === null) {
      human.push('<no source>')
      continue
    }
    if (source.kind !== 'user') continue
    const rpcId = source.rpcId
    if (typeof rpcId !== 'string' || !rpcId.startsWith(PROBE_RPC_PREFIX)) human.push(String(rpcId))
    else plugin.push(rpcId)
  }
  return { human, plugin }
}

/** Where a session stands: removable, or why it is kept. */
function classifySession(log, probeKey) {
  const text = readLog(log)
  if (text === undefined) return { keep: 'unreadable log' }
  const { human, plugin } = promptsOf(text)
  if (human.length > 0) return { keep: 'has a human prompt' }
  if (probeKey) return { remove: 'throwaway workspace key' }
  if (plugin.length > 0) return { remove: 'only plugin prompts' }
  return { keep: 'no plugin-prompt evidence' }
}

/** The newest write time of anything in a session directory. */
function newestMtime(dir, log) {
  let newest = 0
  for (const file of [dir, log, join(dir, 'session.lock')]) {
    try {
      newest = Math.max(newest, statSync(file).mtimeMs)
    } catch {
      // A missing sibling says nothing about liveness; the others still answer.
    }
  }
  return newest
}

const now = Date.now()
const candidates = []
const kept = new Map()
let totalSessions = 0

for (const keyEntry of readdirSync(sessionsRoot, { withFileTypes: true })
  .sort((left, right) => left.name.localeCompare(right.name))) {
  // `Dirent` is an lstat result, so a symlinked workspace key is not followed: a
  // session behind a link is not this store's to move.
  if (!keyEntry.isDirectory()) continue
  const key = keyEntry.name
  const keyDir = join(sessionsRoot, key)
  let entries
  try {
    entries = readdirSync(keyDir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(keyDir, entry.name)
    const log = logOf(dir)
    if (log === undefined) continue
    totalSessions += 1
    const verdict = classifySession(log, PROBE_KEY.test(key))
    if (verdict.keep !== undefined) {
      kept.set(verdict.keep, (kept.get(verdict.keep) ?? 0) + 1)
      continue
    }
    candidates.push({
      key,
      dir,
      reason: verdict.remove,
      fresh: now - newestMtime(dir, log) < freshMs,
    })
  }
}

const removable = candidates.filter((candidate) => !candidate.fresh)
const tooFresh = candidates.filter((candidate) => candidate.fresh)

const groups = new Map()
for (const candidate of removable) {
  const group = groups.get(candidate.key) ?? []
  group.push(candidate)
  groups.set(candidate.key, group)
}
const sortedGroups = [...groups.entries()].sort((left, right) => right[1].length - left[1].length)
for (const [key, sessions] of sortedGroups.slice(0, 25)) {
  process.stdout.write(`${String(sessions.length).padStart(6)}  ${key}\n`)
}
if (sortedGroups.length > 25) {
  process.stdout.write(`        ... and ${sortedGroups.length - 25} more workspace key(s)\n`)
}
if (flag('--verbose')) {
  for (const [key, sessions] of sortedGroups) {
    for (const session of sessions) {
      process.stdout.write(`        ${key}/${basename(session.dir)} (${session.reason})\n`)
    }
  }
}

const byReason = removable.reduce((counts, candidate) => {
  counts[candidate.reason] = (counts[candidate.reason] ?? 0) + 1
  return counts
}, {})
process.stdout.write(
  `\n${removable.length} of ${totalSessions} session(s) are check artifacts (${Object.entries(byReason).map(([reason, count]) => `${reason}: ${count}`).join(', ') || 'none'}).\n`,
)
process.stdout.write(
  `kept: ${[...kept.entries()].map(([reason, count]) => `${reason}: ${count}`).join(', ') || 'none'}\n`,
)
if (tooFresh.length > 0) {
  process.stdout.write(`skipped ${tooFresh.length} touched within ${freshMins} min (could still be live).\n`)
}

if (!flag('--yes')) {
  process.stdout.write('Dry run: pass --yes to move them to the trash (--purge to delete for good).\n')
  process.exit(0)
}

const purge = flag('--purge')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const trashRoot = join(home, 'sessions-trash', stamp)
let removed = 0
for (const candidate of removable) {
  if (purge) {
    rmSync(candidate.dir, { recursive: true, force: true })
  } else {
    const destination = join(trashRoot, candidate.key, basename(candidate.dir))
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(candidate.dir, destination)
  }
  removed += 1
}
// Drop a workspace key that only held removals; an empty directory would still be
// listed as a workspace. A concurrent write keeps it, which is also fine.
for (const key of new Set(removable.map((candidate) => candidate.key))) {
  const keyDir = join(sessionsRoot, key)
  try {
    if (readdirSync(keyDir).length === 0) rmSync(keyDir, { recursive: true, force: true })
  } catch {
    // Removed by someone else, or still in use: either way, nothing to clean.
  }
}

if (purge) {
  process.stdout.write(`purged ${removed} session(s) permanently.\n`)
} else if (removed === 0) {
  process.stdout.write('nothing to move.\n')
} else {
  process.stdout.write(`moved ${removed} session(s) to ${trashRoot}\n`)
  process.stdout.write('To restore one: move its directory back under its workspace key in sessions/.\n')
}
