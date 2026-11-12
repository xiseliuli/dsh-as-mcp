/**
 * Feed resources as a client sees them over the wire.
 *
 * The collector's event mapping is tested in `feeds.test.ts`; this file pins the
 * MCP resource surface: which templates exist per enabled tool group, and that a
 * `resources/read` on each announced URI answers the JSON payload a push
 * notification tells the client to fetch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DshLogger } from '../src/dsh/types.js'
import type { SessionStatus, ShellJobPeek } from '../src/dsh/driver.js'
import { EventFeeds, type FeedDriver } from '../src/mcp/feeds.js'
import { boot, readJsonRpc, rpc, stubDriver, testConfig } from './harness.js'

const silentLog: DshLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** The driver slice the feeds read. */
function feedDriver(): FeedDriver {
  const job: ShellJobPeek = {
    jobId: 'shell-1',
    command: 'npm test',
    status: 'completed',
    startedAt: 1,
    finishedAt: 2,
    exitCode: 0,
    signal: null,
    pendingBytes: 0,
    tail: 'all tests passed',
    tailTruncated: false,
  }
  const status: SessionStatus = {
    sessionId: 'session-1',
    running: false,
    openTurn: null,
    openStep: null,
    lastEventSeq: 2,
    lastEventAt: '2026-01-01T00:00:02.000Z',
    idleMs: 10,
    lastTurn: null,
    failure: null,
    stalled: false,
    logReadable: true,
    waitedMs: 0,
  }
  return {
    ownsSession: () => true,
    sessionStatus: async ({ sessionId }) => ({ ...status, sessionId }),
    listSessions: async () => ({
      sessions: [{ sessionId: 'session-1', updatedAt: 1, running: false, blank: false }],
      total: 1,
    }),
    sessionEventTail: async ({ sessionId }) => ({
      sessionId,
      asOfSeq: 2,
      events: [{ seq: 2, type: 'turn/start', at: '2026-01-01T00:00:02.000Z' }],
    }),
    sessionProjectionValues: async () => ({ workingDirectory: '/tmp/repo' }),
    listShellJobs: () => [job],
    peekShellJob: (jobId) => (jobId === 'shell-1' ? job : undefined),
  }
}

/** Build a started collector over a bus that never fires in these tests. */
function feeds(): { feeds: EventFeeds; stop: () => void } {
  const collector = new EventFeeds({
    ctx: { on: () => () => true },
    driver: feedDriver(),
    pushes: {
      hasSubscribers: () => false,
      resourceUpdated: () => {},
      resourceUpdatedNow: () => {},
    },
    log: silentLog,
    getConfig: () => testConfig({ shell: true }),
  })
  return { feeds: collector, stop: collector.start() }
}

async function body(url: string, message: unknown, id: number): Promise<Record<string, unknown>> {
  const response = await rpc(url, message)
  return await readJsonRpc(response, id)
}

