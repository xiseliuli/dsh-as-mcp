import { afterEach, describe, expect, it } from 'vitest'

import { boot, callTool, stubDriver, testConfig } from './harness.js'
import { DshDriver } from '../src/dsh/driver.js'
import { VERSION } from '../src/version.js'

/** A Cordis-shaped context whose `get(name)` returns the given services. */
function contextWith(services: Record<string, unknown>): {
  get(name: string): unknown
  logger: { debug(): void; info(): void; warn(): void; error(): void }
} {
  return {
    get: (name) => services[name],
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }
}

/** A driver over those services. */
function driverWith(services: Record<string, unknown>): DshDriver {
  return new DshDriver(contextWith(services), () => testConfig())
}

/** The services a full desktop profile provides, in the shapes the driver reads. */
function fullServices(): Record<string, unknown> {
  return {
    llm: {
      listProviders: () => [
        { id: 'opencode-go-xise', name: 'opencode-go-xise' },
        { id: 'deepseek-official', name: 'DeepSeek' },
        // A malformed entry must be filtered, not forwarded.
        { id: '', name: 'broken' },
        { id: 'no-name' },
      ],
      listModels: async (provider: string) => (provider === 'opencode-go-xise'
        ? [
          { provider, id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
          { provider, id: 'deepseek-v4.1-pro', name: 'DeepSeek V4.1 Pro', description: 'deeper' },
          // Invalid entries are dropped, like provider entries above.
          { provider, id: '', name: 'broken' },
          { provider, id: 'no-name' },
        ]
        : [{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
    },
    agentPresets: {
      defaultId: 'standard',
      list: async () => [
        { id: 'standard', name: 'Standard', description: 'default coding agent' },
        { id: 'cordis', name: 'Cordis' },
        { id: 'broken-preset', broken: 'missing dependency' },
        { id: '', name: 'nameless' },
      ],
    },
    permissionPresets: { names: ['read-only', 'workspace-write', 'danger-full-access'] },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 'a' }, { sessionId: 'b' }] }),
    },
  }
}

describe('DshDriver.describeCatalog', () => {
  it('reads the choices the deployment actually accepts', async () => {
    const catalog = await driverWith(fullServices()).describeCatalog()

    expect(catalog.sessionCount).toBe(2)
    // Invalid entries are dropped: an empty id can never be passed to session_create.
    expect(catalog.providers).toEqual([
      { id: 'opencode-go-xise', name: 'opencode-go-xise' },
      { id: 'deepseek-official', name: 'DeepSeek' },
    ])
    expect(catalog.agentPresets).toEqual([
      { id: 'standard', name: 'Standard', description: 'default coding agent' },
      { id: 'cordis', name: 'Cordis' },
      { id: 'broken-preset', broken: 'missing dependency' },
    ])
    expect(catalog.defaultAgentPreset).toBe('standard')
    expect(catalog.sandboxMode).toBe('danger-full-access')
    expect(catalog.permissionPresets).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(catalog.unavailable).toBeUndefined()
  })

  it('lists each route\'s advertised models only when asked', async () => {
    const catalog = await driverWith(fullServices()).describeCatalog({ includeModels: true })

    expect(catalog.providerModels).toEqual([
      {
        provider: 'opencode-go-xise',
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
          { id: 'deepseek-v4.1-pro', name: 'DeepSeek V4.1 Pro', description: 'deeper' },
        ],
      },
      { provider: 'deepseek-official', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    ])

    // The default page must not trigger adapter discovery at all.
    const plain = await driverWith(fullServices()).describeCatalog()
    expect(plain.providerModels).toBeUndefined()
  })

  it('records one provider\'s discovery failure without losing the rest', async () => {
    const services = fullServices()
    Object.assign(services, {
      llm: {
        listProviders: () => [
          { id: 'good', name: 'Good' },
          { id: 'bad', name: 'Bad' },
        ],
        listModels: async (provider: string) => {
          if (provider === 'bad') throw new Error('adapter refused')
          return [{ provider, id: 'm', name: 'M' }]
        },
      },
    })
    const catalog = await driverWith(services).describeCatalog({ includeModels: true })

    expect(catalog.providerModels).toEqual([{ provider: 'good', models: [{ id: 'm', name: 'M' }] }])
    expect(catalog.unavailable?.join('\n')).toMatch(/providerModels\[bad\]: adapter refused/)
  })

  it('says so when the llm service cannot list models', async () => {
    const services = fullServices()
    Object.assign(services, {
      llm: { listProviders: () => [{ id: 'p', name: 'P' }] },
    })
    const catalog = await driverWith(services).describeCatalog({ includeModels: true })
    expect(catalog.providerModels).toBeUndefined()
    expect(catalog.unavailable?.join('\n')).toMatch(/providerModels: the llm service exposes no listModels/)
  })

  it('names every read it could not answer instead of failing the diagnostic', async () => {
    const catalog = await driverWith({}).describeCatalog()

    expect(catalog).not.toHaveProperty('providers')
    expect(catalog).not.toHaveProperty('agentPresets')
    expect(catalog).not.toHaveProperty('sandboxMode')
    expect(catalog).not.toHaveProperty('permissionPresets')
    expect(catalog).not.toHaveProperty('sessionCount')
    expect(catalog.unavailable?.length).toBeGreaterThanOrEqual(5)
    expect(catalog.unavailable?.join('\n')).toMatch(/providers: this profile provides no llm service/)
    expect(catalog.unavailable?.join('\n')).toMatch(/agentPresets: this profile provides no agentPresets service/)
  })

  it('keeps the reads that work when another one throws', async () => {
    const services = {
      ...fullServices(),
      agentPresets: {
        defaultId: 'standard',
        list: async () => {
          throw new Error('preset registry is still loading')
        },
      },
      permissionPresets: {
        get names(): readonly string[] {
          throw new Error('permission presets unavailable')
        },
      },
      sessionController: {
        list: async () => {
          throw new Error('corpus is unavailable')
        },
      },
    }
    const catalog = await driverWith(services).describeCatalog()

    expect(catalog.providers?.length).toBe(2)
    expect(catalog.sandboxMode).toBe('danger-full-access')
    const unavailable = catalog.unavailable?.join('\n') ?? ''
    expect(unavailable).toMatch(/agentPresets: preset registry is still loading/)
    expect(unavailable).toMatch(/permissionPresets: permission presets unavailable/)
    expect(unavailable).toMatch(/sessionCount: corpus is unavailable/)
  })

  it('treats a service without the catalog method as unavailable, not fatal', async () => {
    const catalog = await driverWith({ llm: {}, agentPresets: {}, permissionPresets: {} }).describeCatalog()
    const unavailable = catalog.unavailable?.join('\n') ?? ''
    expect(unavailable).toMatch(/providers: the llm service exposes no listProviders/)
    expect(unavailable).toMatch(/agentPresets: the registry exposes no list/)
    expect(unavailable).toMatch(/permissionPresets: the service reports no names/)
  })
})

