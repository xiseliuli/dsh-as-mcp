import { describe, expect, it } from 'vitest'

import { testConfig } from './harness.js'
import { DshDriver } from '../src/dsh/driver.js'
import type { DshSessionController } from '../src/dsh/types.js'

/** A driver whose controller accepts the routes listed in `routable`. */
function driverWith(routable: Set<string>, knownRoutes: string[] = ['opencode-go-xise', 'deepseek-official']): {
  driver: DshDriver
  calls: unknown[]
} {
  const calls: unknown[] = []
  const controller = {
    selectModel: async (request: {
      sessionId: string
      provider: string
      model: string
      reasoningEffort?: string
    }) => {
      calls.push(request)
      if (!routable.has(`${request.provider}/${request.model}`)) {
        throw new Error('Select an available model before sending a message.')
      }
      return { selected: { provider: request.provider, model: request.model } }
    },
  } as unknown as DshSessionController
  const llm = {
    listProviders: () => knownRoutes.map((id) => ({ id, name: id })),
  }
  const ctx = {
    get: (name: string) => (name === 'sessionController' ? controller : name === 'llm' ? llm : undefined),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }
  return { driver: new DshDriver(ctx, () => testConfig()), calls }
}

describe('setSessionModel', () => {
  it('switches the route and reports what was applied', async () => {
    const { driver, calls } = driverWith(new Set(['opencode-go-xise/deepseek-v4.1-pro']))
    const applied = await driver.setSessionModel({
      sessionId: 'session-1',
      provider: 'opencode-go-xise',
      model: 'deepseek-v4.1-pro',
      reasoningEffort: 'high',
    })

    expect(calls).toEqual([{
      sessionId: 'session-1',
      provider: 'opencode-go-xise',
      model: 'deepseek-v4.1-pro',
      reasoningEffort: 'high',
    }])
    expect(applied).toEqual({
      sessionId: 'session-1',
      provider: 'opencode-go-xise',
      model: 'deepseek-v4.1-pro',
      reasoningEffort: 'high',
    })
  })

  it('omits reasoningEffort when the caller did not set one', async () => {
    const { driver, calls } = driverWith(new Set(['deepseek-official/deepseek-flash']))
    const applied = await driver.setSessionModel({
      sessionId: 'session-1',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    })
    expect(calls[0]).not.toHaveProperty('reasoningEffort')
    expect(applied).not.toHaveProperty('reasoningEffort')
  })

  it('refuses a bad model with the requested pair and the routes that exist', async () => {
    const { driver } = driverWith(new Set())
    await expect(driver.setSessionModel({
      sessionId: 'session-1',
      provider: 'deepseek-official',
      model: 'no-such-model',
    })).rejects.toThrow(
      /Select an available model.*requested provider "deepseek-official" model "no-such-model".*known routes: opencode-go-xise, deepseek-official.*includeModels: true/s,
    )
  })

  it('says when the provider route itself is unregistered', async () => {
    const { driver } = driverWith(new Set())
    await expect(driver.setSessionModel({
      sessionId: 'session-1',
      provider: 'nope',
      model: 'x',
    })).rejects.toThrow(/"nope" is not a registered provider route/)
  })
})
