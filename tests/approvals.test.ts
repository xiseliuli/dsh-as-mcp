/**
 * The human-in-the-loop approval broker.
 *
 * `approval.policy: "human"` makes this endpoint answer the harness's approval
 * waterfall by *waiting*: the request is published on `dsh://approvals`, offered to a
 * stateful 2025-era client as an MCP elicitation, and held until someone answers or
 * the timeout fires. The tests pin the properties that make that safe:
 *
 * - **fails closed** — a timeout, an aborted request, or a disposed broker answers
 *   `rejected`/`cancelled`, never `allowed-once` by omission;
 * - **one answer wins** — an elicitation answer, an `approval_decide` call and the
 *   timeout race, and exactly one of them settles the request;
 * - **bounded** — pending requests are capped and settled ones live in a small ring;
 * - **auditable** — every settlement records who answered and when.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  APPROVALS_URI,
  ApprovalBroker,
  type ApprovalElicitor,
} from '../src/mcp/approvals.js'
import type { DshLogger } from '../src/dsh/types.js'

const silentLog: DshLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** A broker with a recording push surface. */
function makeBroker(options: {
  timeoutMs?: number
  elicitor?: ApprovalElicitor
} = {}): { broker: ApprovalBroker; published: string[] } {
  const published: string[] = []
  const broker = new ApprovalBroker({
    log: silentLog,
    timeoutMs: () => options.timeoutMs ?? 60_000,
    pushes: {
      resourceUpdated: (uri: string) => published.push(uri),
      resourceUpdatedNow: (uri: string) => published.push(uri),
    },
  })
  if (options.elicitor !== undefined) broker.attachElicitor(options.elicitor)
  return { broker, published }
}

/** One request payload. */
function request(): { sessionId: string; toolName: string; reason: string; callId: string } {
  return { sessionId: 'session-1', toolName: 'bash', reason: 'writes outside the workspace', callId: 'call-1' }
}

describe('the approval broker', () => {
  it('publishes the queue when a request arrives and when it is decided', async () => {
    const { broker, published } = makeBroker()
    const pending = broker.request(request())
    expect(broker.pendingApprovals()).toHaveLength(1)
    expect(published).toContain(APPROVALS_URI)
    const notice = broker.pendingApprovals()[0] as { approvalId: string }
    expect(notice).toMatchObject({ sessionId: 'session-1', toolName: 'bash', callId: 'call-1' })
    expect(notice.approvalId).toMatch(/^approval-/)

    const settled = broker.decide(notice.approvalId, 'allow', 'looks fine')
    expect(settled).toMatchObject({ decision: 'allow', decidedBy: 'tool', decisionReason: 'looks fine' })
    // The id is gone from the queue and the decision reached the harness.
    expect(broker.pendingApprovals()).toEqual([])
    await expect(pending).resolves.toBe('allowed-once')
    expect(published.filter((uri) => uri === APPROVALS_URI).length).toBeGreaterThanOrEqual(2)
    expect(broker.settledApprovals()[0]).toMatchObject({ approvalId: notice.approvalId, decision: 'allow' })
  })

  it('answers rejected on reject, and reports a repeat decision as already decided', async () => {
    const { broker } = makeBroker()
    const pending = broker.request(request())
    const id = (broker.pendingApprovals()[0] as { approvalId: string }).approvalId
    expect(broker.decide(id, 'reject')).toMatchObject({ decision: 'reject' })
    await expect(pending).resolves.toBe('rejected')
    // A second answer for the same id is not pending any more.
    expect(broker.decide(id, 'allow')).toBeUndefined()
  })

  it('fails closed on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { broker } = makeBroker({ timeoutMs: 1_000 })
      const pending = broker.request(request())
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toBe('rejected')
      expect(broker.settledApprovals()[0]).toMatchObject({ decision: 'reject', decidedBy: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers cancelled when the harness aborts the request', async () => {
    const { broker } = makeBroker()
    const controller = new AbortController()
    const pending = broker.request({ ...request(), signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(broker.settledApprovals()[0]).toMatchObject({ decidedBy: 'cancelled' })
  })

  it('takes an elicitation answer, and the first answer wins', async () => {
    let release: ((value: 'allow' | 'reject' | undefined) => void) | undefined
    const { broker } = makeBroker({
      elicitor: () => new Promise((resolve) => {
        release = resolve
      }),
    })
    const pending = broker.request(request())
    const id = (broker.pendingApprovals()[0] as { approvalId: string }).approvalId
    // The human answers through the tool path first; the elicitation resolution
    // arriving later must not change the outcome.
    broker.decide(id, 'reject', 'not now')
    release?.('allow')
    await expect(pending).resolves.toBe('rejected')
    expect(broker.settledApprovals()[0]).toMatchObject({ decidedBy: 'tool', decision: 'reject' })
  })

  it('settles from an elicitation answer when no tool decision arrives', async () => {
    const { broker } = makeBroker({ elicitor: async () => 'allow' })
    await expect(broker.request(request())).resolves.toBe('allowed-once')
    expect(broker.settledApprovals()[0]).toMatchObject({ decidedBy: 'elicitation', decision: 'allow' })
  })

  it('ignores an elicitor that cannot reach a client', async () => {
    const { broker } = makeBroker({ elicitor: async () => undefined })
    const pending = broker.request(request())
    // Still waiting on the timeout/tool path.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(broker.pendingApprovals()).toHaveLength(1)
    const id = (broker.pendingApprovals()[0] as { approvalId: string }).approvalId
    broker.decide(id, 'allow')
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('refuses a new request once the pending cap is reached (fails closed)', async () => {
    const { broker } = makeBroker()
    const pendings = []
    for (let index = 0; index < 32; index += 1) pendings.push(broker.request({ ...request(), callId: `call-${index}` }))
    expect(broker.pendingApprovals()).toHaveLength(32)
    await expect(broker.request(request())).resolves.toBe('rejected')
    broker.dispose()
    // Disposal cancels what was still waiting.
    for (const pending of pendings) await expect(pending).resolves.toBe('cancelled')
  })

  it('keeps the settled ring bounded', async () => {
    const { broker } = makeBroker()
    for (let index = 0; index < 55; index += 1) {
      const pending = broker.request({ ...request(), callId: `call-${index}` })
      broker.decide((broker.pendingApprovals()[0] as { approvalId: string }).approvalId, 'reject')
      await pending
    }
    expect(broker.settledApprovals()).toHaveLength(50)
    // Newest first.
    expect((broker.settledApprovals()[0] as { callId?: string }).callId).toBe('call-54')
  })

  it('answers rejected once disposed, and on an already-aborted signal', async () => {
    const { broker } = makeBroker()
    broker.dispose()
    await expect(broker.request(request())).resolves.toBe('rejected')

    const { broker: fresh } = makeBroker()
    const controller = new AbortController()
    controller.abort()
    await expect(fresh.request({ ...request(), signal: controller.signal })).resolves.toBe('cancelled')
  })
})
