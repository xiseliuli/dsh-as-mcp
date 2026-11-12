/**
 * File organization and workspace organization.
 *
 * Two halves of "what a human clicks in the sidebar and the file tree":
 *
 * - `file_delete`/`file_move` go through the filesystem seam, so the same sandbox,
 *   path rules and compare-and-swap guards the read/write tools use apply. A move is
 *   a two-phase operation and the reply says so; a directory is refused because the
 *   safe recursive delete belongs in an explicit `rm` command.
 * - `workspace_rename`/`session_move`/`session_reorder` write the same registry state
 *   the sidebar's rename, drag-between-groups and drag-to-reorder actions write. They
 *   are the organization primitives a caller needs after creating sessions.
 */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import type { Config } from '../src/config.js'
import { DshDriver } from '../src/dsh/driver.js'
import { testConfig } from './harness.js'

type AnyRecord = Record<string, unknown>

const SESSION = 'session-1'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function configWith(overrides: Partial<Config> = {}): Config {
  const base = testConfig()
  return {
    ...base,
    ...overrides,
    http: { ...base.http, ...overrides.http },
    auth: { ...base.auth, ...overrides.auth },
    tools: { ...base.tools, ...overrides.tools },
    agentTools: { ...base.agentTools, ...overrides.agentTools },
    session: { ...base.session, ...overrides.session },
    limits: { ...base.limits, ...overrides.limits },
    approval: { ...base.approval, ...overrides.approval },
  }
}

function makeDriver(options: {
  fs?: AnyRecord | null
  registry?: AnyRecord | null
  config?: Partial<Config>
} = {}): { driver: DshDriver; ctx: Context } {
  const ctx = new Context()
  contexts.push(ctx)
  if (options.fs !== undefined && options.fs !== null) ctx.provide('fs', options.fs)
  if (options.registry !== undefined && options.registry !== null) ctx.provide('workspaceRegistry', options.registry)
  return { driver: new DshDriver(ctx, () => configWith(options.config)), ctx }
}

/** sha256 of a string, the same value `file_read { sha256: true }` reports. */
function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * A filesystem seam double over a path → content map.
 *
 * It models the parts the tools depend on: resolve/processPath/stat, the version
 * token that compare-and-swap uses, and both delete and move (including the
 * two-phase move whose source removal can fail).
 */
function fsDouble(options: {
  files?: Record<string, string>
  directories?: string[]
  moveSourceFailure?: { code: string; message: string }
  deleteMissing?: boolean
  moveMissing?: boolean
} = {}): AnyRecord & { deleted: string[]; moved: AnyRecord[] } {
  const files = new Map(Object.entries(options.files ?? {}))
  const directories = new Set(options.directories ?? [])
  const deleted: string[] = []
  const moved: AnyRecord[] = []
  const targetOf = (path: string) => ({ targetKey: path, displayPath: path })
  const infoOf = (path: string) => {
    if (files.has(path)) return { type: 'file' as const, size: (files.get(path) as string).length, version: `v:${sha(files.get(path) as string).slice(0, 8)}` }
    if (directories.has(path)) return { type: 'directory' as const, version: 'v:dir' }
    return undefined
  }
  const seam: AnyRecord & { deleted: string[]; moved: AnyRecord[] } = {
    deleted,
    moved,
    resolve: async (path: string) => targetOf(path),
    processPath: (target: AnyRecord) => String(target.displayPath),
    stat: async (target: AnyRecord) => infoOf(String(target.displayPath)),
    readText: async (target: AnyRecord) => files.get(String(target.displayPath)),
    listDir: async () => [],
    writeText: async (target: AnyRecord, content: string) => {
      files.set(String(target.displayPath), content)
      return { operation: 'update' }
    },
    deleteFile: options.deleteMissing === true
      ? undefined
      : async (target: AnyRecord) => {
        const path = String(target.displayPath)
        const before = files.get(path) ?? null
        files.delete(path)
        deleted.push(path)
        return { before }
      },
    moveFile: options.moveMissing === true
      ? undefined
      : async (source: AnyRecord, destination: AnyRecord, moveOptions: AnyRecord) => {
        const from = String(source.displayPath)
        const to = String(destination.displayPath)
        moved.push({ from, to, options: moveOptions })
        const before = files.get(to) ?? null
        files.set(to, files.get(from) as string)
        if (options.moveSourceFailure !== undefined) {
          return {
            sourceBefore: files.get(from) ?? null,
            destination: { operation: before === null ? 'create' : 'update', before },
            sourceDeleted: false,
            sourceFailure: options.moveSourceFailure,
          }
        }
        files.delete(from)
        return {
          sourceBefore: files.get(from) ?? null,
          destination: { operation: before === null ? 'create' : 'update', before },
          sourceDeleted: true,
        }
      },
  }
  return seam
}