describe('dsh_info catalog and version', () => {
  const stops: (() => Promise<void>)[] = []
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()))
  })

  it('advertises the plugin version, uptime and the catalog', async () => {
    const seen: unknown[] = []
    const endpoint = await boot(stubDriver({
      describeCatalog: async (options) => {
        seen.push(options)
        return ({
        sessionCount: 3,
        providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
        agentPresets: [{ id: 'standard', name: 'Standard' }],
        defaultAgentPreset: 'standard',
        sandboxMode: 'workspace-write',
        unavailable: ['permissionPresets: this profile provides no permissionPresets service'],
        })
      },
    }))
    stops.push(endpoint.stop)

    // The models block is opt-in; the default call must not ask for it.
    const { isError, text } = await callTool(endpoint.url, 'dsh_info', {})
    expect(isError).toBe(false)
    const info = JSON.parse(text) as {
      version: string
      uptimeMs: number
      catalog: {
        sessionCount: number
        providers: { id: string }[]
        agentPresets: { id: string }[]
        defaultAgentPreset: string
        sandboxMode: string
        unavailable: string[]
      }
      harnessServices: Record<string, boolean>
      config: {
        tools: Record<string, boolean>
        limits: {
          maxReadBytes: number
          shellTimeoutMs: number
          agentToolTimeoutMs: number
          promptTimeoutMs: number
        }
        approval: string
        session: Record<string, string>
      }
      health: { node: string; platform: string; rssMb: number; heapUsedMb: number }
      notes: string[]
    }

    expect(info.version).toBe(VERSION)
    expect(info.uptimeMs).toBeGreaterThan(0)
    expect(info.catalog.sessionCount).toBe(3)
    expect(info.catalog.providers).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
    expect(info.catalog.agentPresets).toEqual([{ id: 'standard', name: 'Standard' }])
    expect(info.catalog.defaultAgentPreset).toBe('standard')
    expect(info.catalog.sandboxMode).toBe('workspace-write')
    expect(info.catalog.unavailable?.[0]).toContain('permissionPresets')
    expect(info.notes.some((note) => note.includes('catalog.providers'))).toBe(true)
    // Effective settings a caller can act on, and endpoint health.
    // Capability probes exist for the controller operations callers rely on.
    expect(info.harnessServices.sessionFork).toBe(false)
    expect(info.harnessServices.sessionRename).toBe(false)
    expect(info.harnessServices.approval).toBe(false)
    expect(info.config.limits.maxReadBytes).toBe(testConfig().limits.maxReadBytes)
    expect(info.config.limits.promptTimeoutMs).toBe(testConfig().session.promptTimeoutMs)
    expect(info.config.tools.usage).toBe(testConfig().tools.usage)
    expect(info.config.approval).toBe(testConfig().approval.policy)
    expect(typeof info.health.node).toBe('string')
    expect(info.health.rssMb).toBeGreaterThan(0)
    // The bearer token itself must never appear in a diagnostic payload.
    expect(text).not.toContain(testConfig().auth.token)

    await callTool(endpoint.url, 'dsh_info', { includeModels: true })
    expect(seen).toEqual([{}, { includeModels: true }])
  })
})
