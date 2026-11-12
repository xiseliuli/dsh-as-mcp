#!/usr/bin/env node
/**
 * Boot one throwaway DSH instance for live verification, keep it running, and tear
 * it down on request.
 *
 * Every release check needs "a real harness, my build, and nothing else": the
 * installed desktop app is the operator's own session store, and the acceptance
 * run in `tools/release.sh` tears its instance down when it finishes. This script
 * is the middle ground — it builds a profile from the **installed app runtime**
 * under a throwaway `DSH_HOME`, installs the freshly packed tarball into it, boots
 * the web profile headless on OS-chosen ports, and prints where it is. Probe
 * scripts (`tools/live-*.mjs`) can then be run against it one after another, and
 * `stop` removes the whole thing.
 *
 * ```bash
 * node tools/isolated-harness.mjs start --tarball /tmp/dsh-as-mcp-0.55.0.tgz
 * # { "url": "http://127.0.0.1:PORT/mcp", "token": "...", "home": "...", "pid": 1234 }
 * node tools/isolated-harness.mjs status
 * node tools/isolated-harness.mjs stop
 * ```
 *
 * State lives at `/tmp/dsh-as-mcp-live-harness.json` so separate invocations agree
 * on which instance is current; a second `start` refuses rather than leaking a
 * process. Nothing here is part of the published package.
 *
 * @module dsh-as-mcp/tools/isolated-harness
 */

import { execFileSync, spawn } from 'node:child_process'
import { Socket, createServer } from 'node:net'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The state file every subcommand agrees on. */
const STATE = join(tmpdir(), 'dsh-as-mcp-live-harness.json')
/** Where the app's own runtime CLI lives. */
const RUNTIME_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
/** The shipped profile template the throwaway profile is created from. */
const TEMPLATE = 'web'
/** The profile name inside the throwaway home. */
const PROFILE = 'live-check'

/** Print one usage line and exit. */
function usage() {
  process.stdout.write(
    'usage: node tools/isolated-harness.mjs start [--tarball PATH] [--keep-home]\n'
      + '       node tools/isolated-harness.mjs status\n'
      + '       node tools/isolated-harness.mjs stop\n',
  )
  process.exit(2)
}

/** Parse `--flag value` / `--flag` arguments. */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const key = arg.slice(2)
    if (key === 'bundle') {
      const name = argv[index + 1]
      if (name === undefined || name.startsWith('--')) throw new Error('--bundle needs a package name')
      options.bundles = [...(options.bundles ?? []), name]
      index += 1
      continue
    }
    if (key === 'keep-home') {
      options['keep-home'] = true
      continue
    }
    if (key === 'approval') {
      const approval = argv[index + 1]
      if (!['inherit', 'allow', 'human'].includes(approval)) throw new Error('--approval must be inherit, allow or human')
      options.approval = approval
      index += 1
      continue
    }
    if (key === 'approval-timeout') {
      const ms = Number(argv[index + 1])
      if (!Number.isFinite(ms) || ms <= 0) throw new Error('--approval-timeout needs a positive number of ms')
      options['approval-timeout'] = ms
      index += 1
      continue
    }
    if (key === 'guard-mutations') {
      options['guard-mutations'] = true
      continue
    }
    if (key === 'scope') {
      const scope = argv[index + 1]
      if (scope !== 'all' && scope !== 'owned') throw new Error('--scope must be "all" or "owned"')
      options.scope = scope
      index += 1
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    options[key] = value
    index += 1
  }
  return options
}

/** Two ports the OS says are free right now. */
async function freePorts() {
  const listen = () => new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  // Both listeners open before either port is read: closing the first lets the OS
  // hand the same port back for the second.
  const first = await listen()
  const second = await listen()
  const pluginPort = first.address().port
  const webPort = second.address().port
  first.close()
  second.close()
  return { pluginPort, webPort }
}

/** Read the harness bearer token the plugin generated in the throwaway home. */
function readToken(home) {
  return readFileSync(join(home, 'dsh-as-mcp', 'token'), 'utf8').trim()
}

/** Whether a TCP port accepts a connection. */
async function portOpen(port) {
  return await new Promise((resolve) => {
    const socket = new Socket()
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, '127.0.0.1')
  })
}

