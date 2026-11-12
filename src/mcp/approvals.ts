/**
 * Human-in-the-loop approvals over MCP.
 *
 * `approval.policy: "human"` turns this endpoint into the answerer for approval
 * requests raised by sessions it created — but instead of deciding, it holds the
 * request until a person answers. Two channels carry the question:
 *
 * - the `dsh://approvals` resource, which is readable and pushed, so any client can
 *   poll it or subscribe to it and then call `approval_decide`; and
 * - MCP `elicitation/create`, which a **stateful 2025-era** client receives on its
 *   long-lived GET stream (the modern 2026-07-28 era replaced that push-style request
 *   with `input_required` results, which only exist inside a tool call, so a modern
 *   client uses the resource + tool path instead).
 *
 * Three properties are deliberate and load-bearing:
 *
 * - **Fails closed.** A timeout, a cancelled harness request, or a client that
 *   vanished answers `rejected`. There is no path where silence becomes consent.
 * - **Scope.** Only a session this endpoint owns can reach this broker at all; the
 *   caller is the approval answerer, which refuses to claim a foreign request before
 *   it ever gets here (see `src/index.ts`).
 * - **Bounded.** At most {@link MAX_PENDING_APPROVALS} requests are held, and decided
 *   ones are kept in a small ring for audit (`approval_list { includeSettled: true }`)
 *   rather than forever.
 *
 * @module dsh-as-mcp/mcp/approvals
 */

import type { DshLogger } from '../dsh/types.js'

/** The URI the approval queue is published on. */
export const APPROVALS_URI = 'dsh://approvals'

/** A request waiting for a human decision. */
export interface ApprovalNotice {
  /** Stable id the decision tools address. */
  readonly approvalId: string
  /** The DSH session whose turn is blocked. */
  readonly sessionId: string
  /** The harness tool that asked. */
  readonly toolName: string
  /** The tool call id, when the harness supplied one. */
  readonly callId?: string
  /** The harness's own reason, when it supplied one. */
  readonly reason?: string
  /** A localized display reason, when the harness supplied one. */
  readonly displayReason?: Readonly<Record<string, string>>
  /** ISO timestamp the request was opened. */
  readonly createdAt: string
  /** ISO timestamp it will be answered `rejected` at the latest. */
  readonly expiresAt: string
}

/** A decided request, kept briefly for audit. */
export interface SettledApproval extends ApprovalNotice {
  /** What the answer was. */
  readonly decision: 'allow' | 'reject'
  /** Who answered: an `approval_decide` call, an elicitation answer, or the timeout. */
  readonly decidedBy: 'tool' | 'elicitation' | 'timeout' | 'cancelled'
  readonly decidedAt: string
  /** Free-text reason supplied with a decision, when there was one. */
  readonly decisionReason?: string
}

/** The outcome the harness understands. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** The push surface the broker publishes on. */
export interface ApprovalPushes {
  resourceUpdated(uri: string): void
  resourceUpdatedNow(uri: string): void
}

/**
 * Ask a connected 2025-era client for a decision.
 *
 * Resolves `undefined` when no client could be asked (no stateful session, no
 * elicitation support), so the broker falls back to waiting for the tool path.
 */
export type ApprovalElicitor = (notice: ApprovalNotice) => Promise<'allow' | 'reject' | undefined>

/** What {@link ApprovalBroker} needs to run. */
export interface ApprovalBrokerDeps {
  readonly log: DshLogger
  /** How long a request waits before answering `rejected`. */
  readonly timeoutMs: () => number
  readonly pushes?: ApprovalPushes
}

/** Most requests held at once; beyond this a new request is refused (fails closed). */
const MAX_PENDING_APPROVALS = 32

/** Decided requests kept for audit. */
const MAX_SETTLED_APPROVALS = 50

interface PendingApproval {
  readonly notice: ApprovalNotice
  readonly settle: (decision: 'allow' | 'reject' | 'cancelled', decidedBy: SettledApproval['decidedBy'], reason?: string) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * The approval queue behind `approval.policy: "human"`.
 *
 * One instance per endpoint: the plugin's approval answerer calls {@link request},
 * the tools call {@link decide}, and the HTTP layer attaches an elicitor when it can
 * serve 2025-era stateful sessions.
 */
export class ApprovalBroker {
  private readonly log: DshLogger
  private readonly timeoutMs: () => number
  private readonly pushes: ApprovalPushes | undefined

  private readonly pending = new Map<string, PendingApproval>()
  private readonly settled: SettledApproval[] = []
  private elicitor: ApprovalElicitor | undefined
  private sequence = 0
  private disposed = false

  constructor(deps: ApprovalBrokerDeps) {
    this.log = deps.log
    this.timeoutMs = deps.timeoutMs
    this.pushes = deps.pushes
  }

  /** Bind the channel that can ask a 2025-era client directly. */
  attachElicitor(elicitor: ApprovalElicitor): void {
    this.elicitor = elicitor
  }

  /** Whether an elicitation channel is attached (a stateful HTTP client may exist). */
  get hasElicitor(): boolean {
    return this.elicitor !== undefined
  }

