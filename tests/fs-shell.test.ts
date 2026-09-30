/**
 * The filesystem and shell seams, with doubles faithful to the real services.
 *
 * These two services had **no** double in this suite at all, and that is where
 * the worst bug in the plugin lived: `readFile` used `fs.readBytes(...,
 * maxBytes + 1)` expecting a truncated result, but the real `readBytes` rejects
 * with `FS_TOO_LARGE` above its cap instead of truncating — so `truncated: true`
 * was unreachable and every file over the limit was an error.
 *
 * A double's job is to enforce the service's real preconditions, not to be
 * convenient. Every rejection modelled below is quoted from the harness source.
 */

import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { testConfig } from './harness.js'
import { DshDriver } from '../src/dsh/driver.js'
import type { DshFileSystem, DshFsDirEntry, DshFsTarget } from '../src/dsh/types.js'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** What a target carries; the driver only ever reads `displayPath` through us. */
function targetFor(displayPath: string, type: 'file' | 'directory' = 'file'): DshFsTarget {
  return { displayPath, type } as unknown as DshFsTarget
}

interface FileSystemCalls {
  readBytes: number
  readByteRange: { offset: number; length: number }[]
}

/**
 * A filesystem double backed by an in-memory map.
 *
 * `readBytes` behaves as the real one is documented to: it imposes an inclusive
 * cap on the *whole* file and rejects rather than truncating. `readByteRange`
 * returns a window. Modelling both is the point — a double that let `readBytes`
 * truncate is precisely what hid the bug.
 */
function fakeFileSystem(files: Record<string, Buffer | string>): {
  fs: DshFileSystem
  calls: FileSystemCalls
  directories: Record<string, readonly DshFsDirEntry[]>
} {
  const calls: FileSystemCalls = { readBytes: 0, readByteRange: [] }
  const directories: Record<string, readonly DshFsDirEntry[]> = {}

  const bytesOf = (path: string): Buffer => {
    const value = files[path]
    if (value === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
        code: 'ENOENT',
      })
    }
    return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  }

  const fs: DshFileSystem = {
    resolve: async (path: string) => targetFor(path, path in directories ? 'directory' : 'file'),
    processPath: (target: DshFsTarget) => target.displayPath,
    stat: async (target: DshFsTarget) => ({
      type: target.displayPath in directories ? ('directory' as const) : ('file' as const),
      size: (files[target.displayPath] ?? '').length,
    }),
    readText: async (target: DshFsTarget) => bytesOf(target.displayPath).toString('utf8'),
    readByteRange: async (target: DshFsTarget, range: { offset: number; length: number }) => {
      calls.readByteRange.push(range)
      return new Uint8Array(bytesOf(target.displayPath).subarray(range.offset, range.offset + range.length))
    },
    listDir: async (target: DshFsTarget) => directories[target.displayPath] ?? [],
    writeText: async () => ({ operation: 'create' as const }),
  }

  // Faithful to the real `readBytes`, which imposes an inclusive cap on the WHOLE
  // file and rejects above it "instead of returning a truncated result". A double
  // that truncated here is what let the bug through, so this one rejects.
  Object.assign(fs, {
    readBytes: async (target: DshFsTarget, _signal: AbortSignal | undefined, maxBytes: number) => {
      calls.readBytes += 1
      const bytes = bytesOf(target.displayPath)
      if (bytes.byteLength > maxBytes) {
        throw Object.assign(new Error(`FS_TOO_LARGE: ${target.displayPath} exceeds ${maxBytes} bytes`), {
          code: 'FS_TOO_LARGE',
        })
      }
      return new Uint8Array(bytes)
    },
  })

  return { fs, calls, directories }
}

/** A driver over the given doubles. */
function driverWith(services: {
  fs?: DshFileSystem
  shell?: unknown
  sandboxPolicy?: unknown
}): DshDriver {
  const ctx = new Context()
  contexts.push(ctx)
  if (services.fs !== undefined) ctx.provide('fs', services.fs)
  if (services.shell !== undefined) ctx.provide('shell', services.shell)
  if (services.sandboxPolicy !== undefined) ctx.provide('sandboxPolicy', services.sandboxPolicy)
  return new DshDriver(ctx, () => testConfig())
}