/** A workspace object double with the organization members recorded. */
function workspaceDouble(id: string, title: string, options: {
  omit?: readonly string[]
} = {}): AnyRecord & { calls: AnyRecord[] } {
  const calls: AnyRecord[] = []
  const workspace: AnyRecord & { calls: AnyRecord[] } = {
    calls,
    id,
    path: `/tmp/${id}`,
    title,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: [SESSION],
    status: async () => 'ok',
    setTitle: async (next: string) => {
      calls.push({ method: 'setTitle', title: next })
      workspace.title = next
    },
    attachSession: async (sessionId: string) => {
      calls.push({ method: 'attachSession', sessionId })
    },
    detachSession: async (sessionId: string) => {
      calls.push({ method: 'detachSession', sessionId })
    },
    insertSessionBefore: async (sessionId: string, beforeSessionId?: string) => {
      calls.push({ method: 'insertSessionBefore', sessionId, beforeSessionId })
    },
  }
  for (const name of options.omit ?? []) delete workspace[name]
  return workspace
}

/** A workspace registry double over one workspace. */
function registryDouble(workspace: AnyRecord | undefined): AnyRecord {
  return {
    get: (id: string) => (workspace !== undefined && workspace.id === id ? workspace : undefined),
    list: () => (workspace === undefined ? [] : [workspace]),
    create: async () => workspace,
    delete: async () => true,
    resolveByPath: async () => workspace,
  }
}

describe('file_delete', () => {
  it('deletes one file and reports its path', async () => {
    const fs = fsDouble({ files: { '/repo/a.txt': 'hello' } })
    const { driver } = makeDriver({ fs })
    await expect(driver.deleteFile({ path: '/repo/a.txt' })).resolves.toEqual({ path: '/repo/a.txt', deleted: true })
    expect(fs.deleted).toEqual(['/repo/a.txt'])
  })

  it('refuses a directory and points at shell_run', async () => {
    const fs = fsDouble({ directories: ['/repo/dir'] })
    const { driver } = makeDriver({ fs })
    await expect(driver.deleteFile({ path: '/repo/dir' })).rejects.toThrow(/is a directory/)
    expect(fs.deleted).toEqual([])
  })

  it('refuses a path that does not exist rather than claiming success', async () => {
    const { driver } = makeDriver({ fs: fsDouble() })
    await expect(driver.deleteFile({ path: '/repo/missing.txt' })).rejects.toThrow(/does not exist/)
  })

  it('honours expectedSha256 as a compare-and-swap guard', async () => {
    const fs = fsDouble({ files: { '/repo/a.txt': 'hello' } })
    const { driver } = makeDriver({ fs })
    await expect(driver.deleteFile({ path: '/repo/a.txt', expectedSha256: sha('hello') }))
      .resolves.toMatchObject({ deleted: true })
    expect(fs.deleted).toEqual(['/repo/a.txt'])

    const second = fsDouble({ files: { '/repo/a.txt': 'hello' } })
    const { driver: guarded } = makeDriver({ fs: second })
    await expect(guarded.deleteFile({ path: '/repo/a.txt', expectedSha256: sha('other') }))
      .rejects.toThrow(/refusing to delete/)
    expect(second.deleted).toEqual([])
  })

  it('refuses to verify a file above the read limit', async () => {
    const big = 'x'.repeat(2_000)
    const fs = fsDouble({ files: { '/repo/big.txt': big } })
    const { driver } = makeDriver({ fs, config: { limits: { ...testConfig().limits, maxReadBytes: 100 } } })
    await expect(driver.deleteFile({ path: '/repo/big.txt', expectedSha256: sha(big) }))
      .rejects.toThrow(/above the 100-byte read limit/)
  })

  it('reports a profile without the seam delete as a capability error', async () => {
    const { driver } = makeDriver({ fs: fsDouble({ deleteMissing: true }) })
    await expect(driver.deleteFile({ path: '/repo/a.txt' })).rejects.toThrow(/fs\.deleteFile is missing/)
  })
})

