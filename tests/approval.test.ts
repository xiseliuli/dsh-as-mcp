import { describe, expect, it } from 'vitest'

import { testConfig } from './harness.js'
import { DshDriver } from '../src/dsh/driver.js'
import type { Config } from '../src/config.js'
import type { DshSessionController } from '../src/dsh/types.js'

/**
 * The approval policy is a documented configuration knob, so it needs the same
 * treatment as the rest: applied where documented, reported when it cannot be, and
 * harmless when it is the default.
 */

/** A config with the approval policy under test. */
function configWithApproval(policy: 'inherit' | 'allow' | 'human'): Config {
  return { ...testConfig(), approval: { ...testConfig().approval, policy } }
}

/** A driver whose controller resolves an agent and whose approval service records calls. */
function driverWith(options: {
  policy: 'inherit' | 'allow'
  resolution?: { agent: unknown } | { error: Error }
  hasApprovalService?: boolean
}): {
  driver: DshDriver
  policies: { agent: unknown; policy: string }[]
  controller: DshSessionController
} {
  const policies: { agent: unknown; policy: string }[] = []
  const agent = { session: { id: 'session-1' } }
  const controller = {
    create: async () => ({ sessionId: 'session-1', agentPreset: 'standard' }),
    list: async () => ({ items: [] }),
    selectModel: async (request: { provider: string; model: string }) => ({
      selected: { provider: request.provider, model: request.model },
    }),
    resolveAgent: async () => options.resolution ?? { agent },
    fork: async () => ({ sessionId: 'session-child' }),
    prompt: async () => ({ accepted: true }),
    cancel: () => ({ accepted: true }),
    inspect: async () => ({ meta: { id: 'session-1' }, inheritedEventCount: 0, events: [] }),
  } as unknown as DshSessionController

  const approval = {
    setPolicy: (target: unknown, policy: string) => {
      policies.push({ agent: target, policy })
    },
  }
  const query = {
    readSession: async () => ({ session: { id: 'session-1' }, inheritedEventCount: 0, events: [] }),
  }
  const ctx = {
    get: (name: string) => (name === 'sessionController'
      ? controller
      : name === 'sessionQuery' ? query : name === 'approval' && options.hasApprovalService !== false ? approval : undefined),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  }
  return { driver: new DshDriver(ctx, () => configWithApproval(options.policy)), policies, controller }
}

describe('approval.policy', () => {
  it('switches a created session to the unattended stance when set to allow', async () => {
    const { driver, policies } = driverWith({ policy: 'allow' })
    const created = await driver.createSession({ cwd: '/tmp' })

    expect(policies).toHaveLength(1)
    expect(policies[0]?.policy).toBe('never')
    expect(created.approvalPolicy).toBe('never')
    expect(created.approvalPolicyError).toBeUndefined()
  })

  it('leaves the harness alone under inherit (the default)', async () => {
    const { driver, policies } = driverWith({ policy: 'inherit' })
    const created = await driver.createSession({ cwd: '/tmp' })
    expect(policies).toEqual([])
    expect(created.approvalPolicy).toBeUndefined()
    expect(created.approvalPolicyError).toBeUndefined()
  })

  it('reports the missing service instead of pretending the policy applied', async () => {
    const { driver, policies } = driverWith({ policy: 'allow', hasApprovalService: false })
    const created = await driver.createSession({ cwd: '/tmp' })
    expect(policies).toEqual([])
    expect(created.approvalPolicy).toBeUndefined()
    expect(created.approvalPolicyError).toMatch(/no approval service/)
  })

  it('reports an unresolvable agent with its reason', async () => {
    const { driver } = driverWith({
      policy: 'allow',
      resolution: { error: new Error('agent is not live') },
    })
    const created = await driver.createSession({ cwd: '/tmp' })
    expect(created.approvalPolicy).toBeUndefined()
    expect(created.approvalPolicyError).toMatch(/agent could not be resolved: agent is not live/)
  })

  it('applies the same policy to a forked child', async () => {
    const { driver, policies } = driverWith({ policy: 'allow' })
    const forked = await driver.forkSession({ sessionId: 'session-1' })
    expect(forked.sessionId).toBe('session-child')
    expect(forked.approvalPolicy).toBe('never')
    expect(policies).toHaveLength(1)
  })

  it('advertises whether the deployment can apply it', async () => {
    expect(driverWith({ policy: 'allow' }).driver.describeCapabilities().approval).toBe(true)
    expect(driverWith({ policy: 'allow', hasApprovalService: false }).driver.describeCapabilities().approval).toBe(false)
  })
})
