/**
 * Server-pushed change feeds for the MCP resource surface.
 *
 * The modern (2026-07-28) protocol has one push channel — a `subscriptions/listen`
 * stream that can name resources and list-changed feeds — and the 2025-era path
 * reaches the same publishes through the stateful HTTP GET stream. Both are
 * payload-less: a notification says only *which resource* changed, and the client
 * reads that resource for the data. This module owns the plugin half of that
 * contract:
 *
 * - it subscribes to the harness's own event surface (`session/event`,
 *   `agent/assistant-stream`, `agent/status`, the session-list and goal events),
 * - it decides which synthetic resources those events invalidate,
 * - it keeps the bounded per-session buffers behind the two streams that are not
 *   durable reads (assistant deltas, shell-job output), and
 * - it implements the `resources/read` half of every feed.
 *
 * Nothing here is polled unless someone is listening: the handlers return early
 * when the endpoint has no subscribers, and the shell-job poller only runs while
 * a subscription is open. The driver owns access rules and the durable log; this
 * module never touches a harness service directly.
 *
 * @module dsh-as-mcp/mcp/feeds
 */

import type { Config } from '../config.js'
import type {
  SessionEventFeed,
  SessionInfo,
  SessionStatus,
  ShellJobPeek,
  ShellJobSummary,
} from '../dsh/driver.js'
import { eventsOf, type DshLogger } from '../dsh/types.js'

/** The synthetic resource holding the session list. */
export const SESSIONS_URI = 'dsh://sessions'
/** The synthetic resource holding every background shell job this endpoint owns. */
export const JOBS_URI = 'dsh://jobs'

/** The resource one session's durable event feed is published on. */
export function sessionEventsUri(sessionId: string): string {
  return `dsh://session/${encodeURIComponent(sessionId)}/events`
}

/** The resource one session's live assistant stream is published on. */
export function sessionAssistantUri(sessionId: string): string {
  return `dsh://session/${encodeURIComponent(sessionId)}/assistant`
}

/** The resource one session's live status is published on. */
export function sessionStatusUri(sessionId: string): string {
  return `dsh://session/${encodeURIComponent(sessionId)}/status`
}

/** The resource one session's plan/goal/todo projections are published on. */
export function sessionProjectionsUri(sessionId: string): string {
  return `dsh://session/${encodeURIComponent(sessionId)}/projections`
}

/** The resource one background shell job is published on. */
export function jobUri(jobId: string): string {
  return `dsh://jobs/${encodeURIComponent(jobId)}`
}

/** Upper bound on the frames one assistant read returns. */
const MAX_ASSISTANT_FRAMES = 200
/** Upper bound on the bytes one assistant read returns (text only). */
const MAX_ASSISTANT_READ_BYTES = 32 * 1024
/** Upper bound on retained assistant text per session. */
const MAX_ASSISTANT_BUFFER_BYTES = 256 * 1024
/** Upper bound on retained frames per session. */
const MAX_ASSISTANT_BUFFER_FRAMES = 2_000
/** Events one events-feed read returns. */
const MAX_EVENT_FEED_EVENTS = 64
/** How often the shell-job feed polls while someone is subscribed. */
const DEFAULT_JOB_POLL_MS = 1_000
/** Characters of a shell job tail one read returns. */
const MAX_JOB_TAIL_READ_CHARS = 8 * 1024

/** One frame of the live assistant feed. */
export interface AssistantFeedFrame {
  /** Monotonic per-session sequence; a client tracks it to tell new frames from repeats. */
  readonly seq: number
  /** ISO timestamp the frame was observed. */
  readonly at: string
  readonly turn?: number
  readonly step?: number
  readonly kind: 'start' | 'text' | 'reasoning' | 'tool' | 'finish' | 'end'
  /** Delta text for `text`/`reasoning`; tool name for `tool`. */
  readonly text?: string
  /** True on the frame that closes the attempt. */
  readonly done?: boolean
}

/** The `dsh://session/{id}/assistant` payload. */
export interface AssistantFeedSnapshot {
  readonly sessionId: string
  /** Newest frame sequence retained; 0 when nothing has streamed yet. */
  readonly asOfSeq: number
  readonly frames: readonly AssistantFeedFrame[]
  /** True when the retained buffer dropped older frames. */
  readonly truncated: boolean
}