describe('readFile', () => {
  it('reads a file under the cap whole and untruncated', async () => {
    const { fs } = fakeFileSystem({ '/a.txt': 'hello' })
    const result = await driverWith({ fs }).readFile({ path: '/a.txt', maxBytes: 100 })
    expect(result).toEqual({ path: '/a.txt', text: 'hello', truncated: false })
  })

  it('reads a file exactly at the cap whole and untruncated', async () => {
    // The boundary: asking for `maxBytes + 1` must be what decides truncation, so
    // a file of exactly `maxBytes` bytes is complete, not truncated.
    const { fs } = fakeFileSystem({ '/a.txt': 'x'.repeat(10) })
    const result = await driverWith({ fs }).readFile({ path: '/a.txt', maxBytes: 10 })
    expect(result.truncated).toBe(false)
    expect(result.text).toHaveLength(10)
  })

  it('truncates a file over the cap instead of failing', async () => {
    // The bug this file exists for: the real `readBytes` rejects above its cap
    // rather than truncating, so a bounded read must use `readByteRange`.
    const { fs } = fakeFileSystem({ '/big.txt': 'y'.repeat(50) })
    const result = await driverWith({ fs }).readFile({ path: '/big.txt', maxBytes: 10 })
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('y'.repeat(10))
  })

  it('asks for one byte past the cap through the windowed read', async () => {
    const { fs, calls } = fakeFileSystem({ '/big.txt': 'y'.repeat(50) })
    await driverWith({ fs }).readFile({ path: '/big.txt', maxBytes: 10 })
    expect(calls.readByteRange).toEqual([{ offset: 0, length: 11 }])
    expect(calls.readBytes).toBe(0)
  })

  it('names the alternative when handed a directory', async () => {
    const { fs, directories } = fakeFileSystem({})
    directories['/dir'] = []
    await expect(driverWith({ fs }).readFile({ path: '/dir', maxBytes: 10 })).rejects.toThrow(
      /is a directory; use file_list/,
    )
  })

  it('reports a missing file rather than an empty string', async () => {
    const { fs } = fakeFileSystem({})
    await expect(driverWith({ fs }).readFile({ path: '/nope', maxBytes: 10 })).rejects.toThrow(/ENOENT/)
  })
})

describe('listDirectory', () => {
  it('sorts entries by name and omits an absent size', async () => {
    const { fs, directories } = fakeFileSystem({})
    directories['/dir'] = [
      { name: 'z.txt', type: 'file', target: targetFor('/dir/z.txt'), size: 3 },
      { name: 'a', type: 'directory', target: targetFor('/dir/a', 'directory') },
    ]
    const result = await driverWith({ fs }).listDirectory({ path: '/dir' })
    expect(result.entries.map((entry) => entry.name)).toEqual(['a', 'z.txt'])
    expect(result.entries[0]).not.toHaveProperty('size')
  })
})

describe('runShell', () => {
  /** A shell double recording the spec it was handed. */
  function fakeShell(): { shell: unknown; specs: Record<string, unknown>[] } {
    const specs: Record<string, unknown>[] = []
    return {
      specs,
      shell: {
        resolve: (spec: Record<string, unknown>) => {
          specs.push(spec)
          return spec
        },
        run: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          stdout: { text: 'out', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      },
    }
  }

  it('passes the directory as workdir, not cwd', async () => {
    // The real spec field is `workdir`; sending `cwd` would be silently ignored.
    const { shell, specs } = fakeShell()
    await driverWith({ shell }).runShell({ command: 'true', cwd: '/tmp', timeoutMs: 1000 })
    expect(specs[0]).toMatchObject({ command: 'true', workdir: '/tmp', timeoutMs: 1000 })
  })

  it('flattens the collected streams into text plus truncation flags', async () => {
    const { shell } = fakeShell()
    const result = await driverWith({ shell }).runShell({ command: 'true', timeoutMs: 1000 })
    expect(result).toMatchObject({ stdout: 'out', stderr: '', stdoutTruncated: false, exitCode: 0 })
  })
})

describe('the shell seam across harness versions', () => {
  it('runs through `execute` when the host has no `run`', async () => {
    // 0.1.7-rc.2 replaced `shell.run` with `shell.execute` and dropped `run`
    // entirely. Calling `run` unconditionally would fail there with "not a
    // function", so the driver has to pick whichever the host provides.
    const calls: unknown[] = []
    const shell = {
      resolve: (request: unknown) => ({ resolvedFrom: request }),
      execute: async (spec: unknown) => {
        calls.push(spec)
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 1_000,
          stdout: { text: 'via execute\n', truncated: false },
          stderr: { text: '', truncated: false },
        }
      },
    }
    const driver = driverWith({ shell })
    const result = await driver.runShell({ command: 'echo hi', timeoutMs: 1_000 })
    expect(result.stdout).toBe('via execute\n')
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual([{ resolvedFrom: { command: 'echo hi', timeoutMs: 1_000 } }])
  })

  it('still prefers `run` where the host has it', async () => {
    const seen: string[] = []
    const shell = {
      resolve: () => ({ spec: true }),
      run: async () => {
        seen.push('run')
        return {
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1_000,
          stdout: { text: 'via run\n', truncated: false }, stderr: { text: '', truncated: false },
        }
      },
      execute: async () => {
        seen.push('execute')
        throw new Error('execute should not be called when run exists')
      },
    }
    const result = await driverWith({ shell }).runShell({ command: 'echo hi', timeoutMs: 1_000 })
    expect(result.stdout).toBe('via run\n')
    expect(seen).toEqual(['run'])
  })

  it('explains itself when the host exposes neither', async () => {
    const driver = driverWith({ shell: { resolve: () => ({}) } })
    await expect(driver.runShell({ command: 'echo hi', timeoutMs: 1_000 }))
      .rejects.toThrow(/neither run\(\) nor execute\(\)/)
  })
})