describe('feed resources on the wire', () => {
  let url = ''
  let stopEndpoint: () => Promise<void> = async () => {}
  let collector: EventFeeds | undefined
  let stopFeeds: () => void = () => {}

  beforeAll(async () => {
    const built = feeds()
    collector = built.feeds
    stopFeeds = built.stop
    const booted = await boot(stubDriver(), testConfig({ shell: true }), { feeds: collector })
    url = booted.url
    stopEndpoint = booted.stop
  })

  afterAll(async () => {
    stopFeeds()
    await stopEndpoint()
  })

  it('advertises every template feed', async () => {
    const body_ = await body(url, { jsonrpc: '2.0', id: 1, method: 'resources/templates/list', params: {} }, 1)
    const templates = (body_.result as { resourceTemplates?: { uriTemplate?: string }[] }).resourceTemplates ?? []
    const uris = templates.map((template) => template.uriTemplate)
    expect(uris).toContain('dsh://session/{sessionId}/turn')
    expect(uris).toContain('dsh://session/{sessionId}/events')
    expect(uris).toContain('dsh://session/{sessionId}/assistant')
    expect(uris).toContain('dsh://session/{sessionId}/status')
    expect(uris).toContain('dsh://session/{sessionId}/projections')
    expect(uris).toContain('dsh://jobs/{jobId}')
  })

  it('lists the static feeds', async () => {
    const body_ = await body(url, { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} }, 2)
    const resources = (body_.result as { resources?: { uri?: string }[] }).resources ?? []
    const uris = resources.map((resource) => resource.uri)
    expect(uris).toContain('dsh://sessions')
    expect(uris).toContain('dsh://jobs')
  })

  it('reads each session feed as JSON', async () => {
    const cases: [string, number, (payload: Record<string, unknown>) => void][] = [
      ['dsh://session/session-1/events', 3, (payload) => expect(payload.asOfSeq).toBe(2)],
      ['dsh://session/session-1/status', 4, (payload) => expect(payload.sessionId).toBe('session-1')],
      ['dsh://session/session-1/projections', 5, (payload) => expect(payload.workingDirectory).toBe('/tmp/repo')],
      ['dsh://session/session-1/assistant', 6, (payload) => expect(payload.frames).toEqual([])],
    ]
    for (const [uri, id, assert] of cases) {
      const body_ = await body(url, { jsonrpc: '2.0', id, method: 'resources/read', params: { uri } }, id)
      const contents = (body_.result as { contents?: { mimeType?: string; text?: string }[] }).contents ?? []
      expect(contents[0]?.mimeType, uri).toBe('application/json')
      assert(JSON.parse(contents[0]?.text ?? '{}') as Record<string, unknown>)
    }
  })

  it('reads the session list and shell-job feeds as JSON', async () => {
    const sessions = await body(url, {
      jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'dsh://sessions' },
    }, 7)
    const sessionsText = (sessions.result as { contents?: { text?: string }[] }).contents?.[0]?.text ?? '{}'
    expect((JSON.parse(sessionsText) as { total: number }).total).toBe(1)

    const jobs = await body(url, {
      jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'dsh://jobs' },
    }, 8)
    const jobsText = (jobs.result as { contents?: { text?: string }[] }).contents?.[0]?.text ?? '{}'
    expect((JSON.parse(jobsText) as { jobs: { jobId: string }[] }).jobs[0]?.jobId).toBe('shell-1')

    const job = await body(url, {
      jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'dsh://jobs/shell-1' },
    }, 9)
    const jobText = (job.result as { contents?: { text?: string }[] }).contents?.[0]?.text ?? '{}'
    expect((JSON.parse(jobText) as { tail: string }).tail).toBe('all tests passed')
  })

  it('answers a read of an unknown job as an error, not an empty payload', async () => {
    const body_ = await body(url, {
      jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'dsh://jobs/missing' },
    }, 10)
    expect(body_.error).toBeDefined()
  })
})

describe('feed resources respect tool groups', () => {
  it('advertises resources.subscribe in a shell-only profile so job feeds can be listened to', async () => {
    // Job feeds are registered by the shell group; the capability used to be
    // advertised only under the session group, so a modern listen filter naming
    // dsh://jobs was silently dropped there.
    const built = feeds()
    const booted = await boot(stubDriver(), testConfig({ session: false, shell: true }), { feeds: built.feeds })
    try {
      const init = await body(booted.url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } },
      }, 1)
      const capabilities = (init.result as { capabilities?: { resources?: { subscribe?: boolean } } }).capabilities
      expect(capabilities?.resources?.subscribe).toBe(true)
    } finally {
      built.stop()
      await booted.stop()
    }
  })

  it('registers no session feed when the session group is disabled', async () => {
    const built = feeds()
    const booted = await boot(stubDriver(), testConfig({ session: false, shell: true }), { feeds: built.feeds })
    try {
      const body_ = await body(booted.url, {
        jsonrpc: '2.0', id: 1, method: 'resources/templates/list', params: {},
      }, 1)
      const uris = ((body_.result as { resourceTemplates?: { uriTemplate?: string }[] }).resourceTemplates ?? [])
        .map((template) => template.uriTemplate)
      expect(uris).not.toContain('dsh://session/{sessionId}/events')
      expect(uris).not.toContain('dsh://session/{sessionId}/turn')
      // The shell job template belongs to the shell group and survives.
      expect(uris).toContain('dsh://jobs/{jobId}')
    } finally {
      built.stop()
      await booted.stop()
    }
  })
})