describe('file_move', () => {
  it('moves a file and reports both phases', async () => {
    const fs = fsDouble({ files: { '/repo/a.txt': 'hello' } })
    const { driver } = makeDriver({ fs })
    const moved = await driver.moveFile({ source: '/repo/a.txt', destination: '/repo/b.txt' })
    expect(moved).toEqual({
      source: '/repo/a.txt',
      destination: '/repo/b.txt',
      operation: 'create',
      sourceDeleted: true,
    })
    expect(fs.moved).toHaveLength(1)
    expect((fs.moved[0] as AnyRecord).options).toMatchObject({
      expectedDestination: { kind: 'createIfAbsent' },
      expectedSource: { version: 'v:' + sha('hello').slice(0, 8) },
    })
  })

  it('refuses an existing destination unless overwrite is set, then uses its version', async () => {
    const fs = fsDouble({ files: { '/repo/a.txt': 'a', '/repo/b.txt': 'b' } })
    const { driver } = makeDriver({ fs })
    await expect(driver.moveFile({ source: '/repo/a.txt', destination: '/repo/b.txt' }))
      .rejects.toThrow(/already exists/)
    expect(fs.moved).toEqual([])

    const overwritten = await driver.moveFile({
      source: '/repo/a.txt',
      destination: '/repo/b.txt',
      overwrite: true,
    })
    expect(overwritten.operation).toBe('update')
    expect((fs.moved[0] as AnyRecord).options).toMatchObject({
      expectedDestination: { kind: 'replaceIfVersion', version: 'v:' + sha('b').slice(0, 8) },
    })
  })

  it('surfaces a failed source removal instead of pretending the move was atomic', async () => {
    const fs = fsDouble({
      files: { '/repo/a.txt': 'a' },
      moveSourceFailure: { code: 'EACCES', message: 'permission denied' },
    })
    const { driver } = makeDriver({ fs })
    const moved = await driver.moveFile({ source: '/repo/a.txt', destination: '/repo/b.txt' })
    expect(moved.sourceDeleted).toBe(false)
    expect(moved.sourceFailure).toEqual({ code: 'EACCES', message: 'permission denied' })
  })

  it('refuses a missing source and a directory source', async () => {
    const missing = makeDriver({ fs: fsDouble() })
    await expect(missing.driver.moveFile({ source: '/repo/none.txt', destination: '/repo/x' }))
      .rejects.toThrow(/does not exist/)
    const dir = makeDriver({ fs: fsDouble({ directories: ['/repo/dir'] }) })
    await expect(dir.driver.moveFile({ source: '/repo/dir', destination: '/repo/x' }))
      .rejects.toThrow(/is a directory/)
  })

  it('reports a profile without the seam move as a capability error', async () => {
    const { driver } = makeDriver({ fs: fsDouble({ moveMissing: true }) })
    await expect(driver.moveFile({ source: '/repo/a.txt', destination: '/repo/b.txt' }))
      .rejects.toThrow(/fs\.moveFile is missing/)
  })
})