describe('file_write honours createDirectories', () => {
  /**
   * A filesystem double whose directories exist only where `existing` says so.
   *
   * The real seam's atomic write always creates missing parents, which is what
   * made `createDirectories: false` a silent no-op before; modelling that
   * behavior here is what pins the driver's pre-write check to the flag.
   */
  function fsWithExistingParents(existing: (path: string) => boolean): {
    fs: DshFileSystem
    writes: string[]
  } {
    const writes: string[] = []
    const fs: DshFileSystem = {
      resolve: async (path: string) => targetFor(path),
      processPath: (target: DshFsTarget) => target.displayPath,
      stat: async (target: DshFsTarget) =>
        existing(target.displayPath) ? { type: 'directory' as const, size: 0 } : undefined,
      readText: async () => '',
      readByteRange: async () => new Uint8Array(),
      listDir: async () => [],
      writeText: async (target: DshFsTarget) => {
        writes.push(target.displayPath)
        return { operation: 'create' as const }
      },
    }
    return { fs, writes }
  }

  it('refuses the write when the parent is missing and the flag is false', async () => {
    // The contract the schema used to lie about: a caller passing
    // `createDirectories: false` expects a refusal, not a successful write that
    // created the directory anyway.
    const { fs, writes } = fsWithExistingParents((path) => path === '/present')
    await expect(
      driverWith({ fs }).writeFile({
        path: '/present/missing/out.txt',
        content: 'x',
        createDirectories: false,
      }),
    ).rejects.toThrow(/parent directory does not exist and createDirectories is false/)
    expect(writes).toEqual([])
  })

  it('writes through when the parent exists, even with the flag false', async () => {
    const { fs, writes } = fsWithExistingParents((path) => path === '/present')
    const outcome = await driverWith({ fs }).writeFile({
      path: '/present/out.txt',
      content: 'x',
      createDirectories: false,
    })
    expect(outcome).toEqual({ path: '/present/out.txt', operation: 'create' })
    expect(writes).toEqual(['/present/out.txt'])
  })

  it('does not consult the parent when the flag is true, matching the seam', async () => {
    // With creation allowed, the seam handles missing parents inside the fence;
    // probing first would be dead work and another path for TOCTOU.
    const { fs, writes } = fsWithExistingParents(() => false)
    const outcome = await driverWith({ fs }).writeFile({
      path: '/anything/missing/out.txt',
      content: 'x',
      createDirectories: true,
    })
    expect(outcome.operation).toBe('create')
    expect(writes).toEqual(['/anything/missing/out.txt'])
  })
})

describe('file_write never creates the parent outside the sandbox (F1)', () => {
  it('does not mkdir through node:fs before the fs seam sees the write', async () => {
    // The bug this encodes: `file_write {createDirectories: true}` used to call
    // `node:fs` mkdir on a lexically-resolved parent BEFORE `fs.resolve`, so it ran
    // ahead of the sandbox backend's `checkedTarget`. Under the fail-safe
    // `read-only` default that created directories the policy forbids, and under
    // `workspace-write` a symlinked ancestor put them outside the root before the
    // write itself was refused. The seam's atomic write already mkdirs inside the
    // fence (`fs-local/src/fsio.ts:578-580`), so the driver must not do it at all.
    const workspace = join(tmpdir(), `dsh-as-mcp-f1-${process.pid}-${Date.now()}`, 'nested', 'deep')
    const order: string[] = []
    const fs: DshFileSystem = {
      resolve: async (path: string) => {
        order.push('resolve')
        return targetFor(path)
      },
      processPath: (target: DshFsTarget) => target.displayPath,
      stat: async () => ({ type: 'file' as const, size: 0 }),
      readText: async () => '',
      readByteRange: async () => new Uint8Array(),
      listDir: async () => [],
      // Modelled on the real sandbox backend, which refuses before writing.
      writeText: async () => {
        order.push('writeText')
        throw Object.assign(new Error('FS_SANDBOX_DENIED: file access denied under read-only mode'), {
          code: 'FS_SANDBOX_DENIED',
        })
      },
    }

    try {
      await expect(
        driverWith({ fs, sandboxPolicy: { defaultMode: 'read-only' } }).writeFile({
          path: join(workspace, 'out.txt'),
          content: 'x',
          createDirectories: true,
        }),
      ).rejects.toThrow(/FS_SANDBOX_DENIED/)

      // The seam was consulted, and nothing was created behind its back.
      expect(order).toEqual(['resolve', 'writeText'])
      expect(existsSync(workspace)).toBe(false)
      expect(existsSync(dirname(workspace))).toBe(false)
    } finally {
      rmSync(join(tmpdir(), dirname(workspace).slice(dirname(workspace).lastIndexOf('dsh-as-mcp-f1-'))), {
        recursive: true,
        force: true,
      })
    }
  })
})