/**
 * The push surface a feed publishes on.
 *
 * Narrower than `EndpointPushes` on purpose: feeds only announce invalidated
 * resources, which keeps them testable without an MCP handler.
 */
export interface FeedPushes {
  hasSubscribers(): boolean
  resourceUpdated(uri: string): void
  resourceUpdatedNow(uri: string): void
}

/** The driver subset a feed reads through. */
export interface FeedDriver {
  readonly ownsSession: (sessionId: string) => boolean
  sessionStatus(request: { readonly sessionId: string }): Promise<SessionStatus>
  listSessions(
    limit: number,
    options?: { readonly includeTitle?: boolean },
  ): Promise<{ readonly sessions: readonly SessionInfo[]; readonly total: number }>
  sessionEventTail(request: {
    readonly sessionId: string
    readonly maxEvents?: number
  }): Promise<SessionEventFeed>
  sessionProjectionValues(request: {
    readonly sessionId: string
  }): Promise<Record<string, unknown>>
  listShellJobs(options?: { readonly running?: boolean }): readonly ShellJobSummary[]
  peekShellJob(jobId: string): ShellJobPeek | undefined
}

/** One feed resource, as registered on the MCP server. */
export interface FeedResource {
  /** Registration key; unique across resources and templates. */
  readonly name: string
  /** URI or URI template. A value containing `{` is registered as a template. */
  readonly uriTemplate: string
  readonly title: string
  readonly description: string
  /** Which tool group must be enabled for the resource to exist. */
  readonly group: 'session' | 'shell'
  /** Read the resource; the returned object is the JSON payload. */
  read(uri: URL, variables: Readonly<Record<string, string>>): Promise<unknown>
}

/** What the MCP layer needs in order to register the feed resources. */
export interface FeedSurface {
  readonly resources: readonly FeedResource[]
}

/** What {@link EventFeeds} needs from its host. */
export interface FeedDeps {
  /** Root Cordis context; only its event surface is used. */
  readonly ctx: unknown
  readonly driver: FeedDriver
  readonly pushes: FeedPushes
  readonly log: DshLogger
  readonly getConfig: () => Config
  /** Test seam: shell-job poll period, milliseconds. */
  readonly jobPollIntervalMs?: number
}

/** The retained live stream of one session. */
interface AssistantBuffer {
  seq: number
  bytes: number
  truncated: boolean
  readonly frames: AssistantFeedFrame[]
}

/** One subscribed harness event, before the feed decides what it invalidates. */
interface AssistantStreamPayload {
  readonly agent?: { readonly id?: unknown; readonly session?: { readonly id?: unknown } }
  readonly frame?: {
    readonly type?: unknown
    readonly turn?: unknown
    readonly step?: unknown
    readonly outcome?: { readonly kind?: unknown }
    readonly chunk?: {
      readonly index?: unknown
      readonly chunk?: {
        readonly type?: unknown
        readonly text?: unknown
        readonly name?: unknown
        readonly reason?: unknown
      }
    }
  }
}

/** What one shell-job poll remembers, so an unchanged job does not re-publish. */
interface JobSignature {
  readonly status: string
  readonly tail: string
  readonly finishedAt: number | undefined
}

/**
 * The plugin's feed collector: one instance per endpoint, started once.
 *
 * Start it after the driver and push surface exist, and dispose it with the
 * plugin. Resource registration lives in the MCP layer; this class is transport
 * agnostic so the same reads serve modern listen streams and 2025 GET streams.
 */
export class EventFeeds {
  private readonly ctx: unknown
  private readonly driver: FeedDriver
  private readonly pushes: FeedPushes
  private readonly log: DshLogger
  private readonly getConfig: () => Config
  private readonly jobPollIntervalMs: number

  private readonly assistant = new Map<string, AssistantBuffer>()
  private readonly jobSignatures = new Map<string, JobSignature>()
  private jobsSignature = ''
  private started = false
  private offEvents: Array<() => unknown> = []
  private jobTimer: ReturnType<typeof setInterval> | undefined

  /** The resources this collector serves, in registration order. */
  readonly resources: readonly FeedResource[]

