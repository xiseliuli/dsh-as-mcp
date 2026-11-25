/**
 * Claude Code channel support for the stdio bridge (`mcp-stdio.mjs --channel`).
 *
 * This module holds everything that is not transport: the instructions text,
 * the notification shape, the rule that reduces a harness turn ending to one
 * short word, and the tracker that decides *when* a DSH session's turn has
 * ended. The bridge hands the tracker two callbacks — `rpc` (a bridge-internal
 * JSON-RPC request whose reply never reaches stdout) and `emit` (write one
 * `notifications/claude/channel` line) — so the tracker has no I/O of its own.
 *
 * No dependencies on purpose, like the bridge itself.
 */

/** Prefix of every JSON-RPC id the bridge invents; replies to them stay internal. */
export const INTERNAL_ID_PREFIX = 'dsh-channel:'

/**
 * The 2025-era revision the bridge asks the endpoint for in channel mode.
 *
 * Claude Code's v2 runtime does not register a server as a channel when the
 * negotiated revision is the modern one, and the modern era has no stateful
 * session for the bridge's push channel anyway.
 */
export const LEGACY_PROTOCOL_VERSION = '2025-06-18'

const SESSIONS_URI = 'dsh://sessions'
const SESSION_FEED = /^dsh:\/\/session\/([^/]+)\/(turn|status)$/

/** Longest failure message put in a notification line. */
const MAX_FAILURE_CHARS = 200

export const CHANNEL_INSTRUCTIONS = [
  'This server pushes DSH session events as <channel source="dsh" ...> messages.',
  'Each one means a DSH session finished a turn (the agent stopped working and is waiting or done).',
  'The message body is one line; the tag attributes carry:',
  '- session_id: the DSH session id (pass it to session_status / session_messages);',
  '- title: the session title, or the first 8 characters of the id when it has none;',
  '- turn: the number of the turn that ended;',
  '- reason: how it ended (completed, aborted, error, blocked, max-tokens, interrupted, ...);',
  '- failure_kind: the failure class when the turn ended abnormally, otherwise "none".',
  'These events are one-way: do not reply to the channel. When one arrives, look at the result with',
  'session_status (state and failure) or session_messages (what the agent said), then decide what to do next.',
].join('\n')

/** Collapse whitespace so a value is safe on one line. */
function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