/** `start`: create the throwaway profile, boot it, and record how to reach it. */
async function start(options) {
  if (existsSync(STATE)) {
    const running = JSON.parse(readFileSync(STATE, 'utf8'))
    if (running.pid !== undefined) {
      try {
        process.kill(running.pid, 0)
        throw new Error(
          `an isolated harness is already running (pid ${running.pid}, ${running.url}); run "stop" first`,
        )
      } catch (error) {
        if (!(error instanceof Error) || error.message.startsWith('an isolated harness')) throw error
        // The recorded process is gone; the state file is stale.
      }
    }
    rmSync(STATE, { force: true })
  }
  if (!existsSync(RUNTIME_CLI)) throw new Error(`no DSH runtime CLI at ${RUNTIME_CLI}`)
  const repo = process.cwd()
  const tarball = options.tarball ?? join(tmpdir(), `dsh-as-mcp-${JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version}.tgz`)
  if (!existsSync(tarball)) {
    throw new Error(`no tarball at ${tarball}; run ./node_modules/.bin/tsdown && npm pack --pack-destination /tmp first`)
  }

  const { pluginPort, webPort } = await freePorts()
  const home = join(tmpdir(), `dsh-live-${Date.now().toString(36)}`)
  mkdirSync(home, { recursive: true })
  const profileDir = join(home, 'profiles', PROFILE)
  const env = { ...process.env, DSH_HOME: home }
  execFileSync(RUNTIME_CLI, ['--profile', PROFILE, '--from-default-profile', TEMPLATE, '--dump-config'], {
    env,
    stdio: 'ignore',
  })
  execFileSync(RUNTIME_CLI, ['plugin', '--profile', PROFILE, 'add', tarball], { env, stdio: 'ignore' })
  // Shipped bundles (the forge/worktree one, for example) are composed by name from
  // the app runtime, so adding them is a profile-manifest edit rather than an install.
  if (options.bundles !== undefined && options.bundles.length > 0) {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const bundle of options.bundles) {
      if (!manifest.dsh.profile.bundles.includes(bundle)) manifest.dsh.profile.bundles.push(bundle)
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  // `--scope owned` boots the containment mode so the schedule boundary can be
  // verified against a real profile rather than only in unit tests.
  const scopeLine = options.scope === undefined ? '' : `    session:\n      scope: ${options.scope}\n`
  const approvalLines = (options.approval === undefined && options['guard-mutations'] !== true)
    ? ''
    : `    approval:\n`
      + (options.approval === undefined ? '' : `      policy: ${options.approval}\n`)
      + (options['guard-mutations'] === true ? '      guardMutations: true\n' : '')
      + (options['approval-timeout'] === undefined ? '' : `      humanTimeoutMs: ${options['approval-timeout']}\n`)
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    `# Live-verification overlay: a deterministic plugin port for the probe scripts.
- id: dsh-as-mcp
  config:
    http:
      enabled: true
      host: 127.0.0.1
      port: ${pluginPort}
      path: /mcp
      mountOnWebServer: false
${scopeLine}${approvalLines}`,
  )

  const log_file = join(home, 'harness.log')
  const log = log_file
  const out = openSync(log_file, 'a')
  const child = spawn(RUNTIME_CLI, ['--profile', PROFILE, '--no-open', '--port', String(webPort)], {
    env,
    cwd: home,
    detached: true,
    // The plugin's own log lines are the only window into a headless boot, so the
    // child's stderr is kept rather than discarded.
    stdio: ['ignore', out, out],
  })
  closeSync(out)
  child.unref()
  const startedAt = Date.now()
  let ready = false
  while (Date.now() - startedAt < 90_000) {
    if (await portOpen(pluginPort)) {
      ready = true
      break
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500))
  }
  if (!ready) {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch {}
    throw new Error(`the throwaway harness did not listen on ${pluginPort}; log: ${log}`)
  }
  const token = readToken(home)
  const state = {
    pid: child.pid,
    home,
    profile: PROFILE,
    scope: options.scope ?? 'all',
    approval: options.approval ?? 'inherit',
    bundles: options.bundles ?? [],
    tarball,
    pluginPort,
    webPort,
    url: `http://127.0.0.1:${pluginPort}/mcp`,
    token,
    log,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
}

/** `status`: report the recorded instance, if it is still alive. */
async function status() {
  if (!existsSync(STATE)) {
    process.stdout.write('no isolated harness recorded\n')
    process.exitCode = 1
    return
  }
  const state = JSON.parse(readFileSync(STATE, 'utf8'))
  const alive = await portOpen(state.pluginPort)
  process.stdout.write(`${JSON.stringify({ ...state, alive }, null, 2)}\n`)
  if (!alive) process.exitCode = 1
}

/** `stop`: kill the recorded process and remove the throwaway home. */
async function stop(options = {}) {
  if (!existsSync(STATE)) {
    process.stdout.write('no isolated harness recorded\n')
    return
  }
  const state = JSON.parse(readFileSync(STATE, 'utf8'))
  try {
    process.kill(-state.pid, 'SIGTERM')
  } catch {
    try {
      process.kill(state.pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await portOpen(state.pluginPort))) break
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 200))
  }
  if (await portOpen(state.pluginPort)) {
    try {
      process.kill(-state.pid, 'SIGKILL')
    } catch {}
  }
  if (options['keep-home'] !== true) rmSync(state.home, { recursive: true, force: true })
  rmSync(STATE, { force: true })
  process.stdout.write(`stopped ${state.url}${options['keep-home'] === true ? ` (kept ${state.home})` : ''}\n`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'start') await start(parseArgs(rest))
else if (command === 'status') await status()
else if (command === 'stop') await stop(parseArgs(rest))
else usage()
