import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TOKEN, boot, callTool, readJsonRpc, rpc, silentLog, stubDriver, testConfig } from './harness.js'
import { MAX_REQUEST_BYTES, createRequestHandler, declaresOversizedBody, startListener } from '../src/mcp/http.js'

describe('endpoint admission', () => {
  it('answers 401 with a Bearer challenge so a standard client knows to authenticate', async () => {
    const own = await boot(stubDriver())
    try {
      const response = await fetch(own.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })
      expect(response.status).toBe(401)
      // Without this header a standard MCP client cannot tell that presenting a
      // bearer token is the fix, so it reports a dead endpoint instead of retrying.
      expect(response.headers.get('www-authenticate')).toContain('Bearer')
    } finally {
      await own.stop()
    }
  })
})

describe('request body bound', () => {
  it('accepts an undeclared, small, or exactly-at-cap body', () => {
    expect(declaresOversizedBody({})).toBe(false)
    expect(declaresOversizedBody({ 'content-length': '1024' })).toBe(false)
    expect(declaresOversizedBody({ 'content-length': MAX_REQUEST_BYTES })).toBe(false)
    expect(declaresOversizedBody({ 'content-length': MAX_REQUEST_BYTES + 1 })).toBe(true)
    // A header the server cannot parse is not treated as a declared size: the
    // HTTP layer rejects malformed requests before they reach here.
    expect(declaresOversizedBody({ 'content-length': 'not-a-number' })).toBe(false)
  })
})

