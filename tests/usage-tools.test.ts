import { afterEach, describe, expect, it } from 'vitest'

import { boot, callTool, readJsonRpc, rpc, stubDriver, testConfig } from './harness.js'
import type { SessionUsageReport } from '../src/dsh/driver.js'
import type { McpDriver } from '../src/mcp/tools.js'

/** A report the stub hands back, so the tool layer is tested in isolation. */
function fixtureReport(): SessionUsageReport {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    scope: 'session',
    sessions: [{
      sessionId: 'session-1',
      origin: 'self',
      usage: {
        totals: {
          uncachedInputTokens: 100,
          cacheReadTokens: 900,
          cacheWriteTokens: 0,
          outputTokens: 20,
          totalTokens: 1020,
        },
        byModel: [],
        turns: 1,
        steps: 2,
        samples: 2,
        verifiedAgainstProjection: true,
        byTurn: [],
      },
      cost: { available: false, reason: 'no price source' },
    }],
    totals: {
      uncachedInputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      outputTokens: 20,
      totalTokens: 1020,
      turns: 1,
      steps: 2,
      samples: 2,
    },
    byModel: [],
    subagentsIncluded: false,
    cost: { available: false, reason: 'no price source' },
    notes: [],
  }
}

/** Boot one endpoint around a driver that records the usage calls it receives. */
async function bootUsage(config = testConfig({ usage: true })): Promise<{
  url: string
  calls: unknown[]
  stop: () => Promise<void>
}> {
  const calls: unknown[] = []
  const driver: McpDriver = stubDriver({
    sessionUsage: async (request) => {
      calls.push(request)
      return fixtureReport()
    },
    describeCapabilities: () => ({ sessionController: true, tokenUsage: true, costMeter: false }),
  })
  const booted = await boot(driver, config)
  return { url: booted.url, calls, stop: booted.stop }
}

/** The tool names one endpoint advertises. */
async function toolNames(url: string): Promise<string[]> {
  const body = (await readJsonRpc(await rpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  }), 1)) as { result?: { tools?: { name: string }[] } }
  return (body.result?.tools ?? []).map((tool) => tool.name)
}

describe('session_usage tool', () => {
  const stops: (() => Promise<void>)[] = []
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()))
  })

  async function start(config = testConfig({ usage: true })) {
    const booted = await bootUsage(config)
    stops.push(booted.stop)
    return booted
  }

  it('is listed only when the usage group is enabled', async () => {
    const enabled = await start()
    expect(await toolNames(enabled.url)).toContain('session_usage')

    const disabled = await start(testConfig())
    expect(await toolNames(disabled.url)).not.toContain('session_usage')
  })

  it('forwards a session-scoped request and returns the report payload', async () => {
    const endpoint = await start()
    const { isError, text } = await callTool(endpoint.url, 'session_usage', { sessionId: 'session-1' })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toMatchObject({
      scope: 'session',
      totals: { totalTokens: 1020, turns: 1 },
      sessions: [{ sessionId: 'session-1', origin: 'self' }],
    })
    expect(endpoint.calls).toEqual([{ sessionId: 'session-1', limit: 20 }])
  })

  it('defaults limit for an unscoped scan and forwards the flags', async () => {
    const endpoint = await start()
    await callTool(endpoint.url, 'session_usage', { all: true, includeTurns: true, includeSubagents: false })
    expect(endpoint.calls).toEqual([{ all: true, includeTurns: true, includeSubagents: false, limit: 20 }])
  })

  it('rejects a limit above the cap', async () => {
    const endpoint = await start()
    const { isError, text } = await callTool(endpoint.url, 'session_usage', { limit: 500 })
    expect(isError).toBe(true)
    expect(text).toContain('limit')
  })

  it('reports usage capability and the tool name in dsh_info', async () => {
    const endpoint = await start()
    const { text } = await callTool(endpoint.url, 'dsh_info', {})
    const info = JSON.parse(text) as {
      usage: { reported: boolean; tool: string | null; tokensReadable: boolean; costAvailable: boolean }
      harnessServices: Record<string, boolean>
    }
    expect(info.usage).toMatchObject({
      reported: true,
      tool: 'session_usage',
      tokensReadable: true,
      costAvailable: false,
    })
    expect(info.harnessServices['tokenUsage']).toBe(true)
    expect(info.harnessServices['costMeter']).toBe(false)
  })

  it('reports usage as absent from dsh_info when the group is off', async () => {
    const endpoint = await start(testConfig())
    const { text } = await callTool(endpoint.url, 'dsh_info', {})
    const info = JSON.parse(text) as { usage: { reported: boolean; tool: string | null } }
    expect(info.usage).toMatchObject({ reported: false, tool: null })
  })
})