describe('workspace_rename', () => {
  it('writes the title through the workspace object', async () => {
    const workspace = workspaceDouble('ws-1', 'old title')
    const { driver } = makeDriver({ registry: registryDouble(workspace) })
    await expect(driver.renameWorkspace({ workspaceId: 'ws-1', title: '  new title  ' }))
      .resolves.toEqual({ workspaceId: 'ws-1', title: 'new title' })
    expect(workspace.calls).toEqual([{ method: 'setTitle', title: 'new title' }])
  })

  it('refuses a blank title and an unknown workspace', async () => {
    const workspace = workspaceDouble('ws-1', 'old')
    const { driver } = makeDriver({ registry: registryDouble(workspace) })
    await expect(driver.renameWorkspace({ workspaceId: 'ws-1', title: '   ' }))
      .rejects.toThrow(/non-blank title/)
    await expect(driver.renameWorkspace({ workspaceId: 'nope', title: 'x' }))
      .rejects.toThrow(/no workspace with id/)
  })
})

describe('session_move', () => {
  it('attaches a session to a group by default and detaches on request', async () => {
    const workspace = workspaceDouble('ws-1', 'group')
    const { driver } = makeDriver({ registry: registryDouble(workspace) })
    await expect(driver.moveSessionToWorkspace({ sessionId: SESSION, workspaceId: 'ws-1' }))
      .resolves.toEqual({ sessionId: SESSION, workspaceId: 'ws-1', attached: true })
    await expect(driver.moveSessionToWorkspace({ sessionId: SESSION, workspaceId: 'ws-1', action: 'detach' }))
      .resolves.toEqual({ sessionId: SESSION, workspaceId: 'ws-1', attached: false })
    expect(workspace.calls).toEqual([
      { method: 'attachSession', sessionId: SESSION },
      { method: 'detachSession', sessionId: SESSION },
    ])
  })

  it('refuses a session outside an owned scope', async () => {
    const workspace = workspaceDouble('ws-1', 'group')
    const { driver } = makeDriver({
      registry: registryDouble(workspace),
      config: { session: { ...testConfig().session, scope: 'owned' } },
    })
    await expect(driver.moveSessionToWorkspace({ sessionId: 'foreign', workspaceId: 'ws-1' }))
      .rejects.toThrow(/session.scope is "owned"/)
  })

  it('reports missing workspace members as a capability error', async () => {
    const workspace = workspaceDouble('ws-1', 'group', { omit: ['attachSession'] })
    const { driver } = makeDriver({ registry: registryDouble(workspace) })
    await expect(driver.moveSessionToWorkspace({ sessionId: SESSION, workspaceId: 'ws-1' }))
      .rejects.toThrow(/attachSession is missing/)
  })
})

describe('session_reorder', () => {
  it('moves a session before an anchor, or to the end when no anchor is given', async () => {
    const workspace = workspaceDouble('ws-1', 'group')
    const { driver } = makeDriver({ registry: registryDouble(workspace) })
    await expect(driver.reorderSession({
      sessionId: SESSION,
      workspaceId: 'ws-1',
      beforeSessionId: 'session-2',
    })).resolves.toEqual({ sessionId: SESSION, workspaceId: 'ws-1', before: 'session-2' })
    await expect(driver.reorderSession({ sessionId: SESSION, workspaceId: 'ws-1' }))
      .resolves.toEqual({ sessionId: SESSION, workspaceId: 'ws-1', before: null })
    expect(workspace.calls).toEqual([
      { method: 'insertSessionBefore', sessionId: SESSION, beforeSessionId: 'session-2' },
      { method: 'insertSessionBefore', sessionId: SESSION, beforeSessionId: undefined },
    ])
  })

  it('reports the harness refusal as its own error', async () => {
    const workspace = workspaceDouble('ws-1', 'group')
    workspace.insertSessionBefore = async () => {
      throw new Error('session is not in this workspace')
    }
    const { driver } = makeDriver({ registry: registryDouble(workspace) })
    await expect(driver.reorderSession({ sessionId: SESSION, workspaceId: 'ws-1' }))
      .rejects.toThrow(/not in this workspace/)
  })
})
