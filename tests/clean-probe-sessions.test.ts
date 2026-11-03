import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const toolPath = fileURLToPath(new URL('../tools/clean-probe-sessions.mjs', import.meta.url))

/** A prompt a human typed in the app: the source kind is `user` with a client uuid. */
const humanPrompt = (text: string) => ({
  type: 'user/message',
  data: {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
  },
})
/** A prompt this plugin sent: same kind, but the rpcId carries the plugin's prefix. */
const pluginPrompt = (text: string) => ({
  type: 'user/message',
  data: {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: 'dsh-as-mcp-6fa459ea-ee8a-4ad9-8f2d-1c2e2f6a0b31' },
  },
})
const injectedContext = (text: string) => ({
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'time-context' } },
})
const toolResult = (text: string) => ({ type: 'tool/result', data: { text } })

/**
 * Markers the pre-fix tool treated as proof of a check session. A real developer
 * session reads `tools/live-checks.mjs` (which contains them) and therefore has them
 * in its tool results — the false positive that deleted two real sessions on
 * 2026-11-03. Every fixture below includes them so "kept" is never an accident of
 * content being absent.
 */
const CHECK_MARKERS = 'Reply with exactly: WINDOW DONE\n"rpcId":"dsh-as-mcp-\npadded title'

/** Build one session directory with a v4 log and a lock file. */
function session(home: string, key: string, id: string, events: unknown[], ageMinutes = 60): string {
  const dir = join(home, 'sessions', key, id)
  mkdirSync(dir, { recursive: true })
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1_700_000_000_000,
    cwd: '/tmp/workspace',
    isSeeded: false,
    delegationDepth: 0,
  }
  const lines = [JSON.stringify(header)]
  events.forEach((event, index) => {
    lines.push(JSON.stringify({ ...(event as object), seq: index, time: 1_700_000_000_000 + index }))
  })
  const logPath = join(dir, 'session.v4.jsonl.zstd')
  const encoded = spawnSync('zstd', ['-q', '-f', '-o', logPath], {
    input: `${lines.join('\n')}\n`,
  })
  expect(encoded.status, String(encoded.stderr)).toBe(0)
  writeFileSync(join(dir, 'session.lock'), '')
  const stamp = new Date(Date.now() - ageMinutes * 60_000)
  for (const path of [logPath, join(dir, 'session.lock'), dir]) utimesSync(path, stamp, stamp)
  return dir
}

/** Run the tool against one throwaway home and return its output. */
function run(home: string, args: string[] = []): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [toolPath, '--home', home, ...args], {
    encoding: 'utf8',
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** A throwaway home; nothing in the developer's real store is touched by a test. */
function home(): string {
  return mkdtempSync(join(tmpdir(), 'clean-probe-sessions-'))
}

/** The `session-<id>` directory names left under a workspace key. */
function remaining(homeDir: string, key: string): string[] {
  try {
    return readdirSync(join(homeDir, 'sessions', key)).sort()
  } catch {
    return []
  }
}

/** Every session directory moved into the trash. */
function trashed(homeDir: string): string[] {
  const root = join(homeDir, 'sessions-trash')
  if (!existsSync(root)) return []
  const names: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('session-')) names.push(entry.name)
      else walk(join(dir, entry.name))
    }
  }
  walk(root)
  return names.sort()
}

const REAL_KEY = '--Users-tester-some-project--'