  /** Requests currently blocking a turn, oldest first. */
  pendingApprovals(): readonly ApprovalNotice[] {
    return [...this.pending.values()].map((entry) => entry.notice)
  }

  /** Recently decided requests, newest first. */
  settledApprovals(): readonly SettledApproval[] {
    return [...this.settled]
  }

  /**
   * Ask a human one approval request and wait for the answer.
   *
   * The promise always resolves to a harness outcome: a decision becomes
   * `allowed-once`/`rejected`, a timeout or an aborted request becomes
   * `rejected`/`cancelled` — never `allowed-once` by omission.
   */
  async request(input: {
    sessionId: string
    toolName: string
    callId?: string
    reason?: string
    displayReason?: Readonly<Record<string, string>>
    signal?: AbortSignal
  }): Promise<ApprovalOutcome> {
    if (this.disposed) return 'rejected'
    if (this.pending.size >= MAX_PENDING_APPROVALS) {
      this.log.warn(
        '[dsh-as-mcp] %d approval requests are already waiting; refusing %s on session %s (fails closed)',
        this.pending.size,
        input.toolName,
        input.sessionId,
      )
      return 'rejected'
    }
    if (input.signal?.aborted === true) return 'cancelled'

    const timeout = Math.max(1, this.timeoutMs())
    const now = Date.now()
    this.sequence += 1
    const notice: ApprovalNotice = {
      approvalId: `approval-${now.toString(36)}-${this.sequence}`,
      sessionId: input.sessionId,
      toolName: input.toolName,
      ...(input.callId === undefined ? {} : { callId: input.callId }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.displayReason === undefined ? {} : { displayReason: input.displayReason }),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeout).toISOString(),
    }

    const answer = await new Promise<{ outcome: ApprovalOutcome; decidedBy: SettledApproval['decidedBy']; reason?: string }>(
      (resolve) => {
        let done = false
        const finish = (
          decision: 'allow' | 'reject' | 'cancelled',
          decidedBy: SettledApproval['decidedBy'],
          decisionReason?: string,
        ): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          this.pending.delete(notice.approvalId)
          this.settled.unshift({
            ...notice,
            decision: decision === 'cancelled' ? 'reject' : decision,
            decidedBy,
            decidedAt: new Date().toISOString(),
            ...(decisionReason === undefined ? {} : { decisionReason }),
          })
          if (this.settled.length > MAX_SETTLED_APPROVALS) this.settled.length = MAX_SETTLED_APPROVALS
          // A settled request leaves the queue: publish so a client that was showing
          // a prompt stops showing it.
          this.publish()
          resolve({
            outcome: decision === 'allow' ? 'allowed-once' : decision === 'cancelled' ? 'cancelled' : 'rejected',
            decidedBy,
            ...(decisionReason === undefined ? {} : { reason: decisionReason }),
          })
        }
        const timer = setTimeout(() => {
          this.log.warn(
            '[dsh-as-mcp] approval %s (%s on session %s) timed out after %d ms; answering rejected',
            notice.approvalId,
            notice.toolName,
            notice.sessionId,
            timeout,
          )
          finish('reject', 'timeout')
        }, timeout)
        if (typeof timer === 'object' && 'unref' in timer) timer.unref?.()
        this.pending.set(notice.approvalId, {
          notice,
          timer,
          settle: (decision, decidedBy, reason) => finish(decision, decidedBy, reason),
        })
        input.signal?.addEventListener('abort', () => finish('cancelled', 'cancelled'), { once: true })
        this.publish()

        // Ask a 2025-era client directly as well. Whichever answers first settles the
        // request; a client that cannot be asked resolves undefined and the tool path
        // (or the timeout) decides.
        if (this.elicitor !== undefined) {
          void this.elicitor(notice)
            .then((decision) => {
              if (decision === undefined) return
              finish(decision, 'elicitation')
            })
            .catch((error: unknown) => {
              this.log.warn(
                '[dsh-as-mcp] elicitation for approval %s failed: %s',
                notice.approvalId,
                error instanceof Error ? error.message : String(error),
              )
            })
        }
      },
    )
    return answer.outcome
  }

  /**
   * Answer one pending request.
   *
   * Returns the settled record, or `undefined` for an id that is not pending — the
   * tool reports that as `decided: false` rather than an error, so a decision that
   * raced the timeout is not confusing.
   */
  decide(approvalId: string, decision: 'allow' | 'reject', reason?: string): SettledApproval | undefined {
    const pending = this.pending.get(approvalId)
    if (pending === undefined) return undefined
    pending.settle(decision, 'tool', reason)
    return this.settled.find((entry) => entry.approvalId === approvalId)
  }

  /** Drop every pending request (each answers `cancelled`) and stop publishing. */
  dispose(): void {
    this.disposed = true
    for (const entry of [...this.pending.values()]) entry.settle('cancelled', 'cancelled')
    this.pending.clear()
    this.elicitor = undefined
  }

  private publish(): void {
    this.pushes?.resourceUpdatedNow(APPROVALS_URI)
  }
}