/** Truncate to `max` characters, marking the cut. */
function clip(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Reduce a harness `turn/end` reason to a short string.
 *
 * The harness records an object (`{ kind: 'completed' }`, `{ kind: 'error',
 * error: {...} }`, ...), so the `kind` is the answer; a bare string is taken
 * as is, anything else is `unknown`.
 */
export function reduceReason(reason) {
  if (typeof reason === 'string' && reason.trim() !== '') return oneLine(reason)
  if (reason !== null && typeof reason === 'object') {
    const kind = reason.kind
    if (typeof kind === 'string' && kind.trim() !== '') return oneLine(kind)
  }
  return 'unknown'
}

/** Build the `params` of one `notifications/claude/channel` message. */
export function buildChannelParams(input) {
  const label = oneLine(input.title ?? '') || input.sessionId.slice(0, 8)
  const reason = reduceReason(input.reason)
  const failure = input.failure !== null && typeof input.failure === 'object' ? input.failure : undefined
  const failureKind = failure !== undefined && typeof failure.kind === 'string' && failure.kind !== ''
    ? oneLine(failure.kind)
    : 'none'
  let content = `DSH session "${label}" turn ${input.turn} ended: ${reason}`
  if (failure !== undefined) {
    const message = clip(oneLine(failure.message ?? ''), MAX_FAILURE_CHARS)
    content += ` — failed (${failureKind}): ${message}`
  }
  return {
    content,
    meta: {
      session_id: input.sessionId,
      title: label,
      turn: String(input.turn),
      reason,
      failure_kind: failureKind,
    },
  }
}

/** Parse the JSON text of a `resources/read` result. */
function contentsJson(result) {
  const text = result?.contents?.[0]?.text
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Create the turn-end tracker.
 *
 * @param {object} deps
 * @param {'owned'|'all'} deps.scope  which sessions may notify
 * @param {(method: string, params: object) => Promise<any>} deps.rpc  internal request, resolves to `result`
 * @param {(params: object) => void} deps.emit  write one channel notification
 * @param {(message: string) => void} deps.log  stderr logger
 * @param {() => Promise<unknown>} [deps.whenPushReady]  resolves once the GET stream is open
 * @param {number} [deps.debounceMs]
 */
export function createTracker(deps) {
  const { scope, rpc, emit, log } = deps
  const debounceMs = deps.debounceMs ?? 50
  const whenPushReady = deps.whenPushReady ?? (async () => {})

  /** Sessions this bridge dispatched work to. */
  const owned = new Set()
  /** `sessionId:turn` keys already pushed, or already ended when first seen. */
  const done = new Set()
  /** Per-session bookkeeping. `wasRunning` survives a reconnect on purpose. */
  const states = new Map()
  /** URIs subscribed on the current upstream session. */
  const subscribed = new Set()
  /** `dsh://sessions` rows by id (all-mode eligibility needs `origin`). */
  const rows = new Map()
  /** Long-running bridges keep only the newest entries of each collection. */
  const MAX_TRACKED = 1000
  const bound = (collection) => {
    while (collection.size > MAX_TRACKED) {
      collection.delete(collection.keys().next().value)
    }
  }
  /** Unseen ids a turn update named: their first sight must not be a silent baseline. */
  const hinted = new Set()

  let refreshTimer
  let refreshing
  let refreshAgain = false
  let starting
  let startAgain = false

  function stateOf(sessionId) {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { wasRunning: false, baseline: undefined, inflight: undefined, again: false, timer: undefined, retries: 0 }
      states.set(sessionId, state)
      bound(states)
    }
    return state
  }

  async function subscribe(uri) {
    if (subscribed.has(uri)) return
    try {
      await rpc('resources/subscribe', { uri })
      subscribed.add(uri)
    } catch (error) {
      log(`could not subscribe to ${uri}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function readJson(uri) {
    return contentsJson(await rpc('resources/read', { uri }))
  }

  async function readTitle(sessionId) {
    try {
      const projections = await readJson(`dsh://session/${sessionId}/projections`)
      const title = projections?.title ?? projections?.projections?.title
      return typeof title === 'string' ? title : ''
    } catch {
      return ''
    }
  }

  async function checkOnce(sessionId, options) {
    const state = stateOf(sessionId)
    let status
    try {
      status = await readJson(`dsh://session/${sessionId}/status`)
    } catch (error) {
      log(`status read failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (status === undefined || status === null) return
    if (status.running === true) {
      state.wasRunning = true
      // A settlement push can land a moment before the status flips; look again.
      if (options.retry === true && state.retries < 5) {
        state.retries += 1
        schedule(sessionId, { retry: true }, 300)
      }
      return
    }
    state.retries = 0
    const turn = status.lastTurn?.turn
    if (status.running !== false || typeof turn !== 'number') return
    const key = `${sessionId}:${turn}`
    if (done.has(key)) return
    done.add(key)
    bound(done)
    // History is not news: a turn that was already over when tracking began is
    // only recorded, unless this session was seen running before (a reconnect).
    if (options.baseline === true && !state.wasRunning) return
    state.wasRunning = false
    const title = await readTitle(sessionId)
    emit(buildChannelParams({
      sessionId,
      title,
      turn,
      reason: status.lastTurn.reason,
      failure: status.failure,
    }))
  }

  /** Run a check, merging concurrent requests for one session into one rerun. */
  function runCheck(sessionId, options = {}) {
    const state = stateOf(sessionId)
    if (state.inflight !== undefined) {
      state.again = true
      return state.inflight
    }
    state.inflight = (async () => {
      let next = options
      do {
        state.again = false
        await checkOnce(sessionId, next)
        next = {}
      } while (state.again)
    })().catch((error) => {
      log(`check failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      state.inflight = undefined
    })
    return state.inflight
  }

  function schedule(sessionId, options, delay = debounceMs) {
    const state = stateOf(sessionId)
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      void runCheck(sessionId, options)
    }, delay)
    state.timer.unref?.()
  }

  async function track(sessionId) {
    const state = stateOf(sessionId)
    await subscribe(`dsh://session/${sessionId}/turn`)
    await subscribe(`dsh://session/${sessionId}/status`)
    state.baseline ??= runCheck(sessionId, { baseline: true })
    return state.baseline
  }

  function eligibleRow(row) {
    if (scope === 'all') return row.origin !== 'subagent'
    return owned.has(row.sessionId)
  }

  async function refreshOnce() {
    const list = await readJson(SESSIONS_URI)
    if (!Array.isArray(list?.sessions)) return
    for (const row of list.sessions) {
      if (row === null || typeof row !== 'object' || typeof row.sessionId !== 'string') continue
      rows.set(row.sessionId, row)
      bound(rows)
      if (!eligibleRow(row)) continue
      const isNew = !states.has(row.sessionId)
      const state = stateOf(row.sessionId)
      if (row.running === true || hinted.has(row.sessionId)) state.wasRunning = true
      hinted.delete(row.sessionId)
      if (isNew) {
        await track(row.sessionId)
      } else if (row.running === false && state.wasRunning) {
        void runCheck(row.sessionId)
      }
    }
  }

  function refresh() {
    if (refreshing !== undefined) {
      refreshAgain = true
      return refreshing
    }
    refreshing = (async () => {
      do {
        refreshAgain = false
        try {
          await refreshOnce()
        } catch (error) {
          log(`session list read failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      } while (refreshAgain)
    })().finally(() => {
      refreshing = undefined
    })
    return refreshing
  }

  function scheduleRefresh() {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, debounceMs)
    refreshTimer.unref?.()
  }

  async function startOnce() {
    await whenPushReady()
    // A fresh upstream session has none of the earlier subscriptions.
    subscribed.clear()
    await subscribe(SESSIONS_URI)
    for (const [sessionId, state] of states) {
      state.baseline = undefined
      await track(sessionId)
    }
    await refresh()
  }

  return {
    /** (Re)build subscriptions and baselines on a fresh upstream session. */
    start() {
      if (starting !== undefined) {
        startAgain = true
        return starting
      }
      starting = (async () => {
        do {
          startAgain = false
          await startOnce()
        } while (startAgain)
      })().finally(() => {
        starting = undefined
      })
      return starting
    },

    /** Record a session as dispatched through this bridge, without blocking. */
    markOwned(sessionId) {
      owned.add(sessionId)
      bound(owned)
      void track(sessionId).catch(() => {})
    },

    /**
     * Subscribe and baseline a session BEFORE a prompt is forwarded, so a turn
     * that settles quickly cannot slip past a subscription made afterwards.
     */
    async prepare(sessionId, timeoutMs = 3000) {
      owned.add(sessionId)
      bound(owned)
      await whenPushReady()
      let timer
      const limit = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
      try {
        // A prompt expects one ending. Flag it only after the baseline, which would
        // otherwise announce the previous (already finished) turn; a disconnect
        // that swallows the ending is then replayed on reconnect.
        const baselined = track(sessionId).then(() => {
          stateOf(sessionId).wasRunning = true
        })
        await Promise.race([baselined, limit])
      } finally {
        clearTimeout(timer)
      }
    },

    /** Feed one `notifications/resources/updated` uri from the upstream. */
    onResourceUpdated(uri) {
      if (typeof uri !== 'string') return
      if (uri === SESSIONS_URI) {
        scheduleRefresh()
        return
      }
      const match = SESSION_FEED.exec(uri)
      if (match === null) return
      const sessionId = match[1]
      const retry = match[2] === 'turn'
      if (scope === 'owned') {
        if (owned.has(sessionId)) schedule(sessionId, { retry })
        return
      }
      if (states.has(sessionId)) {
        schedule(sessionId, { retry })
        return
      }
      // all mode, unseen id: the list says whether it is a sub-agent.
      hinted.add(sessionId)
      void refresh().then(() => {
        hinted.delete(sessionId)
        if (states.has(sessionId)) schedule(sessionId, { retry })
      })
    },
  }
}