describe('tools/clean-probe-sessions.mjs', { timeout: 30_000 }, () => {
  it('keeps a real session whose transcript quotes every check marker', () => {
    const store = home()
    session(store, REAL_KEY, 'session-human', [
      humanPrompt('详细检查这个插件'),
      injectedContext('runtime context'),
      toolResult(CHECK_MARKERS),
    ])
    const dry = run(store)
    expect(dry.code).toBe(0)
    expect(dry.output).toContain('0 of 1 session(s) are check artifacts')
    expect(dry.output).toContain('has a human prompt: 1')

    const applied = run(store, ['--yes'])
    expect(applied.code).toBe(0)
    expect(remaining(store, REAL_KEY)).toEqual(['session-human'])
    expect(trashed(store)).toEqual([])
  })

  it('moves a session whose prompts all carry the plugin rpcId to the trash', () => {
    const store = home()
    session(store, REAL_KEY, 'session-check', [
      pluginPrompt('Reply with exactly: WINDOW DONE'),
      injectedContext('runtime context'),
      toolResult('ok'),
    ])
    const applied = run(store, ['--yes'])
    expect(applied.code).toBe(0)
    expect(applied.output).toContain('moved 1 session(s)')
    expect(remaining(store, REAL_KEY)).toEqual([])
    expect(trashed(store)).toEqual(['session-check'])
  })

  it('never deletes a session that also has one human prompt', () => {
    const store = home()
    session(store, REAL_KEY, 'session-mixed', [
      humanPrompt('run the checks for me'),
      pluginPrompt('Reply with exactly: PROGRESS OK'),
    ])
    run(store, ['--yes'])
    expect(remaining(store, REAL_KEY)).toEqual(['session-mixed'])
  })

  it('removes sessions in a throwaway workspace key when nothing human is in them', () => {
    const store = home()
    session(store, '--private-tmp-live-probe--', 'session-probe-a', [injectedContext('runtime')])
    session(store, '--Users-tester-.dsh-profiles-x--', 'session-probe-b', [pluginPrompt('x')])
    const applied = run(store, ['--yes'])
    expect(applied.code).toBe(0)
    expect(applied.output).toContain('throwaway workspace key: 2')
    expect(remaining(store, '--private-tmp-live-probe--')).toEqual([])
    expect(remaining(store, '--Users-tester-.dsh-profiles-x--')).toEqual([])
    expect(trashed(store)).toEqual(['session-probe-a', 'session-probe-b'])
  })

  it('keeps a human session even under a throwaway key (the guard comes first)', () => {
    const store = home()
    session(store, '--private-tmp-live-probe--', 'session-human-probe', [humanPrompt('a quick test')])
    const applied = run(store, ['--yes'])
    expect(applied.code).toBe(0)
    expect(applied.output).toContain('has a human prompt: 1')
    expect(remaining(store, '--private-tmp-live-probe--')).toEqual(['session-human-probe'])
  })

  it('treats a user message with no source as human', () => {
    const store = home()
    session(store, REAL_KEY, 'session-sourceless', [
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'typed' }] } },
      pluginPrompt('and also this'),
    ])
    run(store, ['--yes'])
    expect(remaining(store, REAL_KEY)).toEqual(['session-sourceless'])
  })

  it('does not follow a symlinked workspace key', () => {
    const store = home()
    const outside = mkdtempSync(join(tmpdir(), 'clean-probe-outside-'))
    session(outside, REAL_KEY, 'session-outside', [pluginPrompt('x')])
    mkdirSync(join(store, 'sessions'), { recursive: true })
    // A link under sessions/ that points at another store's workspace directory.
    symlinkSync(join(outside, 'sessions', REAL_KEY), join(store, 'sessions', '--Users-linked--'))
    const applied = run(store, ['--yes', '--fresh-mins', '0'])
    expect(applied.code).toBe(0)
    expect(applied.output).toContain('0 of 0 session(s) are check artifacts')
    expect(remaining(outside, REAL_KEY)).toEqual(['session-outside'])
    expect(trashed(store)).toEqual([])
  })

  it('keeps an empty session in a real workspace (the user may just have opened it)', () => {
    const store = home()
    session(store, REAL_KEY, 'session-empty', [injectedContext('runtime context')])
    const applied = run(store, ['--yes'])
    expect(applied.code).toBe(0)
    expect(applied.output).toContain('no plugin-prompt evidence: 1')
    expect(remaining(store, REAL_KEY)).toEqual(['session-empty'])
  })

  it('skips a session written to within the freshness window, until it stops being fresh', () => {
    const store = home()
    session(store, REAL_KEY, 'session-live', [pluginPrompt('Reply with exactly: SWITCH OK')], 0)
    const guarded = run(store, ['--yes'])
    expect(guarded.output).toContain('skipped 1 touched within 10 min')
    expect(remaining(store, REAL_KEY)).toEqual(['session-live'])
    expect(trashed(store)).toEqual([])

    const unguarded = run(store, ['--yes', '--fresh-mins', '0'])
    expect(unguarded.output).toContain('moved 1 session(s)')
    expect(remaining(store, REAL_KEY)).toEqual([])
    expect(trashed(store)).toEqual(['session-live'])
  })

  it('changes nothing on a dry run', () => {
    const store = home()
    session(store, REAL_KEY, 'session-check', [pluginPrompt('Reply with exactly: MID DONE')])
    const dry = run(store)
    expect(dry.code).toBe(0)
    expect(dry.output).toContain('Dry run')
    expect(dry.output).toContain('1 of 1 session(s) are check artifacts')
    expect(remaining(store, REAL_KEY)).toEqual(['session-check'])
    expect(trashed(store)).toEqual([])
  })

  it('purges permanently only when asked twice (--yes --purge)', () => {
    const store = home()
    session(store, REAL_KEY, 'session-check', [pluginPrompt('Reply with exactly: FIZZBUZZ-OK')])
    const purged = run(store, ['--yes', '--purge'])
    expect(purged.code).toBe(0)
    expect(purged.output).toContain('purged 1 session(s) permanently')
    expect(remaining(store, REAL_KEY)).toEqual([])
    expect(trashed(store)).toEqual([])
  })

  it('stays idempotent: a second run has nothing left to move', () => {
    const store = home()
    session(store, REAL_KEY, 'session-check', [pluginPrompt('Reply with exactly: TARGET DONE')])
    run(store, ['--yes'])
    const second = run(store, ['--yes'])
    expect(second.code).toBe(0)
    expect(second.output).toContain('nothing to move')
    expect(second.output).toContain('0 of 0 session(s) are check artifacts')
  })

  it('does not mistake a quoted prompt inside a tool result for a prompt', () => {
    const store = home()
    // The text names the event type it wants to be mistaken for; only a parsed
    // `type: "user/message"` event counts as a prompt, never a substring.
    session(store, REAL_KEY, 'session-human', [
      humanPrompt('inspect the log'),
      toolResult(`{"type":"user/message","data":{"source":{"kind":"user","rpcId":"dsh-as-mcp-x"}}}`),
    ])
    run(store, ['--yes'])
    expect(remaining(store, REAL_KEY)).toEqual(['session-human'])
    expect(readFileSync(join(store, 'sessions', REAL_KEY, 'session-human', 'session.lock'), 'utf8')).toBe('')
  })

  it('ignores entries that are not sessions and reads a v3 log too', () => {
    const store = home()
    mkdirSync(join(store, 'sessions', REAL_KEY), { recursive: true })
    writeFileSync(join(store, 'sessions', REAL_KEY, 'notes.txt'), 'not a session')
    const dir = join(store, 'sessions', REAL_KEY, 'session-v3')
    mkdirSync(dir)
    const header = {
      type: 'session',
      version: 3,
      id: 'session-v3',
      createdAt: 1_700_000_000_000,
      cwd: '/tmp/workspace',
      isSeeded: false,
      delegationDepth: 0,
    }
    const prompt = {
      ...pluginPrompt('Reply with exactly: after cancellation'),
      seq: 0,
      time: 1_700_000_000_000,
    }
    spawnSync('zstd', ['-q', '-f', '-o', join(dir, 'session.v3.jsonl.zstd')], {
      input: `${JSON.stringify(header)}\n${JSON.stringify(prompt)}\n`,
    })
    const applied = run(store, ['--yes', '--fresh-mins', '0'])
    expect(applied.code).toBe(0)
    expect(applied.output).toContain('moved 1 session(s)')
    expect(remaining(store, REAL_KEY)).toEqual(['notes.txt'])
  })

  it('refuses a home with no session store', () => {
    const result = spawnSync(process.execPath, [toolPath, '--home', join(tmpdir(), 'no-such-home-for-this-test')], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(`${result.stderr}`).toContain('no session store')
  })
})