  constructor(deps: FeedDeps) {
    this.ctx = deps.ctx
    this.driver = deps.driver
    this.pushes = deps.pushes
    this.log = deps.log
    this.getConfig = deps.getConfig
    this.jobPollIntervalMs = deps.jobPollIntervalMs ?? DEFAULT_JOB_POLL_MS
    this.resources = [
      {
        name: 'sessions',
        uriTemplate: SESSIONS_URI,
        title: 'DSH sessions',
        description:
          'The session list as session_list reports it, minus titles. Published when a session is added, removed, '
          + 'started, stopped, archived or otherwise changes activity.',
        group: 'session',
        read: async () => {
          const listed = await this.driver.listSessions(50)
          return { sessions: listed.sessions, total: listed.total }
        },
      },
      {
        name: 'session-events',
        uriTemplate: 'dsh://session/{sessionId}/events',
        title: 'DSH session event feed',
        description:
          'The newest durable events of one session, projected to {seq, type, at, turn, step, summary, error}. '
          + 'This is the progress feed published on every append; the full content is in session_messages.',
        group: 'session',
        read: async (_uri, variables) => {
          const sessionId = requireVariable(variables, 'sessionId')
          return await this.driver.sessionEventTail({ sessionId, maxEvents: MAX_EVENT_FEED_EVENTS })
        },
      },
      {
        name: 'session-assistant',
        uriTemplate: 'dsh://session/{sessionId}/assistant',
        title: 'DSH live assistant stream',
        description:
          'The live assistant text/reasoning/tool-call deltas of one session, buffered in process. Published '
          + 'while a model turn streams; frames carry a monotonic seq so a client can drop repeats. The buffer '
          + 'is bounded and may be truncated on a very long turn.',
        group: 'session',
        read: async (_uri, variables) => {
          const sessionId = requireVariable(variables, 'sessionId')
          return this.readAssistant(sessionId)
        },
      },
      {
        name: 'session-status',
        uriTemplate: 'dsh://session/{sessionId}/status',
        title: 'DSH session status',
        description:
          'The live status of one session, the same payload as session_status. Published when a turn opens or '
          + 'closes, the agent changes state, or the working directory changes.',
        group: 'session',
        read: async (_uri, variables) => {
          const sessionId = requireVariable(variables, 'sessionId')
          return await this.driver.sessionStatus({ sessionId })
        },
      },
      {
        name: 'session-projections',
        uriTemplate: 'dsh://session/{sessionId}/projections',
        title: 'DSH session projections',
        description:
          'The projection values a supervisor watches during a long session: workingDirectory, the forge '
          + 'worktree record, goal, plan, todos, agentPreset and title. Only the allowlisted keys are reported.',
        group: 'session',
        read: async (_uri, variables) => {
          const sessionId = requireVariable(variables, 'sessionId')
          return await this.driver.sessionProjectionValues({ sessionId })
        },
      },
      {
        name: 'jobs',
        uriTemplate: JOBS_URI,
        title: 'DSH background jobs',
        description:
          'Every background shell job this endpoint started, with status and pending bytes. Published while a '
          + 'job runs and when one settles. Jobs are polled at about one second while someone is subscribed.',
        group: 'shell',
        read: async () => ({ jobs: this.driver.listShellJobs() }),
      },
      {
        name: 'job',
        uriTemplate: 'dsh://jobs/{jobId}',
        title: 'DSH background job',
        description:
          'One background shell job with the retained output tail (non-consuming: shell_output still owns the '
          + 'delivery buffer). Published when its output tail grows or its status changes.',
        group: 'shell',
        read: async (_uri, variables) => {
          const jobId = requireVariable(variables, 'jobId')
          const job = this.driver.peekShellJob(jobId)
          if (job === undefined) throw new Error(`unknown background job "${jobId}"`)
          return {
            ...job,
            tail: job.tail.slice(-MAX_JOB_TAIL_READ_CHARS),
          }
        },
      },
    ]
  }

  /** Whether feeds are currently collecting (after {@link start}, before dispose). */
  get active(): boolean {
    return this.started
  }