describe('MCP Streamable HTTP endpoint', () => {
  let url: string
  let stop: () => Promise<void>

  beforeAll(async () => {
    const booted = await boot(stubDriver())
    url = booted.url
    stop = booted.stop
  })

  afterAll(async () => {
    await stop()
  })

  it('reports the OS-assigned port, not the requested 0', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  })

  it('rejects a request with no token', async () => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null })
    expect(response.status).toBe(401)
  })

  it('rejects a request with a wrong token', async () => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'nope' })
    expect(response.status).toBe(401)
  })

  it('accepts the token as a query parameter, for clients with no header support', async () => {
    const response = await rpc(`${url}?token=${TOKEN}`, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/list',
      params: {},
    }, { token: null })
    expect(response.status).toBe(200)
  })

  it('404s on any other path', async () => {
    const response = await fetch(url.replace('/mcp', '/other'), { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('completes the initialize handshake', async () => {
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } },
    })
    expect(response.status).toBe(200)
    const body = (await readJsonRpc(response, 1)) as {
      result?: { serverInfo?: { name?: string }; protocolVersion?: string }
    }
    expect(body.result?.serverInfo?.name).toBe('dsh-as-mcp')
    expect(typeof body.result?.protocolVersion).toBe('string')
  })

  it('sends the workflow instructions in the initialize result', async () => {
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 12,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0' } },
    })
    const body = (await readJsonRpc(response, 12)) as { result?: { instructions?: string } }
    const instructions = body.result?.instructions ?? ''
    // The note is what tells a model the intended flow before it sees 20 tools.
    expect(instructions).toContain('dsh_info')
    expect(instructions).toContain('session_prompt')
    expect(instructions).toContain('session_usage')
    // The later tools are how a caller discovers the inspection and queue surface;
    // instructions that stop at the first three tools leave them undiscovered.
    expect(instructions).toContain('toolAvailability')
    expect(instructions).toContain('includeToolCalls')
    expect(instructions).toContain('session_tool_result')
    expect(instructions).toContain('session_queue')
    expect(instructions).toContain('session_search')
    // Fire-and-forget work has no other onboarding surface: a client that starts a
    // turn with wait:false must be told how to follow it, and a waiting caller must
    // be told that a failed turn arrives as turn.failure.
    expect(instructions).toContain('session_status')
    expect(instructions).toContain('waitMs')
    expect(instructions).toContain('turn.failure')
    expect(instructions).toContain('token')
    // The worktree and archive features are new surface a client must be able to
    // discover from the handshake alone, like the fire-and-forget contract above.
    expect(instructions).toContain('worktree')
    expect(instructions).toContain('worktree_restore')
    expect(instructions).toContain('archive')
  })

  // The tool surface is the only thing a client sees when it ignores the
  // instructions (many hosts do not forward them to their model). Pin the
  // fire-and-forget contract where such a client will actually read it.
  it('teaches a first-time client the fire-and-forget contract in the tool surface', async () => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 13, method: 'tools/list', params: {} })
    const body = (await readJsonRpc(response, 13)) as {
      result?: { tools?: {
        name: string
        description?: string
        inputSchema?: { properties?: Record<string, { description?: string }> }
        outputSchema?: { properties?: Record<string, unknown> }
      }[] }
    }
    const tools = body.result?.tools ?? []
    const prompt = tools.find((tool) => tool.name === 'session_prompt')
    const status = tools.find((tool) => tool.name === 'session_status')
    expect(prompt).toBeDefined()
    expect(status).toBeDefined()

    // A failed turn must be discoverable from the prompt tool itself.
    expect(prompt?.description).toContain('turn.failure')
    expect(prompt?.description).toContain('session_status')
    expect(prompt?.inputSchema?.properties?.wait?.description).toContain('session_status')
    expect(Object.keys(prompt?.outputSchema?.properties ?? {})).toEqual(expect.arrayContaining(['turn']))
    expect(JSON.stringify(prompt?.outputSchema)).toContain('failure')

    // And the status tool must advertise the fields a supervisor acts on.
    const statusFields = Object.keys(status?.outputSchema?.properties ?? {})
    expect(statusFields).toEqual(expect.arrayContaining([
      'failure', 'stalled', 'idleMs', 'lastTurn', 'changed', 'waitedMs', 'workingDirectory', 'worktree',
    ]))
  })

  it('lists the enabled tools and hides a disabled group', async () => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const body = (await readJsonRpc(response, 2)) as { result?: { tools?: { name: string }[] } }
    const names = (body.result?.tools ?? []).map((tool) => tool.name)
    expect(names).toContain('dsh_info')
    expect(names).toContain('workspace_create')
    expect(names).toContain('session_prompt')
    expect(names).toContain('worktree_create')
    expect(names).toContain('worktree_restore')
    expect(names).toContain('session_archive')
    expect(names).toContain('session_pin')
    expect(names).toContain('file_read')
    expect(names).toContain('file_edit')
    expect(names).not.toContain('shell_run')
  })

  it('calls a tool and returns its JSON payload', async () => {
    const { isError, text } = await callTool(url, 'dsh_info', {})
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toMatchObject({
      tokenSource: expect.any(String),
      enabledToolGroups: { shell: false, session: true },
    })
    // dsh_info describes the endpoint; it must not disclose the credential that
    // reached it, or every calling agent's transcript would carry the secret.
    expect(text).not.toContain(TOKEN)
  })

  it('routes a tool argument through to the driver', async () => {
    const { text } = await callTool(url, 'workspace_create', { path: '/tmp/example', title: 'Example' })
    const payload = JSON.parse(text) as { created: boolean; workspace: { path: string; title: string } }
    expect(payload.created).toBe(true)
    expect(payload.workspace.path).toBe('/tmp/example')
    expect(payload.workspace.title).toBe('Example')
  })

  it('routes the orchestration arguments through to the driver', async () => {
    const calls: Record<string, unknown>[] = []
    const recording = await boot(stubDriver({
      runSessionCommand: async (request) => {
        // The request also carries the client's abort signal; the assertion is
        // about the arguments, so only the meaningful fields are recorded.
        calls.push({ tool: 'session_command', sessionId: request.sessionId, command: request.command })
        return { sessionId: request.sessionId, commandId: 'c-1', ok: true, text: 'compacted' }
      },
      mutateSessionGoal: async (request) => {
        calls.push({ tool: 'session_goal', ...request })
        return { sessionId: request.sessionId, action: request.action, goal: null, cleared: true }
      },
    }))
    try {
      const listed = await callTool(recording.url, 'session_command_list', { sessionId: 'session-1' })
      expect(JSON.parse(listed.text)).toMatchObject({ sessionId: 'session-1' })
      const ran = await callTool(recording.url, 'session_command', {
        sessionId: 'session-1',
        command: '/compact',
      })
      expect(JSON.parse(ran.text)).toMatchObject({ ok: true, text: 'compacted' })
      const goal = await callTool(recording.url, 'session_goal', {
        sessionId: 'session-1',
        action: 'create',
        objective: 'ship the release',
        maxGoalRounds: 6,
        expectedRevision: 2,
      })
      expect(JSON.parse(goal.text)).toMatchObject({ action: 'create', cleared: true })
      // Every schema option must reach the driver: an accepted-but-dropped argument
      // is the drift the release check exists to prevent.
      expect(calls).toEqual([
        { tool: 'session_command', sessionId: 'session-1', command: '/compact' },
        {
          tool: 'session_goal',
          sessionId: 'session-1',
          action: 'create',
          objective: 'ship the release',
          maxGoalRounds: 6,
          expectedRevision: 2,
        },
      ])
      // A read action must not be routed through the mutator.
      const read = await callTool(recording.url, 'session_goal', { sessionId: 'session-1', action: 'get' })
      expect(JSON.parse(read.text)).toEqual({ sessionId: 'session-1', goal: null })
      expect(calls).toHaveLength(2)
    } finally {
      await recording.stop()
    }
  })

  it('routes the schedule arguments through to the driver', async () => {
    const calls: Record<string, unknown>[] = []
    const recording = await boot(stubDriver({
      createScheduledTask: async (request) => {
        calls.push({ tool: 'schedule_create', ...request })
        return {
          task: {
            id: 'schedule-1', kind: 'every', title: request.title, prompt: request.prompt,
            scheduledAt: '2026-01-01T00:00:00.000Z', status: 'active', target: { kind: 'new', create: {} },
          },
        }
      },
      listScheduledTasks: async (request = {}) => {
        calls.push({ tool: 'schedule_list', ...request })
        return { items: [], shown: 0, total: 0, limit: request.limit ?? 20, offset: request.offset ?? 0 }
      },
      viewScheduledTask: async (request) => {
        calls.push({ tool: 'schedule_view', ...request })
        return { found: false, id: request.scheduleId }
      },
      editScheduledTask: async (request) => {
        calls.push({ tool: 'schedule_edit', ...request })
        return { found: false, deleted: true, id: request.scheduleId }
      },
    }))
    try {
      const created = await callTool(recording.url, 'schedule_create', {
        title: 'hourly sweep',
        prompt: 'check the build',
        everySeconds: 3600,
        target: 'session',
        sessionId: 'session-1',
      })
      expect(JSON.parse(created.text)).toMatchObject({ task: { id: 'schedule-1' } })
      await callTool(recording.url, 'schedule_list', { active: false, limit: 5, offset: 10 })
      await callTool(recording.url, 'schedule_view', { scheduleId: 'schedule-1' })
      await callTool(recording.url, 'schedule_edit', {
        scheduleId: 'schedule-1',
        action: 'delete',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      })
      expect(calls).toEqual([
        {
          tool: 'schedule_create',
          title: 'hourly sweep',
          prompt: 'check the build',
          everySeconds: 3600,
          target: 'session',
          sessionId: 'session-1',
        },
        { tool: 'schedule_list', active: false, limit: 5, offset: 10 },
        { tool: 'schedule_view', scheduleId: 'schedule-1' },
        {
          tool: 'schedule_edit',
          scheduleId: 'schedule-1',
          action: 'delete',
          expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        },
      ])
    } finally {
      await recording.stop()
    }
  })

  it('reports a harness failure as a tool error, not a transport error', async () => {
    const failing = await boot(
      stubDriver({
        listWorkspaces: async () => {
          throw new Error('harness exploded')
        },
      }),
    )
    try {
      const { isError, text } = await callTool(failing.url, 'workspace_list', {})
      expect(isError).toBe(true)
      expect(text).toContain('harness exploded')
      // The stack goes to the DSH log, not into another agent's context.
      expect(text).not.toMatch(/\n\s+at /)
      expect(text).not.toContain('driver.ts')
    } finally {
      await failing.stop()
    }
  })

  it('rejects an unknown tool at the protocol layer', async () => {
    // The SDK answers an unregistered name with a JSON-RPC error rather than a
    // tool result, so a client that only inspects `result.isError` would miss it.
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 88,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    })
    const body = (await readJsonRpc(response, 88)) as {
      result?: unknown
      error?: { code: number; message: string }
    }
    expect(body.result).toBeUndefined()
    expect(body.error?.message).toContain('no_such_tool')
  })

  it('serves a second listener independently, so two profiles can coexist', async () => {
    const other = await boot(stubDriver(), testConfig({ workspace: false }))
    try {
      const response = await rpc(other.url, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} })
      const body = (await readJsonRpc(response, 7)) as { result?: { tools?: { name: string }[] } }
      const names = (body.result?.tools ?? []).map((tool) => tool.name)
      expect(names).not.toContain('workspace_create')
      expect(names).toContain('dsh_info')
    } finally {
      await other.stop()
    }
  })

  it('cancels the turn behind a notifications/cancelled request', async () => {
    // The SDK in use acknowledges notifications/cancelled and does nothing else
    // with it, so the endpoint routes the notification itself: a cancelled
    // session_prompt must stop its turn instead of letting it run to completion.
    const cancelled: string[] = []
    let release: (() => void) | undefined
    const own = await boot(stubDriver({
      promptSession: () => new Promise((resolve) => {
        release = () => resolve({ accepted: true })
      }),
      cancelSession: async (sessionId: string) => {
        cancelled.push(sessionId)
        release?.()
        return { accepted: true }
      },
    }), testConfig({ session: true, usage: false }))
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    }
    try {
      const pending = fetch(own.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 77,
          method: 'tools/call',
          params: { name: 'session_prompt', arguments: { sessionId: 'session-1', prompt: 'go' } },
        }),
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      const notify = await fetch(own.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 77, reason: 'client changed its mind' },
        }),
      })
      expect(notify.ok).toBe(true)
      const response = await pending
      expect(response.status).toBe(200)
      expect(cancelled).toEqual(['session-1'])
    } finally {
      await own.stop()
    }
  })

  it('ignores a cancellation for a request it does not know', async () => {
    const cancelled: string[] = []
    const own = await boot(stubDriver({
      cancelSession: async (sessionId: string) => {
        cancelled.push(sessionId)
        return { accepted: true }
      },
    }), testConfig({ session: true }))
    try {
      const response = await fetch(own.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 'nope' },
        }),
      })
      expect(response.ok).toBe(true)
      expect(cancelled).toEqual([])
    } finally {
      await own.stop()
    }
  })

  it('removes exactly the disabled group from tools/list', async () => {
    const groups: Record<string, string[]> = {
      workspace: ['workspace_create', 'workspace_list', 'workspace_delete'],
      session: [
        'session_create', 'worktree_create', 'worktree_restore', 'session_search', 'session_status', 'session_list',
        'session_prompt', 'session_messages', 'session_tool_result', 'session_queue', 'session_cancel',
        'session_fork', 'session_rename', 'session_set_model', 'session_archive', 'session_unarchive',
        'session_pin', 'session_unpin', 'session_command_list', 'session_command', 'session_goal',
        'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
      ],
      files: ['file_read', 'file_read_image', 'file_write', 'file_edit', 'file_list'],
      shell: ['shell_run', 'shell_start', 'shell_output', 'shell_kill', 'shell_list'],
      agentTools: ['dsh_tool_list', 'dsh_tool_call'],
      usage: ['session_usage'],
    }
    const allOn = {
      workspace: true, session: true, files: true, shell: true, agentTools: true, usage: true,
    }

    const full = await boot(stubDriver(), testConfig(allOn))
    try {
      const response = await rpc(full.url, { jsonrpc: '2.0', id: 60, method: 'tools/list', params: {} })
      const body = (await readJsonRpc(response, 60)) as { result?: { tools?: { name: string }[] } }
      const all = (body.result?.tools ?? []).map((tool) => tool.name)
      expect(all).toHaveLength(42)
      expect(all).toContain('dsh_info')
      for (const names of Object.values(groups)) for (const name of names) expect(all).toContain(name)
    } finally {
      await full.stop()
    }

    // A disabled group leaves the list entirely — a disabled tool is absent, not
    // present-then-refused, and the other groups are untouched.
    for (const group of Object.keys(groups)) {
      const own = await boot(stubDriver(), testConfig({ ...allOn, [group]: false }))
      try {
        const response = await rpc(own.url, { jsonrpc: '2.0', id: 61, method: 'tools/list', params: {} })
        const body = (await readJsonRpc(response, 61)) as { result?: { tools?: { name: string }[] } }
        const names = (body.result?.tools ?? []).map((tool) => tool.name)
        for (const name of groups[group] as string[]) expect(names).not.toContain(name)
        for (const [other, otherNames] of Object.entries(groups)) {
          if (other === group) continue
          for (const name of otherNames) expect(names).toContain(name)
        }
        expect(names).toContain('dsh_info')
      } finally {
        await own.stop()
      }
    }
  })

  it('releases the port when disposed, so a restart does not fail', async () => {
    const first = await boot(stubDriver())
    const port = new URL(first.url).port
    await first.stop()
    const config = testConfig({}, Number(port))
    const requestHandler = createRequestHandler({
      deps: {
        driver: stubDriver(),
        getConfig: () => config,
        status: () => ({
          listening: true,
          url: first.url,
          mountedOnWebServer: false,
          error: null,
          tokenSource: 'test',
          token: 'x',
          settingsRegistered: false,
          tokenFile: '/tmp/dsh-as-mcp/token',
          enabledToolGroups: ['workspace', 'session', 'files'],
        }),
        connection: () => ({ url: first.url, token: 'x', tokenSource: 'test', mountedOnWebServer: false }),
        log: silentLog,
      },
      getToken: () => 'x',
      log: silentLog,
    })
    const second = await startListener({ config, handler: requestHandler.handle, log: silentLog })
    expect(new URL(second.url).port).toBe(port)
    await second.dispose()
    await requestHandler.close()
  })

  it('forwards session_prompt images and the request abort signal', async () => {
    const seen: Record<string, unknown>[] = []
    const own = await boot(stubDriver({
      promptSession: async (request) => {
        seen.push(request as unknown as Record<string, unknown>)
        return { accepted: true }
      },
    }))
    try {
      const { isError } = await callTool(own.url, 'session_prompt', {
        sessionId: 'session-1',
        prompt: 'what is this?',
        images: [{ path: '/shots/a.png' }],
      })
      expect(isError).toBe(false)
      expect(seen[0]?.images).toEqual([{ path: '/shots/a.png' }])
      // The handler must hand the driver a signal: that is what lets a cancelled
      // MCP request stop the wait instead of running to its timeout.
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      await own.stop()
    }
  })

  it('returns an image content block for file_read_image', async () => {
    const endpoint = await boot(stubDriver({
      readImage: async ({ path }) => ({
        path,
        mimeType: 'image/png',
        base64: 'aGVsbG8=',
        bytes: 5,
      }),
    }))
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${testConfig().auth.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 31,
          method: 'tools/call',
          params: { name: 'file_read_image', arguments: { path: '/shot.png' } },
        }),
      })
      const body = await response.text()
      const frame = body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)) as { id?: number; result?: { content?: unknown[] } })
        .find((entry) => entry.id === 31)

      // A text block for machines that do not render images, and the image itself.
      expect(frame?.result?.content).toEqual([
        {
          type: 'text',
          text: JSON.stringify({ path: '/shot.png', mimeType: 'image/png', bytes: 5 }),
        },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ])
    } finally {
      await endpoint.stop()
    }
  })

  it('advertises output schemas and returns matching structuredContent', async () => {
    // `usage: true` so session_usage is registered: the schema is part of what
    // this test checks, and a disabled group has no tool to advertise it on.
    const endpoint = await boot(
      stubDriver({ listWorkspaces: async () => [] }),
      testConfig({ usage: true }),
    )
    try {
      // tools/list must advertise an object schema for the data tools.
      const listResponse = await rpc(endpoint.url, { jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} })
      const listed = (await readJsonRpc(listResponse, 41)) as {
        result?: { tools?: { name: string; outputSchema?: { type?: string } }[] }
      }
      const tools = listed.result?.tools ?? []
      for (const name of ['dsh_info', 'session_list', 'session_usage', 'session_messages', 'file_list', 'workspace_list']) {
        const tool = tools.find((entry) => entry.name === name)
        expect(tool?.outputSchema, `${name} output schema`).toMatchObject({ type: 'object' })
      }

      // And a call returns the same object as text and as structuredContent.
      const callResponse = await rpc(endpoint.url, {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'workspace_list', arguments: {} },
      })
      const called = (await readJsonRpc(callResponse, 42)) as {
        result?: { content?: { text?: string }[]; structuredContent?: { workspaces?: unknown[] } }
      }
      const result = called.result
      expect(JSON.parse(result?.content?.[0]?.text ?? 'null')).toEqual({ workspaces: [] })
      expect(result?.structuredContent).toEqual({ workspaces: [] })
    } finally {
      await endpoint.stop()
    }
  })

  it('forwards a session_prompt idempotency key', async () => {
    const seen: Record<string, unknown>[] = []
    const own = await boot(stubDriver({
      promptSession: async (request) => {
        seen.push(request as unknown as Record<string, unknown>)
        return { accepted: true }
      },
    }))
    try {
      await callTool(own.url, 'session_prompt', {
        sessionId: 'session-1',
        prompt: 'go',
        idempotencyKey: 'message-42',
      })
      expect(seen[0]?.idempotencyKey).toBe('message-42')
    } finally {
      await own.stop()
    }
  })

  it('forwards the shell_list running filter', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      listShellJobs: (options: unknown) => {
        seen.push(options)
        return []
      },
    }), testConfig({ shell: true }))
    try {
      await callTool(own.url, 'shell_list', { running: true })
      expect(seen).toEqual([{ running: true }])
    } finally {
      await own.stop()
    }
  })

  it('reports transcript truncation when the tail window hid messages', async () => {
    const own = await boot(stubDriver({
      readTranscript: async () => ({
        messages: [{ role: 'assistant', text: 'newest', time: 1, seq: 9, chars: 6 }],
        total: 4,
      }),
    }), testConfig({ session: true }))
    try {
      const { isError, text } = await callTool(own.url, 'session_messages', { sessionId: 'session-1', limit: 1 })
      expect(isError).toBe(false)
      const payload = JSON.parse(text) as { messages: unknown[]; total: number; truncated?: boolean }
      expect(payload.messages).toHaveLength(1)
      expect(payload.total).toBe(4)
      expect(payload.truncated).toBe(true)
    } finally {
      await own.stop()
    }
  })

  it('lists the pending queue when session_queue is called without an action', async () => {
    const own = await boot(stubDriver({
      readQueue: async () => ({ queued: [{ id: 'm-1', text: 'later', images: 0 }] }),
    }), testConfig({ session: true }))
    try {
      const { isError, text } = await callTool(own.url, 'session_queue', { sessionId: 's' })
      expect(isError).toBe(false)
      expect(JSON.parse(text)).toEqual({ queued: [{ id: 'm-1', text: 'later', images: 0 }] })
      const half = await callTool(own.url, 'session_queue', { sessionId: 's', action: 'remove' })
      expect(half.isError).toBe(true)
      expect(half.text).toMatch(/pass messageId and action together/)
    } finally {
      await own.stop()
    }
  })

  it('forwards session_queue mutations', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      updateQueue: async (request) => {
        seen.push(request)
        return { accepted: true, action: request.action }
      },
    }), testConfig({ session: true }))
    try {
      const { isError, text } = await callTool(own.url, 'session_queue', {
        sessionId: 's', messageId: 'm', action: 'remove',
      })
      expect(isError).toBe(false)
      expect(seen).toEqual([{ sessionId: 's', messageId: 'm', action: 'remove' }])
      expect(JSON.parse(text)).toEqual({ accepted: true, action: 'remove' })
    } finally {
      await own.stop()
    }
  })

  it('forwards session_tool_result lookups', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      readToolResult: async (request) => {
        seen.push(request)
        return { sessionId: request.sessionId, callId: request.callId ?? 'resolved', chars: 2, text: 'ok' }
      },
    }), testConfig({ session: true }))
    try {
      const { isError, text } = await callTool(own.url, 'session_tool_result', {
        sessionId: 's', callId: 'call-1', maxChars: 10,
      })
      expect(isError).toBe(false)
      expect(seen).toEqual([{ sessionId: 's', callId: 'call-1', maxChars: 10 }])
      expect(JSON.parse(text)).toEqual({ sessionId: 's', callId: 'call-1', chars: 2, text: 'ok' })
    } finally {
      await own.stop()
    }
  })

  it('forwards a held session_status call and returns its report', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      sessionStatus: async (request) => {
        seen.push({ sessionId: request.sessionId, waitMs: request.waitMs })
        return {
          sessionId: request.sessionId,
          running: true,
          openTurn: 4,
          openStep: 2,
          lastEventSeq: 77,
          lastEventAt: '2026-11-03T00:00:00.000Z',
          idleMs: 42_000,
          lastTurn: { turn: 3, endedAt: '2026-11-03T00:00:00.000Z', reason: { kind: 'completed' } },
          failure: null,
          stalled: false,
          logReadable: true,
          changed: true,
          waitedMs: 12,
        }
      },
    }), testConfig({ session: true }))
    try {
      const { isError, text } = await callTool(own.url, 'session_status', { sessionId: 's', waitMs: 5_000 })
      expect(isError).toBe(false)
      expect(seen).toEqual([{ sessionId: 's', waitMs: 5_000 }])
      expect(JSON.parse(text)).toMatchObject({ running: true, openTurn: 4, openStep: 2, stalled: false, changed: true })
    } finally {
      await own.stop()
    }
  })

  it('forwards the turn filter to the transcript read', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      readTranscript: async (_sessionId, _limit, options) => {
        seen.push(options)
        return { messages: [], total: 0 }
      },
    }), testConfig({ session: true }))
    try {
      expect((await callTool(own.url, 'session_messages', { sessionId: 's', turn: 3 })).isError).toBe(false)
      expect(seen).toEqual([{ turn: 3 }])
    } finally {
      await own.stop()
    }
  })

  it('forwards a transcript turn range', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      readTranscript: async (_sessionId, _limit, options) => {
        seen.push(options)
        return { messages: [], total: 0 }
      },
    }), testConfig({ session: true }))
    try {
      expect((await callTool(own.url, 'session_messages', {
        sessionId: 's', fromTurn: 2, toTurn: 3,
      })).isError).toBe(false)
      expect(seen).toEqual([{ fromTurn: 2, toTurn: 3 }])
    } finally {
      await own.stop()
    }
  })

  it('forwards includeToolResults to the transcript read', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      readTranscript: async (_sessionId, _limit, options) => {
        seen.push(options)
        return { messages: [], total: 0 }
      },
    }), testConfig({ session: true }))
    try {
      expect((await callTool(own.url, 'session_messages', { sessionId: 's', includeToolResults: true })).isError).toBe(false)
      expect(seen).toEqual([{ includeToolResults: true }])
    } finally {
      await own.stop()
    }
  })

  it('forwards includeToolCalls to the transcript read', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      readTranscript: async (_sessionId, _limit, options) => {
        seen.push(options)
        return { messages: [], total: 0 }
      },
    }), testConfig({ session: true }))
    try {
      expect((await callTool(own.url, 'session_messages', { sessionId: 's', includeToolCalls: true })).isError).toBe(false)
      expect(seen).toEqual([{ includeToolCalls: true }])
    } finally {
      await own.stop()
    }
  })

  it('forwards beforeSeq when paging a transcript backwards', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      readTranscript: async (_sessionId, _limit, options) => {
        seen.push(options)
        return { messages: [], total: 0 }
      },
    }), testConfig({ session: true }))
    try {
      const { isError } = await callTool(own.url, 'session_messages', { sessionId: 's', beforeSeq: 7 })
      expect(isError).toBe(false)
      expect(seen).toEqual([{ beforeSeq: 7 }])
    } finally {
      await own.stop()
    }
  })

  it('reports per-tool availability derived from the probes', async () => {
    const own = await boot(stubDriver())
    try {
      const payload = JSON.parse((await callTool(own.url, 'dsh_info', {})).text) as {
        toolAvailability?: {
          available: number
          availableTools: string[]
          unavailable: { tool: string; reason: string }[]
        }
      }
      expect(payload.toolAvailability).toBeDefined()
      expect(payload.toolAvailability?.available).toBeGreaterThan(0)
      expect(payload.toolAvailability?.availableTools?.length).toBe(payload.toolAvailability?.available)
      // The stub provides neither a filesystem nor a shell: the tools that need
      // them must be named, with the missing service in the reason.
      const fileRead = payload.toolAvailability?.unavailable.find((entry) => entry.tool === 'file_read')
      expect(fileRead?.reason).toMatch(/filesystem/)
      expect(payload.toolAvailability?.unavailable.some((entry) => entry.tool === 'shell_run')).toBe(true)
      // dsh_info itself is always available.
      expect(payload.toolAvailability?.unavailable.some((entry) => entry.tool === 'dsh_info')).toBe(false)
    } finally {
      await own.stop()
    }
  })

  it('reports the search probe only when asked', async () => {
    const own = await boot(stubDriver({
      probeSessionSearch: async () => ({ available: true, matches: 0 }),
    }))
    try {
      const plain = JSON.parse((await callTool(own.url, 'dsh_info', {})).text) as { search?: unknown }
      expect(plain.search).toBeUndefined()
      const probed = JSON.parse((await callTool(own.url, 'dsh_info', { probeSearch: true })).text) as {
        search?: { available: boolean; matches: number }
      }
      expect(probed.search).toEqual({ available: true, matches: 0 })
    } finally {
      await own.stop()
    }
  })

  it('forwards session_search query and limit', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      searchSessions: async (request) => {
        seen.push(request)
        return { items: [{ sessionId: 'a', snippet: 'hit' }], hasMore: false }
      },
    }), testConfig({ session: true }))
    try {
      const { isError, text } = await callTool(own.url, 'session_search', { query: 'needle', limit: 5 })
      expect(isError).toBe(false)
      expect(seen).toEqual([{ query: 'needle', limit: 5 }])
      const payload = JSON.parse(text) as { items: { sessionId: string }[]; hasMore: boolean }
      expect(payload.items[0]?.sessionId).toBe('a')
      expect(payload.hasMore).toBe(false)
    } finally {
      await own.stop()
    }
  })

  it('reports session_list truncation when the limit hid matches', async () => {
    const own = await boot(stubDriver({
      listSessions: async () => ({
        sessions: [{ sessionId: 'a', running: false, blank: false, updatedAt: 1 }],
        total: 7,
      }),
    }))
    try {
      const { isError, text } = await callTool(own.url, 'session_list', { limit: 1 })
      expect(isError).toBe(false)
      const payload = JSON.parse(text) as { sessions: unknown[]; total: number; truncated?: boolean }
      expect(payload.sessions).toHaveLength(1)
      expect(payload.total).toBe(7)
      expect(payload.truncated).toBe(true)
    } finally {
      await own.stop()
    }
  })

  it('forwards workspace_delete arguments', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      deleteWorkspace: async (request) => {
        seen.push(request)
        return { workspaceId: request.workspaceId, deleted: true }
      },
    }))
    try {
      const { isError, text } = await callTool(own.url, 'workspace_delete', { workspaceId: 'ws-7' })
      expect(isError).toBe(false)
      expect(seen).toEqual([{ workspaceId: 'ws-7' }])
      expect(JSON.parse(text)).toEqual({ workspaceId: 'ws-7', deleted: true })
    } finally {
      await own.stop()
    }
  })

  it('forwards session_list filters and session_usage ids', async () => {
    const lists: unknown[] = []
    const usages: unknown[] = []
    const own = await boot(
      stubDriver({
        listSessions: async (limit, options) => {
          lists.push({ limit, options })
          return { sessions: [], total: 0 }
        },
        sessionUsage: async (request) => {
          usages.push(request)
          return {
            generatedAt: '',
            scope: 'sessionIds',
            sessions: [],
            totals: {
              uncachedInputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              turns: 0,
              steps: 0,
              samples: 0,
            },
            byModel: [],
            subagentsIncluded: false,
            cost: { available: false, reason: 'stub' },
            notes: [],
          }
        },
      }),
      testConfig({ usage: true }),
    )
    try {
      await callTool(own.url, 'session_list', { limit: 5, cwd: '/tmp/x', running: true })
      await callTool(own.url, 'session_usage', { sessionIds: ['a', 'b'] })
      expect(lists[0]).toEqual({ limit: 5, options: { cwd: '/tmp/x', running: true } })
      expect(usages[0]).toMatchObject({ sessionIds: ['a', 'b'] })
    } finally {
      await own.stop()
    }
  })

  it('forwards the transcript and reply character caps', async () => {
    const transcripts: unknown[] = []
    const prompts: Record<string, unknown>[] = []
    const own = await boot(
      stubDriver({
        readTranscript: async (sessionId, limit, options) => {
          transcripts.push({ sessionId, limit, options })
          return { messages: [], total: 0 }
        },
        promptSession: async (request) => {
          prompts.push(request as unknown as Record<string, unknown>)
          return { accepted: true }
        },
      }),
      testConfig({ session: true }),
    )
    try {
      await callTool(own.url, 'session_messages', { sessionId: 'session-1', maxCharsPerMessage: 300 })
      await callTool(own.url, 'session_prompt', { sessionId: 'session-1', prompt: 'go', maxReplyChars: 400 })
      expect(transcripts[0]).toMatchObject({ options: { maxCharsPerMessage: 300 } })
      expect(prompts[0]?.maxReplyChars).toBe(400)
    } finally {
      await own.stop()
    }
  })

  it('forwards dsh_tool_call maxResultChars', async () => {
    const seen: Record<string, unknown>[] = []
    // The agent-tools group is off by default in the test config, and a disabled
    // tool has no handler to forward anything.
    const own = await boot(
      stubDriver({
        callAgentTool: async (request) => {
          seen.push(request as unknown as Record<string, unknown>)
          return { name: request.name, ok: true, text: 'ok', resultBytes: 2 }
        },
      }),
      testConfig({ agentTools: true }),
    )
    try {
      await callTool(own.url, 'dsh_tool_call', {
        name: 'read',
        sessionId: 'session-1',
        maxResultChars: 1234,
      })
      expect(seen[0]?.maxResultChars).toBe(1234)
    } finally {
      await own.stop()
    }
  })

  it('forwards session_set_model arguments', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      setSessionModel: async (request) => {
        seen.push(request)
        return { sessionId: request.sessionId, provider: request.provider, model: request.model }
      },
    }))
    try {
      const { isError, text } = await callTool(own.url, 'session_set_model', {
        sessionId: 'session-1',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        reasoningEffort: 'high',
      })
      expect(isError).toBe(false)
      expect(seen).toEqual([{
        sessionId: 'session-1',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        reasoningEffort: 'high',
      }])
      expect(JSON.parse(text)).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash' })
    } finally {
      await own.stop()
    }
  })

  it('forwards session_rename arguments', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      renameSession: async (request) => {
        seen.push(request)
        return { sessionId: request.sessionId, title: request.title, seq: 9 }
      },
    }))
    try {
      const { isError, text } = await callTool(own.url, 'session_rename', {
        sessionId: 'session-1',
        title: 'Named by the caller',
      })
      expect(isError).toBe(false)
      expect(seen).toEqual([{ sessionId: 'session-1', title: 'Named by the caller' }])
      expect(JSON.parse(text)).toMatchObject({ title: 'Named by the caller', seq: 9 })
    } finally {
      await own.stop()
    }
  })

  it('forwards session_fork arguments', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      forkSession: async (request) => {
        seen.push(request)
        return {
          sessionId: 'session-child',
          parentSessionId: request.sessionId,
          inheritedEventCount: 7,
          cwd: '/tmp/project',
        }
      },
    }))
    try {
      const { isError, text } = await callTool(own.url, 'session_fork', {
        sessionId: 'session-live',
        atSeq: 6,
      })
      expect(isError).toBe(false)
      expect(seen).toEqual([{ sessionId: 'session-live', atSeq: 6 }])
      expect(JSON.parse(text)).toMatchObject({ sessionId: 'session-child', inheritedEventCount: 7 })
    } finally {
      await own.stop()
    }
  })

  it('forwards file_edit arguments, with the configured byte ceiling', async () => {
    const seen: Record<string, unknown>[] = []
    const own = await boot(stubDriver({
      editFile: async (request) => {
        seen.push(request as unknown as Record<string, unknown>)
        return { path: request.path, replacements: 1, bytesBefore: 10, bytesAfter: 11, sha256: 'stub' }
      },
    }))
    try {
      const { isError } = await callTool(own.url, 'file_edit', {
        path: '/a.ts',
        oldText: 'old',
        newText: 'new',
        replaceAll: true,
      })
      expect(isError).toBe(false)
      // `maxBytes` comes from the operator's configuration, not the caller: an
      // edit must not be a way to read a file the read limit excludes.
      expect(seen).toEqual([{
        path: '/a.ts',
        oldText: 'old',
        newText: 'new',
        replaceAll: true,
        maxBytes: 1024,
      }])
    } finally {
      await own.stop()
    }
  })

  it('forwards incremental transcript filters', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      readTranscript: async (sessionId, limit, options) => {
        seen.push({ sessionId, limit, options })
        return { messages: [{ role: 'assistant', text: 'new', time: 1, seq: 9, chars: 3 }], total: 4 }
      },
    }))
    try {
      const { text } = await callTool(own.url, 'session_messages', {
        sessionId: 'session-1',
        sinceSeq: 8,
        role: 'assistant',
        limit: 5,
      })
      expect(JSON.parse(text)).toMatchObject({ messages: [{ seq: 9 }] })
      expect(seen).toEqual([{ sessionId: 'session-1', limit: 5, options: { sinceSeq: 8, role: 'assistant' } }])
    } finally {
      await own.stop()
    }
  })

  it('forwards a file_read byte offset through the tool layer', async () => {
    const seen: Record<string, unknown>[] = []
    const own = await boot(stubDriver({
      readFile: async (request) => {
        seen.push(request as unknown as Record<string, unknown>)
        return {
          path: request.path,
          text: 'tail',
          truncated: false,
          offset: request.offset ?? 0,
          bytes: 4,
        }
      },
    }))
    try {
      const { isError, text } = await callTool(own.url, 'file_read', { path: '/a.txt', offset: 128 })
      expect(isError).toBe(false)
      // The tool must pass the offset straight through: it is the difference
      // between reading a 2 MB log and paying for all of it.
      expect(seen).toEqual([{ path: '/a.txt', maxBytes: 1024, offset: 128 }])
      expect(JSON.parse(text)).toMatchObject({ text: 'tail', offset: 128 })

      // A caller may ask for a smaller window (cheap paging), and never for more
      // than the operator's configured ceiling.
      await callTool(own.url, 'file_read', { path: '/a.txt', maxBytes: 200 })
      await callTool(own.url, 'file_read', { path: '/a.txt', maxBytes: 999_999 })
      expect(seen.slice(1)).toEqual([
        { path: '/a.txt', maxBytes: 200 },
        { path: '/a.txt', maxBytes: 1024 },
      ])
    } finally {
      await own.stop()
    }
  })

  it('forwards worktree_create arguments and the request abort signal', async () => {
    const seen: Record<string, unknown>[] = []
    const own = await boot(stubDriver({
      createWorktree: async (request) => {
        seen.push(request as unknown as Record<string, unknown>)
        return {
          sessionId: request.sessionId,
          path: '/repo/.agents/worktrees/wt-1',
          branch: 'wt-1',
          baseCommit: 'a'.repeat(40),
          repositoryRoot: '/repo',
          from: 'main',
        }
      },
    }), testConfig({ session: true }))
    try {
      const { isError, text } = await callTool(own.url, 'worktree_create', {
        sessionId: 'session-1',
        name: 'wt-1',
        from: 'main',
      })
      expect(isError).toBe(false)
      expect(seen[0]).toMatchObject({ sessionId: 'session-1', name: 'wt-1', from: 'main' })
      // A Git command must stop when the MCP request is cancelled, so the tool has
      // to hand the driver the request's signal.
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
      expect(JSON.parse(text)).toMatchObject({ branch: 'wt-1', from: 'main' })
    } finally {
      await own.stop()
    }
  })

  it('forwards the recorded worktree to worktree_restore', async () => {
    const seen: Record<string, unknown>[] = []
    const own = await boot(stubDriver({
      restoreWorktree: async (request) => {
        seen.push(request as unknown as Record<string, unknown>)
        return { sessionId: request.sessionId, path: request.path, branchRecreated: true }
      },
    }), testConfig({ session: true }))
    const record = {
      path: '/repo/.agents/worktrees/wt-1',
      branch: 'wt-1',
      baseCommit: 'b'.repeat(40),
      repositoryRoot: '/repo',
    }
    try {
      const { isError, text } = await callTool(own.url, 'worktree_restore', {
        sessionId: 'session-1',
        ...record,
      })
      expect(isError).toBe(false)
      expect(seen[0]).toMatchObject({ sessionId: 'session-1', ...record })
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
      expect(JSON.parse(text)).toMatchObject({ branchRecreated: true })
    } finally {
      await own.stop()
    }
  })

  it('normalizes session_create worktree: true to {} and leaves false/absent unset', async () => {
    const seen: Record<string, unknown>[] = []
    const own = await boot(stubDriver({
      createSession: async (request) => {
        seen.push(request as unknown as Record<string, unknown>)
        return { sessionId: 'session-new' }
      },
    }), testConfig({ session: true }))
    try {
      await callTool(own.url, 'session_create', { workspaceId: 'ws-1', worktree: true })
      await callTool(own.url, 'session_create', { workspaceId: 'ws-1', worktree: false })
      await callTool(own.url, 'session_create', {
        workspaceId: 'ws-1',
        worktree: { name: 'wt-1', from: 'main' },
      })
      await callTool(own.url, 'session_create', { workspaceId: 'ws-1' })

      // `true` means "create one with generated names" and reaches the driver as an
      // empty options object; `false` and absence must not look like a request.
      expect(seen.map((request) => ('worktree' in request ? request.worktree : '<absent>')))
        .toEqual([{}, '<absent>', { name: 'wt-1', from: 'main' }, '<absent>'])
    } finally {
      await own.stop()
    }
  })

  it('forwards session_list includeWorktree and passes the folded rows through', async () => {
    const seen: unknown[] = []
    const own = await boot(stubDriver({
      listSessions: async (limit, options) => {
        seen.push({ limit, options })
        return {
          sessions: [{
            sessionId: 'a',
            running: false,
            blank: false,
            updatedAt: 1,
            workingDirectory: '/repo/.agents/worktrees/a',
          }],
          total: 1,
        }
      },
    }))
    try {
      const { isError, text } = await callTool(own.url, 'session_list', { includeWorktree: true })
      expect(isError).toBe(false)
      expect(seen[0]).toEqual({ limit: 20, options: { includeWorktree: true } })
      expect(JSON.parse(text)).toMatchObject({
        sessions: [{ sessionId: 'a', workingDirectory: '/repo/.agents/worktrees/a' }],
      })
    } finally {
      await own.stop()
    }
  })

  it('returns the working directory and worktree a status read folded in', async () => {
    const own = await boot(stubDriver({
      sessionStatus: async ({ sessionId }) => ({
        sessionId,
        running: false,
        openTurn: null,
        openStep: null,
        lastEventSeq: 3,
        lastEventAt: '2026-11-03T00:00:00.000Z',
        idleMs: 1_000,
        lastTurn: null,
        failure: null,
        stalled: false,
        logReadable: true,
        waitedMs: 0,
        workingDirectory: '/repo/.agents/worktrees/wt-1',
        worktree: {
          path: '/repo/.agents/worktrees/wt-1',
          branch: 'wt-1',
          baseCommit: 'c'.repeat(40),
          repositoryRoot: '/repo',
          from: 'main',
        },
      }),
    }), testConfig({ session: true }))
    try {
      const { isError, text } = await callTool(own.url, 'session_status', { sessionId: 's' })
      expect(isError).toBe(false)
      const payload = JSON.parse(text) as {
        workingDirectory?: string
        worktree?: { branch?: string; from?: string }
      }
      expect(payload.workingDirectory).toBe('/repo/.agents/worktrees/wt-1')
      expect(payload.worktree).toMatchObject({ branch: 'wt-1', from: 'main' })
    } finally {
      await own.stop()
    }
  })

  it('forwards archive and pin calls to the driver', async () => {
    const calls: unknown[] = []
    const own = await boot(stubDriver({
      archiveSession: async (request) => {
        calls.push({ tool: 'archive', ...request })
        return { sessionId: request.sessionId, archived: true }
      },
      unarchiveSession: async (request) => {
        calls.push({ tool: 'unarchive', ...request })
        return { sessionId: request.sessionId, archived: false }
      },
      pinSession: async (request) => {
        calls.push({ tool: 'pin', ...request })
        return { sessionId: request.sessionId, pinned: true }
      },
      unpinSession: async (request) => {
        calls.push({ tool: 'unpin', ...request })
        return { sessionId: request.sessionId, pinned: false }
      },
    }), testConfig({ session: true }))
    try {
      const archived = await callTool(own.url, 'session_archive', {
        sessionId: 'session-1',
        stopActivity: true,
      })
      expect(archived.isError).toBe(false)
      const plain = await callTool(own.url, 'session_archive', { sessionId: 'session-1' })
      expect(plain.isError).toBe(false)
      await callTool(own.url, 'session_unarchive', { sessionId: 'session-1' })
      await callTool(own.url, 'session_pin', { sessionId: 'session-1' })
      await callTool(own.url, 'session_unpin', { sessionId: 'session-1' })

      expect(calls).toEqual([
        { tool: 'archive', sessionId: 'session-1', stopActivity: true },
        // `stopActivity` is omitted, not false: stopping work is a deliberate ask.
        { tool: 'archive', sessionId: 'session-1' },
        { tool: 'unarchive', sessionId: 'session-1' },
        { tool: 'pin', sessionId: 'session-1' },
        { tool: 'unpin', sessionId: 'session-1' },
      ])
      expect(JSON.parse(archived.text)).toEqual({ sessionId: 'session-1', archived: true })
    } finally {
      await own.stop()
    }
  })

  it('rejects an MCP-Protocol-Version header that matches no negotiated revision', async () => {
    // A client must echo the revision the server actually chose. Sending the
    // requested one after a downgrade is the failure mode the stdio bridge has
    // to avoid, and the server reports it as an in-band JSON-RPC error body.
    const response = await rpc(
      url,
      { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
      { protocolVersion: '2026-07-28' },
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain('2026-07-28')
  })
})
