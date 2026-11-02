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

import { createHash } from 'node:crypto'
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

/** What a target carries; the driver reads `displayPath`, `type` and `targetKey`. */
function targetFor(displayPath: string, type: 'file' | 'directory' = 'file'): DshFsTarget {
  // The real seam resolves links, so its key is an identity: two paths to the
  // same directory share one. A recursive walk relies on that to stop cycles.
  return { displayPath, type, targetKey: `${type}:${displayPath}` } as unknown as DshFsTarget
}

interface FileSystemCalls {
  readBytes: number
  readByteRange: { offset: number; length: number }[]
  /** Files written through the seam, in call order. */
  writes: string[]
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
  const calls: FileSystemCalls = { readBytes: 0, readByteRange: [], writes: [] }
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
    // The real seam's `stat` answers `undefined` for a path that is not there —
    // callers branch on that, so the double must not invent a file.
    stat: async (target: DshFsTarget) => {
      const path = target.displayPath
      if (path in directories) return { type: 'directory' as const, size: 0 }
      if (path in files) {
        const value = files[path] as Buffer | string
        return { type: 'file' as const, size: Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value) }
      }
      return undefined
    },
    readText: async (target: DshFsTarget) => bytesOf(target.displayPath).toString('utf8'),
    readByteRange: async (target: DshFsTarget, range: { offset: number; length: number }) => {
      calls.readByteRange.push(range)
      return new Uint8Array(bytesOf(target.displayPath).subarray(range.offset, range.offset + range.length))
    },
    listDir: async (target: DshFsTarget) => directories[target.displayPath] ?? [],
    writeText: async (target: DshFsTarget, content: string) => {
      calls.writes.push(target.displayPath)
      files[target.displayPath] = content
      return { operation: 'create' as const }
    },
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
    expect(result).toEqual({
      path: '/a.txt',
      text: 'hello',
      truncated: false,
      offset: 0,
      bytes: 5,
      size: 5,
    })
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

  it('pages through a file from a byte offset', async () => {
    const { fs, calls } = fakeFileSystem({ '/big.txt': '0123456789abcdefghij' })
    const result = await driverWith({ fs }).readFile({ path: '/big.txt', maxBytes: 5, offset: 10 })
    expect(result).toEqual({
      path: '/big.txt',
      text: 'abcde',
      truncated: true,
      offset: 10,
      bytes: 5,
      nextOffset: 15,
      size: 20,
    })
    // The window is the requested one, still asked one byte past the cap.
    expect(calls.readByteRange).toEqual([{ offset: 10, length: 6 }])
  })

  it('finishes at the end of a file without promising more', async () => {
    const { fs } = fakeFileSystem({ '/big.txt': '0123456789' })
    const result = await driverWith({ fs }).readFile({ path: '/big.txt', maxBytes: 10, offset: 5 })
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('56789')
    expect(result.nextOffset).toBeUndefined()
  })

  it('reads an offset past the end as empty rather than failing', async () => {
    const { fs } = fakeFileSystem({ '/a.txt': 'hello' })
    const result = await driverWith({ fs }).readFile({ path: '/a.txt', maxBytes: 10, offset: 99 })
    expect(result).toMatchObject({ text: '', truncated: false, offset: 99, bytes: 0 })
    expect(result.nextOffset).toBeUndefined()
  })

  it('names the alternative when handed a directory', async () => {
    const { fs, directories } = fakeFileSystem({})
    directories['/dir'] = []
    await expect(driverWith({ fs }).readFile({ path: '/dir', maxBytes: 10 })).rejects.toThrow(
      /is a directory; use file_list/,
    )
  })

  it('hashes the whole file on request, not the returned window', async () => {
    const { fs } = fakeFileSystem({ '/a.txt': 'whole file content' })
    const wholeHash = createHash('sha256').update('whole file content', 'utf8').digest('hex')
    // A windowed read still hashes the whole file: the hash is a compare-and-swap
    // value for the next write, and a window hash would let a stale write through.
    const result = await driverWith({ fs }).readFile({
      path: '/a.txt',
      maxBytes: 5,
      sha256: true,
      // The window is 5 bytes; the hash may read the whole file up to this ceiling,
      // which is what the tool passes from limits.maxReadBytes.
      sha256Limit: 100,
    })
    expect(result.text).toBe('whole')
    expect(result.sha256).toBe(wholeHash)
    // Without the flag the field is absent, so an ordinary read pays nothing.
    const plain = await driverWith({ fs }).readFile({ path: '/a.txt', maxBytes: 5 })
    expect(plain.sha256).toBeUndefined()
  })

  it('refuses to hash a file above the read ceiling', async () => {
    const { fs } = fakeFileSystem({ '/big.txt': 'z'.repeat(50) })
    await expect(driverWith({ fs }).readFile({
      path: '/big.txt',
      maxBytes: 10,
      sha256: true,
      sha256Limit: 20,
    })).rejects.toThrow(/above the 20-byte read ceiling/)
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

describe('readImage', () => {
  /** A 1x1 PNG (the bytes matter, not the picture). */
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  it('returns the bytes as base64 with a sniffed mime type', async () => {
    const { fs, calls } = fakeFileSystem({ '/shot.png': png })
    const image = await driverWith({ fs }).readImage({ path: '/shot.png' })

    expect(image.mimeType).toBe('image/png')
    expect(image.base64).toBe(png.toString('base64'))
    expect(Buffer.from(image.base64, 'base64').equals(png)).toBe(true)
    expect(image).toMatchObject({ path: '/shot.png', bytes: png.byteLength, size: png.byteLength })
    // The read is the windowed one: the file's size plus one byte proving it is
    // not larger, and never wider than the cap.
    expect(calls.readByteRange).toEqual([{ offset: 0, length: png.byteLength + 1 }])
  })

  it('sniffs the format instead of trusting the extension', async () => {
    // A .png that actually holds a JPEG must be labelled JPEG, or the client
    // fails to decode what it was told to expect.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const { fs } = fakeFileSystem({ '/lying.png': jpeg })
    expect((await driverWith({ fs }).readImage({ path: '/lying.png' })).mimeType).toBe('image/jpeg')

    const gif = fakeFileSystem({ '/a.gif': Buffer.from('GIF89a') })
    expect((await driverWith({ fs: gif.fs }).readImage({ path: '/a.gif' })).mimeType).toBe('image/gif')

    const webp = fakeFileSystem({ '/a.webp': Buffer.from('RIFF\0\0\0\0WEBPVP8 ') })
    expect((await driverWith({ fs: webp.fs }).readImage({ path: '/a.webp' })).mimeType).toBe('image/webp')

    const bmp = fakeFileSystem({ '/a.bmp': Buffer.from('BM\0\0\0\0') })
    expect((await driverWith({ fs: bmp.fs }).readImage({ path: '/a.bmp' })).mimeType).toBe('image/bmp')
  })

  it('refuses non-image content with the supported list', async () => {
    const { fs } = fakeFileSystem({ '/notes.txt': 'plain text, not a picture' })
    await expect(driverWith({ fs }).readImage({ path: '/notes.txt' }))
      .rejects.toThrow(/not an image this tool can carry.*png, jpeg, gif, webp, bmp/s)
  })

  it('refuses a missing file and a directory', async () => {
    const { fs, directories } = fakeFileSystem({})
    directories['/dir'] = []
    const driver = driverWith({ fs })
    await expect(driver.readImage({ path: '/missing.png' })).rejects.toThrow(/does not exist/)
    await expect(driver.readImage({ path: '/dir' })).rejects.toThrow(/is a directory/)
  })

  it('refuses an image over the cap without reading it all into memory', async () => {
    const { fs, calls } = fakeFileSystem({ '/huge.png': Buffer.alloc(9 * 1024 * 1024) })
    await expect(driverWith({ fs }).readImage({ path: '/huge.png' }))
      .rejects.toThrow(/is 9437184 bytes, larger than the .* cap/)
    // The stated size already proves it is too large, so nothing is read at all.
    expect(calls.readByteRange).toEqual([])
  })
})

describe('editFile', () => {
  it('replaces one unique match and reports the sizes', async () => {
    const { fs, calls } = fakeFileSystem({ '/a.ts': 'const a = 1\nconst b = 2\n' })
    const result = await driverWith({ fs }).editFile({
      path: '/a.ts',
      oldText: 'const b = 2',
      newText: 'const b = 3',
      replaceAll: false,
      maxBytes: 1024,
    })
    expect(result).toMatchObject({ path: '/a.ts', replacements: 1 })
    expect(result.bytesBefore).toBe(24)
    expect(result.bytesAfter).toBe(24)
    expect(calls.writes).toEqual(['/a.ts'])
    // The bytes that landed are the edit, not a stale copy of the read.
    await expect(fs.readText(targetFor('/a.ts'))).resolves.toBe('const a = 1\nconst b = 3\n')
  })

  it('refuses an ambiguous match and writes nothing', async () => {
    const { fs, calls } = fakeFileSystem({ '/a.ts': 'x\nx\n' })
    await expect(driverWith({ fs }).editFile({
      path: '/a.ts',
      oldText: 'x',
      newText: 'y',
      replaceAll: false,
      maxBytes: 1024,
    })).rejects.toThrow(/matches 2 times.*replaceAll: true/s)
    // The point of the refusal: the file is untouched.
    expect(calls.writes).toEqual([])
    expect(await fs.readText(targetFor('/a.ts'))).toBe('x\nx\n')
  })

  it('replaces every occurrence when asked', async () => {
    const { fs } = fakeFileSystem({ '/a.ts': 'x\ny\nx\n' })
    const result = await driverWith({ fs }).editFile({
      path: '/a.ts',
      oldText: 'x',
      newText: 'z',
      replaceAll: true,
      maxBytes: 1024,
    })
    expect(result.replacements).toBe(2)
    expect(await fs.readText(targetFor('/a.ts'))).toBe('z\ny\nz\n')
  })

  it('reports a pattern that is not there instead of writing', async () => {
    const { fs, calls } = fakeFileSystem({ '/a.ts': 'hello\n' })
    await expect(driverWith({ fs }).editFile({
      path: '/a.ts',
      oldText: 'goodbye',
      newText: 'hi',
      replaceAll: false,
      maxBytes: 1024,
    })).rejects.toThrow(/oldText was not found/)
    expect(calls.writes).toEqual([])
  })

  it('refuses a missing file, a directory, a no-op and an oversized file', async () => {
    const { fs, directories } = fakeFileSystem({ '/big.txt': 'y'.repeat(100) })
    directories['/dir'] = []
    const driver = driverWith({ fs })
    await expect(driver.editFile({ path: '/missing', oldText: 'a', newText: 'b', replaceAll: false, maxBytes: 1024 }))
      .rejects.toThrow(/does not exist/)
    await expect(driver.editFile({ path: '/dir', oldText: 'a', newText: 'b', replaceAll: false, maxBytes: 1024 }))
      .rejects.toThrow(/is a directory/)
    await expect(driver.editFile({ path: '/big.txt', oldText: 'y', newText: 'y', replaceAll: false, maxBytes: 1024 }))
      .rejects.toThrow(/identical/)
    await expect(driver.editFile({ path: '/big.txt', oldText: 'yy', newText: 'z', replaceAll: false, maxBytes: 10 }))
      .rejects.toThrow(/above the 10-byte edit limit/)
    await expect(driver.editFile({ path: '/big.txt', oldText: '', newText: 'z', replaceAll: false, maxBytes: 1024 }))
      .rejects.toThrow(/must not be empty/)
  })
})

describe('listDirectory recursive', () => {
  function tree(): ReturnType<typeof fakeFileSystem> {
    const fake = fakeFileSystem({
      '/p/a.ts': 'a',
      '/p/sub/b.ts': 'b',
      '/p/sub/deep/c.ts': 'c',
      '/p/.git/config': 'g',
    })
    fake.directories['/p'] = [
      { name: 'a.ts', type: 'file', target: targetFor('/p/a.ts'), size: 1 },
      { name: 'sub', type: 'directory', target: targetFor('/p/sub', 'directory') },
      { name: '.git', type: 'directory', target: targetFor('/p/.git', 'directory') },
    ]
    fake.directories['/p/sub'] = [
      { name: 'b.ts', type: 'file', target: targetFor('/p/sub/b.ts'), size: 1 },
      { name: 'deep', type: 'directory', target: targetFor('/p/sub/deep', 'directory') },
    ]
    fake.directories['/p/sub/deep'] = [
      { name: 'c.ts', type: 'file', target: targetFor('/p/sub/deep/c.ts'), size: 1 },
    ]
    fake.directories['/p/.git'] = [
      { name: 'config', type: 'file', target: targetFor('/p/.git/config'), size: 1 },
    ]
    return fake
  }

  it('walks subdirectories and gives every entry a relative path and depth', async () => {
    const { fs } = tree()
    const result = await driverWith({ fs }).listDirectory({ path: '/p', recursive: true })
    expect(result.path).toBe('/p')
    expect(result.truncated).toBeUndefined()
    expect(result.entries.map((entry) => [entry.path, entry.depth, entry.type])).toEqual([
      ['.git', 1, 'directory'],
      ['.git/config', 2, 'file'],
      ['a.ts', 1, 'file'],
      ['sub', 1, 'directory'],
      ['sub/b.ts', 2, 'file'],
      ['sub/deep', 2, 'directory'],
      ['sub/deep/c.ts', 3, 'file'],
    ])
  })

  it('honours maxDepth without dropping the directory entry itself', async () => {
    const { fs } = tree()
    const result = await driverWith({ fs }).listDirectory({ path: '/p', recursive: true, maxDepth: 1 })
    expect(result.entries.map((entry) => entry.path)).toEqual(['.git', 'a.ts', 'sub'])
  })

  it('visits a directory once even when two links reach it', async () => {
    const { fs, directories } = fakeFileSystem({ '/p/x/f.ts': 'x' })
    // Same targetKey on both names: the seam resolves links, so this is one dir.
    directories['/p'] = [
      { name: 'real', type: 'directory', target: targetFor('/p/x', 'directory') },
      { name: 'link', type: 'directory', target: targetFor('/p/x', 'directory') },
    ]
    directories['/p/x'] = [
      { name: 'f.ts', type: 'file', target: targetFor('/p/x/f.ts'), size: 1 },
    ]
    const result = await driverWith({ fs }).listDirectory({ path: '/p', recursive: true })
    const files = result.entries.filter((entry) => entry.type === 'file')
    expect(files).toHaveLength(1)
  })

  it('stops at the entry cap and says the listing is truncated', async () => {
    const { fs, directories } = fakeFileSystem({})
    directories['/p'] = Array.from({ length: 2_500 }, (_, index) => ({
      name: `f${index}.ts`,
      type: 'file' as const,
      target: targetFor(`/p/f${index}.ts`),
      size: 1,
    }))
    const result = await driverWith({ fs }).listDirectory({ path: '/p', recursive: true })
    expect(result.entries).toHaveLength(2_000)
    expect(result.truncated).toBe(true)
  })
})

describe('shell service shapes and background jobs', () => {
  /** A process handle faithful to `ShellProcess` in 0.1.7+. */
  class FakeProcess {
    status: 'running' | 'completed' | 'killed' = 'running'
    exitCode: number | null = null
    signal: string | null = null
    killed = false
    private chunks: string[] = []
    readonly done: Promise<void>
    private finish!: () => void

    constructor() {
      this.done = new Promise((resolve) => {
        this.finish = resolve
      })
    }

    write(text: string): void {
      this.chunks.push(text)
    }

    settle(exitCode = 0): void {
      if (this.status !== 'running') return
      this.status = 'completed'
      this.exitCode = exitCode
      this.finish()
    }

    readOutput(): { delta: string; lossy: boolean } {
      const delta = this.chunks.join('')
      this.chunks = []
      return { delta, lossy: false }
    }

    kill(): boolean {
      if (this.status !== 'running') return false
      this.killed = true
      this.status = 'killed'
      this.finish()
      return true
    }

    async result(): Promise<{
      exitCode: number | null
      signal: string | null
      timedOut: boolean
      aborted: boolean
      timeoutMs: number
      stdout: { text: string; truncated: boolean }
      stderr: { text: string; truncated: boolean }
    }> {
      await this.done
      return {
        exitCode: this.exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 1_000,
        stdout: { text: 'final stdout', truncated: false },
        stderr: { text: '', truncated: false },
      }
    }
  }

  /** A shell double exposing the shape under test. */
  function shellShape(
    mode: 'run' | 'execute' | 'start' | 'none',
    options: { settleImmediately?: boolean } = {},
  ): {
    shell: Record<string, unknown>
    processes: FakeProcess[]
    specs: Record<string, unknown>[]
  } {
    const processes: FakeProcess[] = []
    const specs: Record<string, unknown>[] = []
    const make = (): FakeProcess => {
      const process = new FakeProcess()
      processes.push(process)
      // A foreground command has already exited by the time the caller awaits
      // `result()`; modelling that keeps this double honest.
      if (options.settleImmediately === true) process.settle()
      return process
    }
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1_000,
      stdout: { text: 'run stdout', truncated: false },
      stderr: { text: '', truncated: false },
    }
    const shell: Record<string, unknown> = {
      resolve: (spec: Record<string, unknown>) => {
        specs.push(spec)
        return spec
      },
    }
    if (mode === 'run') shell.run = async () => result
    if (mode === 'execute') shell.execute = async () => make()
    if (mode === 'start') shell.start = () => make()
    return { shell, processes, specs }
  }

  it('awaits the foreground projection when execute() returns a live handle', async () => {
    // The 0.2.1 regression: `execute` resolves a process handle, not a result.
    // Reading the handle's own `stdout` is undefined and used to crash shell_run.
    const { shell } = shellShape('execute', { settleImmediately: true })
    const result = await driverWith({ shell }).runShell({ command: 'true', timeoutMs: 1_000 })
    expect(result.stdout).toBe('final stdout')
    expect(result.exitCode).toBe(0)
  })

  it('accepts the older run() shape that resolves the result directly', async () => {
    const { shell } = shellShape('run')
    const result = await driverWith({ shell }).runShell({ command: 'true', timeoutMs: 1_000 })
    expect(result.stdout).toBe('run stdout')
  })

  it('names the missing capability when the shell service has no launcher', async () => {
    const { shell } = shellShape('none')
    await expect(driverWith({ shell }).runShell({ command: 'true', timeoutMs: 1_000 }))
      .rejects.toThrow(/neither run\(\) nor execute\(\)/)
  })

  it('starts, reads and finishes a background job', async () => {
    const { shell, processes, specs } = shellShape('execute')
    const driver = driverWith({ shell })
    const job = await driver.startShellJob({ command: 'make -j8', cwd: '/tmp/project' })

    expect(job.status).toBe('running')
    expect(job.command).toBe('make -j8')
    expect(job.cwd).toBe('/tmp/project')
    // A background job arms no deadline unless the caller asked for a watchdog.
    expect(specs[0]).toMatchObject({ command: 'make -j8', workdir: '/tmp/project', onExpiry: 'none' })

    const process = processes[0] as FakeProcess
    process.write('line one\n')
    expect(driver.readShellOutput({ jobId: job.jobId })).toMatchObject({
      output: 'line one\n',
      done: false,
      pendingBytes: 0,
    })

    process.write('line two\n')
    process.settle(2)
    const last = driver.readShellOutput({ jobId: job.jobId })
    expect(last).toMatchObject({ output: 'line two\n', done: true, exitCode: 2, status: 'completed' })

    // Output is delivered once, and the final page is empty rather than repeated.
    expect(driver.readShellOutput({ jobId: job.jobId }).output).toBe('')
    expect(driver.listShellJobs()[0]).toMatchObject({ jobId: job.jobId, status: 'completed', exitCode: 2 })
  })

  it('reports lossy when the shell service itself dropped bytes', async () => {
    const { shell, processes } = shellShape('execute')
    const driver = driverWith({ shell })
    const job = await driver.startShellJob({ command: 'yes' })
    const process = processes[0] as FakeProcess
    // What the service retained, with its own loss flag: the page must not claim
    // the bytes were all delivered just because our buffer was never trimmed.
    ;(process as unknown as { readOutput: () => { delta: string; lossy: boolean } }).readOutput = () => ({
      delta: 'survivor',
      lossy: true,
    })
    expect(driver.readShellOutput({ jobId: job.jobId })).toMatchObject({
      output: 'survivor',
      truncated: true,
      lossy: true,
    })
  })

  it('starts a job through the 0.1.5 start() shape', async () => {
    const { shell, processes } = shellShape('start')
    // One driver, so the job started through it is the job read back from it.
    const driver = driverWith({ shell })
    const job: { jobId: string } = await driver.startShellJob({ command: 'sleep 1' })
    ;(processes[0] as FakeProcess).write('older host output')
    expect(driver.readShellOutput({ jobId: job.jobId }).output).toBe('older host output')
  })

  it('kills a running job and keeps its remaining output readable', async () => {
    const { shell, processes } = shellShape('execute')
    const driver = driverWith({ shell })
    const job = await driver.startShellJob({ command: 'tail -f log' })
    ;(processes[0] as FakeProcess).write('before kill\n')

    const killed = await driver.killShellJob({ jobId: job.jobId, waitMs: 100 })
    expect(killed).toMatchObject({ killed: true, status: 'killed' })
    expect((processes[0] as FakeProcess).killed).toBe(true)
    expect(driver.readShellOutput({ jobId: job.jobId })).toMatchObject({
      output: 'before kill\n',
      done: true,
      status: 'killed',
    })

    // Idempotent: a settled job reports that nothing was killed.
    expect(await driver.killShellJob({ jobId: job.jobId })).toMatchObject({ killed: false, status: 'killed' })
  })

  it('kills a job when its watchdog expires', async () => {
    const { shell, processes } = shellShape('execute')
    const driver = driverWith({ shell })
    await driver.startShellJob({ command: 'sleep 100', timeoutMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect((processes[0] as FakeProcess).status).toBe('killed')
    expect(driver.listShellJobs()[0]?.status).toBe('killed')
  })

  it('filters the job list by running state', async () => {
    const { shell, processes } = shellShape('execute')
    const driver = driverWith({ shell })
    const finished = await driver.startShellJob({ command: 'true' })
    const running = await driver.startShellJob({ command: 'sleep 100' })
    ;(processes[0] as FakeProcess).settle(0)

    expect(driver.listShellJobs({ running: true }).map((job) => job.jobId)).toEqual([running.jobId])
    expect(driver.listShellJobs({ running: false }).map((job) => job.jobId)).toEqual([finished.jobId])
    // Absent means everything.
    expect(driver.listShellJobs()).toHaveLength(2)
  })

  it('refuses an unknown job id with a pointer to shell_list', async () => {
    const { shell } = shellShape('execute')
    const driver = driverWith({ shell })
    expect(() => driver.readShellOutput({ jobId: 'nope' })).toThrow(/unknown background job "nope".*shell_list/)
    await expect(driver.killShellJob({ jobId: 'nope' })).rejects.toThrow(/shell_list/)
  })

  it('bounds per-call output and reports what is still pending', async () => {
    const { shell, processes } = shellShape('execute')
    const driver = driverWith({ shell })
    const job = await driver.startShellJob({ command: 'yes' })
    ;(processes[0] as FakeProcess).write('x'.repeat(100))
    const page = driver.readShellOutput({ jobId: job.jobId, maxBytes: 30 })
    expect(page.output).toHaveLength(30)
    expect(page.pendingBytes).toBe(70)
    expect(driver.readShellOutput({ jobId: job.jobId, maxBytes: 1_000 }).output).toBe('x'.repeat(70))
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
    expect(outcome).toMatchObject({ path: '/present/out.txt', operation: 'create' })
    expect(outcome.sha256).toMatch(/^[0-9a-f]{64}$/)
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

describe('compare-and-swap file writes', () => {
  /** A single-file seam whose content the test owns. */
  function fsWithFile(content: string | undefined): {
    fs: DshFileSystem
    read: () => string | undefined
    writes: string[]
  } {
    let current = content
    const writes: string[] = []
    const fs: DshFileSystem = {
      resolve: async (path: string) => targetFor(path),
      processPath: (entry: DshFsTarget) => entry.displayPath,
      stat: async () => (current === undefined ? undefined : { type: 'file' as const, size: current.length }),
      readText: async () => {
        if (current === undefined) throw new Error('ENOENT')
        return current
      },
      readByteRange: async () => new Uint8Array(),
      listDir: async () => [],
      writeText: async (_target: DshFsTarget, text: string) => {
        writes.push(text)
        current = text
        return { operation: 'update' as const }
      },
    }
    return { fs, read: () => current, writes }
  }

  it('writes only when the current content hashes to expectedSha256, and returns the new hash', async () => {
    const sha256 = createHash('sha256')
    const oldHash = sha256.update('old content', 'utf8').digest('hex')
    const { fs, read, writes } = fsWithFile('old content')
    const driver = driverWith({ fs })
    const outcome = await driver.writeFile({
      path: '/project/a.ts',
      content: 'new content',
      createDirectories: true,
      expectedSha256: oldHash,
    })
    expect(outcome.sha256).toBe(createHash('sha256').update('new content', 'utf8').digest('hex'))
    expect(read()).toBe('new content')
    expect(writes).toEqual(['new content'])
  })

  it('refuses a mismatched expectedSha256 and names the actual hash', async () => {
    const { fs, read, writes } = fsWithFile('old content')
    const actual = createHash('sha256').update('old content', 'utf8').digest('hex')
    const driver = driverWith({ fs })
    await expect(driver.writeFile({
      path: '/project/a.ts',
      content: 'new content',
      createDirectories: true,
      expectedSha256: 'a'.repeat(64),
    })).rejects.toThrow(new RegExp(`current sha256 is ${actual}`))
    expect(read()).toBe('old content')
    expect(writes).toEqual([])
  })

  it('refuses expectedSha256 when the file does not exist yet', async () => {
    const { fs, writes } = fsWithFile(undefined)
    const driver = driverWith({ fs })
    await expect(driver.writeFile({
      path: '/project/a.ts',
      content: 'x',
      createDirectories: true,
      expectedSha256: 'b'.repeat(64),
    })).rejects.toThrow(/file does not exist/)
    expect(writes).toEqual([])
  })
})

describe('compare-and-swap file edits', () => {
  function fsWithFile(content: string): { fs: DshFileSystem; read: () => string; writes: string[] } {
    let current = content
    const writes: string[] = []
    const fs: DshFileSystem = {
      resolve: async (path: string) => targetFor(path),
      processPath: (entry: DshFsTarget) => entry.displayPath,
      stat: async () => ({ type: 'file' as const, size: current.length }),
      readText: async () => current,
      readByteRange: async () => new Uint8Array(),
      listDir: async () => [],
      writeText: async (_target: DshFsTarget, text: string) => {
        writes.push(text)
        current = text
        return { operation: 'update' as const }
      },
    }
    return { fs, read: () => current, writes }
  }

  it('edits only when the file hashes to expectedSha256, and returns the new hash', async () => {
    const before = 'const a = 1\n'
    const expected = createHash('sha256').update(before, 'utf8').digest('hex')
    const { fs, read } = fsWithFile(before)
    const outcome = await driverWith({ fs }).editFile({
      path: '/project/a.ts',
      oldText: '1',
      newText: '2',
      replaceAll: false,
      maxBytes: 1_000,
      expectedSha256: expected,
    })
    expect(read()).toBe('const a = 2\n')
    expect(outcome.sha256).toBe(createHash('sha256').update('const a = 2\n', 'utf8').digest('hex'))
  })

  it('refuses a stale expectedSha256 and writes nothing', async () => {
    const { fs, read, writes } = fsWithFile('const a = 1\n')
    await expect(driverWith({ fs }).editFile({
      path: '/project/a.ts',
      oldText: '1',
      newText: '2',
      replaceAll: false,
      maxBytes: 1_000,
      expectedSha256: 'c'.repeat(64),
    })).rejects.toThrow(/refusing to edit .*current sha256 is/)
    expect(read()).toBe('const a = 1\n')
    expect(writes).toEqual([])
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