  /**
   * Subscribe to the harness event surface and start the job poller.
   *
   * @returns a disposer that unsubscribes and drops every buffer.
   */
  start(): () => void {
    if (this.started) return () => {}
    this.started = true
    const bus = eventsOf(this.ctx)
    if (typeof bus.on !== 'function') {
      this.log.debug('[dsh-as-mcp] no event bus on this context; push feeds stay passive')
      return () => {}
    }
    const on = (name: string, listener: (...args: unknown[]) => void): void => {
      try {
        const off = bus.on(name, listener)
        if (typeof off === 'function') this.offEvents.push(off)
      } catch (error) {
        this.log.debug(
          '[dsh-as-mcp] could not subscribe to %s for push feeds: %s',
          name,
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    })
    on('agent/assistant-stream', (payload) => {
      this.onAssistantStream(payload)
    })
    on('agent/status', (payload) => {
      this.onAgentStatus(payload)
    })
    on('api-session/added', () => this.pushes.resourceUpdated(SESSIONS_URI))
    on('api-session/removed', () => this.pushes.resourceUpdated(SESSIONS_URI))
    on('api-session/activity', () => this.pushes.resourceUpdated(SESSIONS_URI))
    on('api-session/status', (sessionId) => {
      this.announceStatus(sessionId)
      this.pushes.resourceUpdated(SESSIONS_URI)
    })
    on('session/created', (session) => {
      this.pushes.resourceUpdated(SESSIONS_URI)
      const sessionId = idOf(session)
      if (sessionId !== undefined) this.announceStatus(sessionId)
    })
    on('session/disposed', (session) => {
      const sessionId = idOf(session)
      if (sessionId !== undefined) this.assistant.delete(sessionId)
      this.pushes.resourceUpdated(SESSIONS_URI)
    })
    on('goal/changed', (payload) => {
      const sessionId = sessionIdOfAgent(payload)
      if (sessionId !== undefined) this.pushes.resourceUpdated(sessionProjectionsUri(sessionId))
    })
    on('subagent/start', () => this.pushes.resourceUpdated(SESSIONS_URI))
    on('subagent/end', () => this.pushes.resourceUpdated(SESSIONS_URI))

    this.jobTimer = setInterval(() => this.pollJobs(), this.jobPollIntervalMs)
    if (typeof this.jobTimer === 'object' && 'unref' in this.jobTimer) this.jobTimer.unref()

    return () => {
      this.dispose()
    }
  }

  /** Stop collecting and drop every buffer. Idempotent. */
  dispose(): void {
    if (!this.started && this.offEvents.length === 0) return
    this.started = false
    for (const off of this.offEvents.splice(0)) {
      try {
        off()
      } catch {
        // An already-disposed bus cannot unsubscribe; nothing to do.
      }
    }
    if (this.jobTimer !== undefined) clearInterval(this.jobTimer)
    this.jobTimer = undefined
    this.assistant.clear()
    this.jobSignatures.clear()
    this.jobsSignature = ''
  }

  // -------------------------------------------------------------------------
  // Harness event handlers
  // -------------------------------------------------------------------------

  private onSessionEvent(session: unknown, event: unknown): void {
    const sessionId = idOf(session)
    if (sessionId === undefined || !this.visible(sessionId)) return
    if (!this.pushes.hasSubscribers()) return
    const type = (event as { readonly type?: unknown } | undefined)?.type
    this.pushes.resourceUpdated(sessionEventsUri(sessionId))
    this.pushes.resourceUpdated(sessionStatusUri(sessionId))
    // Turn ends and preset/todo/goal-adjacent appends are when projections move;
    // publishing on those only keeps a chatty log from re-reading projections on
    // every token. Unknown types are cheap to include and read lazily.
    if (type === 'turn/end' || type === 'agent-preset/selected' || type === 'user/message') {
      this.pushes.resourceUpdated(sessionProjectionsUri(sessionId))
    }
  }

  private onAssistantStream(raw: unknown): void {
    if (!this.pushes.hasSubscribers()) return
    const payload = raw as AssistantStreamPayload | undefined
    const sessionId = sessionIdOfAgent(payload)
    if (sessionId === undefined || !this.visible(sessionId)) return
    const frame = payload?.frame
    if (frame === undefined) return
    const buffer = this.assistantBuffer(sessionId)
    const at = new Date().toISOString()
    const base = {
      turn: typeof frame.turn === 'number' ? frame.turn : undefined,
      step: typeof frame.step === 'number' ? frame.step : undefined,
    }
    let pushed: AssistantFeedFrame | undefined
    if (frame.type === 'start') {
      pushed = this.appendFrame(buffer, { seq: 0, at, kind: 'start', ...dropUndefined(base) })
    } else if (frame.type === 'end') {
      const kind = typeof frame.outcome?.kind === 'string' ? frame.outcome.kind : 'abandoned'
      pushed = this.appendFrame(buffer, {
        seq: 0,
        at,
        kind: 'end',
        text: kind,
        done: true,
        ...dropUndefined(base),
      })
    } else if (frame.type === 'chunk') {
      const chunk = frame.chunk?.chunk
      const text = typeof chunk?.text === 'string' ? chunk.text : undefined
      if (chunk?.type === 'text-delta' && text !== undefined) {
        pushed = this.appendFrame(buffer, { seq: 0, at, kind: 'text', text, ...dropUndefined(base) })
      } else if (chunk?.type === 'reasoning-delta' && text !== undefined) {
        pushed = this.appendFrame(buffer, { seq: 0, at, kind: 'reasoning', text, ...dropUndefined(base) })
      } else if (chunk?.type === 'tool-call-delta') {
        const name = typeof chunk.name === 'string' ? chunk.name : undefined
        pushed = this.appendFrame(buffer, {
          seq: 0,
          at,
          kind: 'tool',
          ...(name === undefined ? {} : { text: name }),
          ...dropUndefined(base),
        })
      } else if (chunk?.type === 'finish') {
        const reason = typeof chunk.reason === 'string' ? chunk.reason : undefined
        pushed = this.appendFrame(buffer, {
          seq: 0,
          at,
          kind: 'finish',
          ...(reason === undefined ? {} : { text: reason }),
          ...dropUndefined(base),
        })
      }
    }
    if (pushed !== undefined) this.pushes.resourceUpdated(sessionAssistantUri(sessionId))
  }

  private onAgentStatus(raw: unknown): void {
    const payload = raw as { readonly agent?: unknown; readonly status?: unknown } | undefined
    const sessionId = sessionIdOfAgent(payload)
    if (sessionId === undefined) return
    this.announceStatus(sessionId)
    this.pushes.resourceUpdated(SESSIONS_URI)
  }

  private announceStatus(rawSessionId: unknown): void {
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : idOf(rawSessionId)
    if (sessionId === undefined || !this.visible(sessionId)) return
    if (!this.pushes.hasSubscribers()) return
    this.pushes.resourceUpdated(sessionStatusUri(sessionId))
    this.pushes.resourceUpdated(SESSIONS_URI)
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private readAssistant(sessionId: string): AssistantFeedSnapshot {
    const buffer = this.assistant.get(sessionId)
    if (buffer === undefined) return { sessionId, asOfSeq: 0, frames: [], truncated: false }
    const frames: AssistantFeedFrame[] = []
    let bytes = 0
    for (let index = buffer.frames.length - 1; index >= 0; index -= 1) {
      const frame = buffer.frames[index] as AssistantFeedFrame
      const size = Buffer.byteLength(frame.text ?? '', 'utf8')
      if (frames.length >= MAX_ASSISTANT_FRAMES || (frames.length > 0 && bytes + size > MAX_ASSISTANT_READ_BYTES)) {
        break
      }
      frames.unshift(frame)
      bytes += size
    }
    return {
      sessionId,
      asOfSeq: buffer.seq,
      frames,
      truncated: buffer.truncated || frames.length < buffer.frames.length,
    }
  }

  // -------------------------------------------------------------------------
  // Assistant buffering
  // -------------------------------------------------------------------------

  private assistantBuffer(sessionId: string): AssistantBuffer {
    const existing = this.assistant.get(sessionId)
    if (existing !== undefined) return existing
    const created: AssistantBuffer = { seq: 0, bytes: 0, truncated: false, frames: [] }
    this.assistant.set(sessionId, created)
    return created
  }

  private appendFrame(buffer: AssistantBuffer, frame: AssistantFeedFrame): AssistantFeedFrame {
    buffer.seq += 1
    const stored: AssistantFeedFrame = { ...frame, seq: buffer.seq }
    buffer.frames.push(stored)
    buffer.bytes += Buffer.byteLength(stored.text ?? '', 'utf8')
    while (
      buffer.frames.length > MAX_ASSISTANT_BUFFER_FRAMES
      || (buffer.bytes > MAX_ASSISTANT_BUFFER_BYTES && buffer.frames.length > 1)
    ) {
      const dropped = buffer.frames.shift()
      buffer.bytes -= Buffer.byteLength(dropped?.text ?? '', 'utf8')
      buffer.truncated = true
    }
    return stored
  }

  // -------------------------------------------------------------------------
  // Shell-job polling
  // -------------------------------------------------------------------------

  private pollJobs(): void {
    if (!this.started || !this.pushes.hasSubscribers()) return
    let jobs: readonly ShellJobSummary[]
    try {
      jobs = this.driver.listShellJobs()
    } catch (error) {
      this.log.debug(
        '[dsh-as-mcp] could not list shell jobs for the push feed: %s',
        error instanceof Error ? error.message : String(error),
      )
      return
    }
    const jobsSignature = jobs
      .map((job) => `${job.jobId}:${job.status}:${job.finishedAt ?? ''}:${job.pendingBytes}`)
      .join('|')
    if (jobsSignature !== this.jobsSignature) {
      this.jobsSignature = jobsSignature
      this.pushes.resourceUpdated(JOBS_URI)
    }
    for (const summary of jobs) {
      let peek: ShellJobPeek | undefined
      try {
        peek = this.driver.peekShellJob(summary.jobId)
      } catch (error) {
        this.log.debug(
          '[dsh-as-mcp] could not peek shell job %s for the push feed: %s',
          summary.jobId,
          error instanceof Error ? error.message : String(error),
        )
        continue
      }
      if (peek === undefined) continue
      const previous = this.jobSignatures.get(peek.jobId)
      this.jobSignatures.set(peek.jobId, { status: peek.status, tail: peek.tail, finishedAt: peek.finishedAt })
      if (previous === undefined) {
        this.pushes.resourceUpdated(jobUri(peek.jobId))
        continue
      }
      if (previous.status !== peek.status || previous.finishedAt !== peek.finishedAt || previous.tail !== peek.tail) {
        this.pushes.resourceUpdated(jobUri(peek.jobId))
      }
    }
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  /**
   * Whether a notification about this session may be published.
   *
   * Reads enforce the session scope themselves; notifications are gated the same
   * way so an `owned` deployment does not even leak other sessions' ids on the push
   * channel. A subagent of an owned session is not in `ownedSessions` — its parent
   * is — so an owned scope also drops subagent feeds, which is acceptable for a
   * progress channel and is documented.
   */
  private visible(sessionId: string): boolean {
    let scope: Config['session']['scope'] = 'all'
    try {
      scope = this.getConfig().session.scope
    } catch {
      // A live config that cannot be read yet is treated as the wider default.
    }
    return scope === 'all' || this.driver.ownsSession(sessionId)
  }
}

/** The `id` of a session-shaped value, when it carries one. */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { readonly id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The session an agent-shaped payload belongs to. */
function sessionIdOfAgent(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const agent = (value as { readonly agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null) return undefined
  const id = (agent as { readonly id?: unknown }).id
  if (typeof id === 'string' && id !== '') return id
  const session = (agent as { readonly session?: { readonly id?: unknown } }).session
  return idOf(session)
}

/** Drop `undefined` optional fields so the frame payload stays terse on the wire. */
function dropUndefined<T extends { turn?: number; step?: number }>(value: T): { turn?: number; step?: number } {
  return {
    ...(value.turn === undefined ? {} : { turn: value.turn }),
    ...(value.step === undefined ? {} : { step: value.step }),
  }
}

/** One URI-template variable, decoded. */
function requireVariable(variables: Readonly<Record<string, string>>, name: string): string {
  const value = variables[name]
  if (value === undefined || value === '') throw new Error(`resource URI is missing ${name}`)
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
