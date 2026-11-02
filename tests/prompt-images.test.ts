import { describe, expect, it } from 'vitest'

import { testConfig } from './harness.js'
import { DshDriver } from '../src/dsh/driver.js'
import type { DshFsTarget, DshSessionController, DshSessionEvent, DshSessionQuery } from '../src/dsh/types.js'

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A BMP header — displayable, but not a prompt attachment format. */
const BMP = Buffer.from('BM\0\0\0\0')

/** Minimal filesystem double exposing the bytes it is given. */
function fakeFs(files: Record<string, Buffer>): Record<string, unknown> {
  const target = (path: string): DshFsTarget => ({ displayPath: path, targetKey: path } as unknown as DshFsTarget)
  return {
    resolve: async (path: string) => target(path),
    processPath: (value: DshFsTarget) => value.displayPath,
    stat: async (value: DshFsTarget) => {
      const bytes = files[value.displayPath]
      return bytes === undefined
        ? undefined
        : { type: 'file' as const, size: bytes.byteLength }
    },
    readByteRange: async (value: DshFsTarget, range: { offset: number; length: number }) =>
      new Uint8Array((files[value.displayPath] as Buffer).subarray(range.offset, range.offset + range.length)),
  }
}

/**
 * A harness that records the prompt it accepted and answers with a settled turn —
 * unless `settle` is false, in which case the turn stays open for the abort test.
 */
function harness(files: Record<string, Buffer>, options: { settle?: boolean } = {}): {
  ctx: unknown
  prompts: { content: unknown[] }[]
} {
  const log: DshSessionEvent[] = []
  const prompts: { content: unknown[] }[] = []
  let seq = 0
  const append = (type: string, data: unknown): void => {
    log.push({ type, data, seq, time: 1_700_000_000_000 + seq })
    seq += 1
  }

  const controller = {
    create: async () => ({ sessionId: 'session-1' }),
    list: async () => ({ items: [] }),
    selectModel: async (request: { provider: string; model: string }) => ({
      selected: { provider: request.provider, model: request.model },
    }),
    prompt: async (request: { requestId: string; content: unknown[] }) => {
      prompts.push({ content: request.content })
      append('user/message', {
        role: 'user',
        content: request.content,
        source: { kind: 'user', rpcId: request.requestId },
      })
      if (options.settle === false) return
      append('turn/start', { turn: 1 })
      append('assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'seen' }] },
      })
      append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    },
    cancel: () => ({ accepted: true }),
    inspect: async () => ({ meta: { id: 'session-1' }, inheritedEventCount: 0, events: log }),
    resolveAgent: async () => ({ error: new Error('not needed') }),
  } as unknown as DshSessionController

  const query: DshSessionQuery = {
    readSession: async () => ({ session: { id: 'session-1' }, inheritedEventCount: 0, events: [...log] }),
  }

  return {
    prompts,
    ctx: {
      get: (name: string) => (name === 'sessionController'
        ? controller
        : name === 'sessionQuery' ? query : name === 'fs' ? fakeFs(files) : undefined),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      on: () => () => {},
    },
  }
}

describe('session_prompt images', () => {
  it('attaches images after the text, as base64 content parts', async () => {
    const fake = harness({ '/shots/pixel.png': PNG })
    const driver = new DshDriver(fake.ctx, () => testConfig())

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'what is in this screenshot?',
      images: [{ path: '/shots/pixel.png' }],
      mode: 'queue',
      wait: true,
    })

    expect(reply.turn?.reply).toBe('seen')
    const content = fake.prompts[0]?.content as {
      type: string
      text?: string
      mediaType?: string
      data?: string
      name?: string
    }[]
    expect(content[0]).toEqual({ type: 'text', text: 'what is in this screenshot?' })
    expect(content[1]).toEqual({
      type: 'image',
      mediaType: 'image/png',
      data: PNG.toString('base64'),
      name: 'pixel.png',
    })
  })

  it('accepts an image-only prompt', async () => {
    const fake = harness({ '/a.png': PNG })
    const driver = new DshDriver(fake.ctx, () => testConfig())

    await driver.promptSession({
      sessionId: 'session-1',
      prompt: '',
      images: [{ path: '/a.png' }],
      mode: 'queue',
      wait: true,
    })

    const content = fake.prompts[0]?.content as { type: string }[]
    // Nothing blank is sent as text; the image is the message.
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ type: 'image' })
  })

  it('refuses a message that is empty in every way', async () => {
    const fake = harness({})
    const driver = new DshDriver(fake.ctx, () => testConfig())
    await expect(driver.promptSession({
      sessionId: 'session-1',
      prompt: '   ',
      mode: 'queue',
      wait: true,
    })).rejects.toThrow(/needs non-empty text or at least one image/)
    expect(fake.prompts).toHaveLength(0)
  })

  it('refuses a format a prompt cannot carry, naming what it can', async () => {
    const fake = harness({ '/a.bmp': BMP })
    const driver = new DshDriver(fake.ctx, () => testConfig())
    await expect(driver.promptSession({
      sessionId: 'session-1',
      prompt: 'look',
      images: [{ path: '/a.bmp' }],
      mode: 'queue',
      wait: true,
    })).rejects.toThrow(/image\/bmp.*cannot carry.*png, jpeg, webp, gif/s)
  })

  it('refuses more than four images before reading any of them', async () => {
    const fake = harness({ '/a.png': PNG })
    const driver = new DshDriver(fake.ctx, () => testConfig())
    await expect(driver.promptSession({
      sessionId: 'session-1',
      prompt: 'look',
      images: Array.from({ length: 5 }, () => ({ path: '/a.png' })),
      mode: 'queue',
      wait: true,
    })).rejects.toThrow(/at most 4 images; this one has 5/)
    expect(fake.prompts).toHaveLength(0)
  })
})

describe('session_prompt abort', () => {
  it('stops waiting when the request is cancelled and reports it', async () => {
    const fake = harness({}, { settle: false })
    const driver = new DshDriver(fake.ctx, () => testConfig())
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    const reply = await driver.promptSession({
      sessionId: 'session-1',
      prompt: 'something long',
      mode: 'queue',
      wait: true,
      signal: controller.signal,
    })

    // The turn did not settle, so the answer is partial — and it says why.
    expect(reply.turn?.aborted).toBe(true)
    expect(reply.turn?.timedOut).toBe(false)
    // Nothing was answered, so there is no reply text to misread as the result.
    expect(reply.turn?.reply).toBe('')
  })
})
