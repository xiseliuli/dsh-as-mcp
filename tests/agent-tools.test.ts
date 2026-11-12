/**
 * `dsh_tool_list` / `dsh_tool_call`: driving the harness's own toolbox.
 *
 * Two properties are under test. First, the allow-list is a real boundary — a
 * caller can name any tool it likes, so the list is re-checked at execution and
 * applied to the *listing* too, or a caller could enumerate what it may not call
 * and then call it anyway. Second, a session is mandatory: the agent is what
 * supplies the scope, and there is no unscoped toolbox to fall back to.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { DshDriver } from '../src/dsh/driver.js'
import { DEFAULT_AGENT_TOOLS } from '../src/defaults.js'
import type { Config } from '../src/config.js'
import { testConfig } from './harness.js'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One schema, as `ctx.tools.schemas` projects it. */
function schema(name: string, description = `${name} tool`) {
  return { name, description, parameters: { type: 'object' } }
}

/** A `ctx.tools` double recording what it was asked to do. */
function fakeTools(options: {
  visible?: string[]
  fail?: boolean
  text?: string
  /** How the double reacts to the call's abort signal. */
  onAbort?: 'reject' | 'error-result'
} = {}) {
  const calls: { name: string; args: unknown; agent: unknown; callId: string }[] = []
  const scopes: unknown[] = []
  const visible = options.visible ?? [
    'read', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search',
    'run_code', 'cordis_run', 'workflow', 'ask_user_question', 'create_goal',
  ]
  return {
    calls,
    scopes,
    tools: {
      schemas: (scope?: unknown) => {
        scopes.push(scope)
        return visible.map((name) => schema(name))
      },
      execute: async (exec: {
        name: string
        arguments: unknown
        agent?: unknown
        callId: string
        signal?: AbortSignal
      }) => {
        calls.push({ name: exec.name, args: exec.arguments, agent: exec.agent, callId: exec.callId })
        if (options.onAbort !== undefined) {
          return await new Promise((resolve, reject) => {
            const onAbort = (): void => {
              if (options.onAbort === 'reject') reject(new Error('this operation was aborted'))
              else {
                resolve({
                  isError: true as const,
                  error: { message: 'tool call aborted' },
                  content: [{ type: 'text' as const, text: 'Error: tool call aborted' }],
                })
              }
            }
            if (exec.signal?.aborted === true) onAbort()
            else exec.signal?.addEventListener('abort', onAbort, { once: true })
          })
        }
        if (options.fail === true) {
          return {
            isError: true as const,
            error: { message: `refused: ${exec.name} is not allowed under this policy` },
            content: [{ type: 'text', text: 'denied' }],
          }
        }
        return {
          isError: false as const,
          value: { ran: exec.name },
          content: [{ type: 'text', text: options.text ?? `ran ${exec.name}` }],
        }
      },
    },
  }
}

/**
 * A `ctx.tools` double speaking the 0.2.2+ batch contract.
 *
 * `resolve` is the marker the driver uses to tell the contracts apart: it shipped
 * in the same release as the batch executor, and the single-call input no longer
 * exists there. `arguments` is a JSON string because the real executor parses
 * model-facing JSON and preserves invalid JSON as text.
 */
function fakeBatchTools(options: { visible?: string[]; fail?: boolean; text?: string } = {}) {
  const visible = options.visible ?? [
    'read', 'write', 'edit', 'glob', 'grep', 'bash',
  ]
  const batches: {
    calls: { type: string; id: string; name: string; arguments: string }[]
    agent: unknown
    signal: AbortSignal
  }[] = []
  return {
    batches,
    tools: {
      resolve: async () => ({}),
      schemas: () => visible.map((name) => schema(name)),
      execute: async (input: {
        calls: { type: string; id: string; name: string; arguments: string }[]
        agent?: unknown
        signal: AbortSignal
      }) => {
        batches.push({ calls: input.calls, agent: input.agent, signal: input.signal })
        const call = input.calls[0] as { id: string; name: string }
        return {
          results: [{
            callId: call.id,
            result: options.fail === true
              ? {
                isError: true as const,
                error: { message: 'refused: batch policy' },
                content: [{ type: 'text' as const, text: 'denied' }],
              }
              : {
                isError: false as const,
                value: { ran: call.name },
                content: [{ type: 'text' as const, text: options.text ?? `ran ${call.name}` }],
              },
          }],
        }
      },
    },
  }
}

/**
 * A driver over doubles.
 *
 * A session resolver is always present: every tool call needs a scope, so a test
 * that forgot one would be exercising an error path by accident.
 */
function driverWith(input: {
  tools?: unknown
  resolveAgent?: (sessionId: string) => Promise<unknown>
  config?: Partial<Config['tools']> & { allow?: string[]; deny?: string[] }
} = {}): DshDriver {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('tools', input.tools ?? fakeTools().tools)
  ctx.provide('sessionController', {
    resolveAgent: input.resolveAgent ?? (async () => ({ agent: AGENT })),
    create: async () => ({ sessionId: 's' }),
    list: async () => ({ items: [] }),
    selectModel: async () => ({ selected: { provider: 'p', model: 'm' } }),
    prompt: async () => ({ accepted: true }),
    cancel: () => ({ accepted: true }),
    inspect: async () => ({ events: [] }),
  })
  const base = testConfig()
  const config: Config = {
    ...base,
    tools: { ...base.tools, ...input.config },
    agentTools: {
      allow: input.config?.allow ?? [...DEFAULT_AGENT_TOOLS.allow],
      deny: input.config?.deny ?? [],
    },
  }
  return new DshDriver(ctx, () => config)
}

const AGENT = { id: 'agent-1' }
const SESSION = 'session-1'

describe('the scope requirement', () => {
  it('refuses to act without a session instead of reporting an empty toolbox', async () => {
    // Measured against the live harness: an unscoped `schemas()` returns zero
    // tools and an unscoped `execute` answers `unknown tool`, because tools are
    // registered into the scope of the context that registers them and every tool
    // package ships inside an agent preset. Returning `[]` here would read as
    // "nothing is permitted" — a wrong answer where an error belongs.
    const driver = driverWith()
    await expect(driver.listAgentTools({ sessionId: '' }))
      .rejects.toThrow(/sessionId is required/)
    await expect(driver.listAgentTools({ sessionId: '' }))
      .rejects.toThrow(/no\s+(?:deployment-wide|agentless)/i)
    await expect(driver.callAgentTool({ name: 'read', sessionId: '', timeoutMs: 1_000 }))
      .rejects.toThrow(/sessionId is required/)
  })

  it('names the no-session alternatives so the error is actionable', async () => {
    const driver = driverWith()
    await expect(driver.callAgentTool({ name: 'read', sessionId: '', timeoutMs: 1_000 }))
      .rejects.toThrow(/session_create/)
    await expect(driver.callAgentTool({ name: 'read', sessionId: '', timeoutMs: 1_000 }))
      .rejects.toThrow(/shell_run/)
  })
})

describe('callAgentTool result size', () => {
  it('returns the full text and its byte count when under the cap', async () => {
    const tools = fakeTools({ text: 'small output' })
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'read',
      sessionId: SESSION,
      timeoutMs: 1_000,
    })
    expect(result).toMatchObject({ ok: true, text: 'small output', resultBytes: 12, value: { ran: 'read' } })
    expect(result.truncated).toBeUndefined()
  })

  it('cuts a large result and reports what it was, instead of flooding the caller', async () => {
    const tools = fakeTools({ text: 'x'.repeat(5_000) })
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'read',
      sessionId: SESSION,
      timeoutMs: 1_000,
      maxResultChars: 500,
    })
    expect(result.text).toHaveLength(500)
    expect(result.resultBytes).toBe(5_000)
    expect(result.truncated).toBe(true)
    // A structured duplicate of output the caller cannot see would bound nothing.
    expect(result.value).toBeUndefined()
  })

  it('applies a default cap so an unbounded tool result cannot pass through', async () => {
    const tools = fakeTools({ text: 'y'.repeat(25_000) })
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'bash',
      sessionId: SESSION,
      timeoutMs: 1_000,
    })
    expect(result.text).toHaveLength(20_000)
    expect(result.resultBytes).toBe(25_000)
    expect(result.truncated).toBe(true)
  })
})

describe('callAgentTool timeouts', () => {
  it('says the timeoutMs deadline fired when the call rejects on abort', async () => {
    const tools = fakeTools({ onAbort: 'reject' })
    await expect(driverWith({ tools: tools.tools }).callAgentTool({
      name: 'bash',
      sessionId: SESSION,
      timeoutMs: 20,
    })).rejects.toThrow(/aborted after 20ms because timeoutMs elapsed/)
  })

  it('replaces the harness "tool call aborted" with the same attribution', async () => {
    // The live harness reports an aborted call as a result, not a rejection. Its
    // message does not say which deadline fired, so it is replaced.
    const tools = fakeTools({ onAbort: 'error-result' })
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'bash',
      sessionId: SESSION,
      timeoutMs: 20,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/aborted after 20ms because timeoutMs elapsed/)
  })

  it('keeps the harness error when the call failed for its own reasons', async () => {
    const tools = fakeTools({ fail: true })
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'read',
      sessionId: SESSION,
      timeoutMs: 5_000,
    })
    expect(result.error).toBe('refused: read is not allowed under this policy')
  })
})

describe('listAgentTools', () => {
  it('lists only names the allow-list permits', async () => {
    const listed = await driverWith().listAgentTools({ sessionId: SESSION })
    const names = listed.tools.map((tool) => tool.name)

    // The deterministic set is there…
    expect(names).toContain('read')
    expect(names).toContain('bash')
    // …and the ones this bridge refuses by default are absent from the listing,
    // not merely rejected on call. `run_code` is the important one: it runs a
    // program that can invoke any other tool, which would void the whole list.
    expect(names).not.toContain('run_code')
    expect(names).not.toContain('cordis_run')
    expect(names).not.toContain('workflow')
    expect(names).not.toContain('ask_user_question')
    expect(names).not.toContain('create_goal')

    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)))
    expect(listed.sessionId).toBe(SESSION)
  })

  it('carries the schema each tool reports, so the caller can call it correctly', async () => {
    const listed = await driverWith().listAgentTools({ sessionId: SESSION })
    const read = listed.tools.find((tool) => tool.name === 'read')
    expect(read).toMatchObject({ name: 'read', description: 'read tool' })
    expect(read?.parameters).toEqual({ type: 'object' })
  })

  it('lets `deny` subtract from the default without restating it', async () => {
    const listed = await driverWith({ config: { deny: ['bash', 'pwsh'] } })
      .listAgentTools({ sessionId: SESSION })
    const names = listed.tools.map((tool) => tool.name)
    expect(names).not.toContain('bash')
    expect(names).not.toContain('pwsh')
    expect(names).toContain('read')
  })

  it('lets a non-empty `allow` replace the default entirely', async () => {
    const listed = await driverWith({ config: { allow: ['web_search', 'workflow'] } })
      .listAgentTools({ sessionId: SESSION })
    expect(listed.tools.map((tool) => tool.name)).toEqual(['web_search', 'workflow'])
  })

  it('refuses a deny entry that is also in an explicit allow', async () => {
    const listed = await driverWith({ config: { allow: ['read', 'bash'], deny: ['bash'] } })
      .listAgentTools({ sessionId: SESSION })
    expect(listed.tools.map((tool) => tool.name)).toEqual(['read'])
  })

  it('scopes to the named session and passes its agent through', async () => {
    const tools = fakeTools()
    const seen: string[] = []
    const driver = driverWith({
      tools: tools.tools,
      resolveAgent: async (sessionId) => {
        seen.push(sessionId)
        return { agent: AGENT }
      },
    })

    await driver.listAgentTools({ sessionId: 'session-9' })

    expect(seen).toEqual(['session-9'])
    // The agent is the scope key: the harness uses it to hide tools the
    // session's own policy restricts away, which this plugin does not reimplement.
    expect(tools.scopes).toEqual([AGENT])
  })

  it('reports a session it could not scope instead of silently going global', async () => {
    const tools = fakeTools()
    const driver = driverWith({
      tools: tools.tools,
      resolveAgent: async () => ({ error: 'SESSION_QUERY_SESSION_NOT_FOUND' }),
    })

    const listed = await driver.listAgentTools({ sessionId: 'missing' })

    expect(listed.scopeError).toMatch(/could not be scoped/)
    // Unscoped rather than wrong: the call still reports the failure instead of
    // pretending the empty list is an answer.
    expect(tools.scopes).toEqual([undefined])
  })
})

describe('callAgentTool', () => {
  it('runs a permitted tool and reports its value and text', async () => {
    const tools = fakeTools()
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'read',
      args: { file_path: '/a.txt' },
      sessionId: SESSION,
      timeoutMs: 1_000,
    })

    expect(result).toMatchObject({ name: 'read', ok: true, value: { ran: 'read' }, text: 'ran read' })
    expect(tools.calls[0]?.args).toEqual({ file_path: '/a.txt' })
    // A correlation id is the harness's, not the caller's.
    expect(tools.calls[0]?.callId).toMatch(/^dsh-as-mcp-/)
  })

  it('refuses a name the allow-list does not carry, even though it is visible', async () => {
    // This is the boundary. `run_code` IS visible to the agent — the harness
    // registers it — so a listing-only filter would be bypassable by naming it.
    const tools = fakeTools()
    const driver = driverWith({ tools: tools.tools })

    await expect(driver.callAgentTool({ name: 'run_code', args: {}, sessionId: SESSION, timeoutMs: 1_000 }))
      .rejects.toThrow(/is not exposed by this endpoint/)
    await expect(driver.callAgentTool({ name: 'cordis_run', args: {}, sessionId: SESSION, timeoutMs: 1_000 }))
      .rejects.toThrow(/is not exposed/)
    // And nothing reached the harness.
    expect(tools.calls).toHaveLength(0)
  })

  it('honours an explicit allow entry, so an operator can widen deliberately', async () => {
    const tools = fakeTools({ visible: ['workflow'] })
    const result = await driverWith({ tools: tools.tools, config: { allow: ['workflow'] } }).callAgentTool({
      name: 'workflow',
      args: { script: 'return 1' },
      sessionId: SESSION,
      timeoutMs: 1_000,
    })
    expect(result.ok).toBe(true)
    expect(tools.calls.map((call) => call.name)).toEqual(['workflow'])
  })

  it('surfaces a tool failure as ok: false with the harness message', async () => {
    // A refusal from the pipeline is a normal outcome, not a transport error: the
    // caller needs the reason to decide what to do next.
    const tools = fakeTools({ fail: true })
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'write',
      args: { file_path: '/a.txt', content: 'x' },
      sessionId: SESSION,
      timeoutMs: 1_000,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not allowed under this policy/)
    expect(result.text).toBe('denied')
  })

  it('runs under the named session agent, so its policy and transcript apply', async () => {
    const tools = fakeTools()
    await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'read',
      args: { file_path: '/b.txt' },
      sessionId: 'session-3',
      timeoutMs: 1_000,
    })

    expect(tools.calls[0]?.agent).toBe(AGENT)
  })

  it('passes an abort signal the harness requires', async () => {
    let received: AbortSignal | undefined
    const tools = {
      schemas: () => [schema('read')],
      execute: async (exec: { signal: AbortSignal }) => {
        received = exec.signal
        return { isError: false as const, value: null, content: [] }
      },
    }
    await driverWith({ tools }).callAgentTool({ name: 'read', sessionId: SESSION, timeoutMs: 1_000 })
    expect(received).toBeInstanceOf(AbortSignal)
    expect(received?.aborted).toBe(false)
  })

  it('flattens non-text content blocks instead of dropping them silently', async () => {
    const tools = {
      schemas: () => [schema('read_image')],
      execute: async () => ({
        isError: false as const,
        value: { ok: true },
        content: [{ type: 'text', text: 'shot' }, { type: 'image' }],
      }),
    }
    const result = await driverWith({ tools }).callAgentTool({
      name: 'read_image', sessionId: SESSION, timeoutMs: 1_000,
    })
    expect(result.text).toBe('shot\n[image]')
  })

  it('refuses to run unscoped rather than answering with a bare unknown-tool', async () => {
    const tools = fakeTools()
    const driver = driverWith({
      tools: tools.tools,
      resolveAgent: async () => ({ error: 'SESSION_QUERY_SESSION_NOT_FOUND' }),
    })

    // Executing without the agent would answer `unknown tool` and name neither
    // the session nor the reason, so the scope failure itself is the error.
    await expect(driver.callAgentTool({ name: 'read', sessionId: 'missing', timeoutMs: 1_000 }))
      .rejects.toThrow(/could not be scoped/)
    expect(tools.calls).toEqual([])
  })

  it('names the missing service instead of failing obscurely', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const driver = new DshDriver(ctx, () => testConfig())
    await expect(driver.callAgentTool({ name: 'read', sessionId: SESSION, timeoutMs: 1_000 }))
      .rejects.toThrow(/provides no tools service/)
  })
})

describe('callAgentTool on the DSH 0.2.2 batch contract', () => {
  it('sends one raw call with JSON-string arguments and unwraps its batch result', async () => {
    const tools = fakeBatchTools()
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'read',
      args: { file_path: '/a.txt' },
      sessionId: SESSION,
      timeoutMs: 1_000,
    })

    expect(result).toMatchObject({ name: 'read', ok: true, value: { ran: 'read' }, text: 'ran read' })
    const batch = tools.batches[0]
    expect(batch?.calls).toHaveLength(1)
    expect(batch?.calls[0]).toMatchObject({ type: 'tool-call', name: 'read' })
    // The executor parses model-facing JSON: a structured argument object sent as
    // an object would be preserved as text and reach the tool as a string.
    expect(batch?.calls[0]?.arguments).toBe(JSON.stringify({ file_path: '/a.txt' }))
    // The call id is the harness's correlation id, not the caller's.
    expect(batch?.calls[0]?.id).toMatch(/^dsh-as-mcp-/)
    // The agent is the scope the batch runs under.
    expect(batch?.agent).toBe(AGENT)
    expect(batch?.signal).toBeInstanceOf(AbortSignal)
    expect(batch?.signal.aborted).toBe(false)
  })

  it('serializes an absent argument object as an empty JSON object', async () => {
    const tools = fakeBatchTools()
    await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'read', sessionId: SESSION, timeoutMs: 1_000,
    })
    expect(tools.batches[0]?.calls[0]?.arguments).toBe('{}')
  })

  it('unwraps a failed batch result as ok: false', async () => {
    const tools = fakeBatchTools({ fail: true })
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'write',
      args: { file_path: '/a.txt', content: 'x' },
      sessionId: SESSION,
      timeoutMs: 1_000,
    })

    // A refusal from the pipeline is a normal outcome: the caller needs the reason
    // to decide what to do next, not a rejection.
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/refused: batch policy/)
    expect(result.text).toBe('denied')
  })

  it('uses the legacy contract when the registry has no resolve marker', async () => {
    // The ≤0.1.7 shape: one ToolExecutionInput in, one ToolExecutionResult out,
    // and no `resolve` marker. The existing fake is exactly that registry.
    const tools = fakeTools()
    const result = await driverWith({ tools: tools.tools }).callAgentTool({
      name: 'read',
      args: { file_path: '/a.txt' },
      sessionId: SESSION,
      timeoutMs: 1_000,
    })

    expect(result).toMatchObject({ ok: true, text: 'ran read' })
    // Structured arguments travel as they are: there is no JSON-string boundary
    // in the legacy contract.
    expect(tools.calls[0]).toMatchObject({ name: 'read', args: { file_path: '/a.txt' } })
    expect(tools.calls[0]).not.toHaveProperty('calls')
  })

  it('selects the batch contract from the resolve marker, not from an argument name', async () => {
    const seen: unknown[] = []
    const tools = {
      resolve: async () => ({}),
      schemas: () => [schema('read')],
      execute: async (input: unknown) => {
        seen.push(input)
        return { results: [{ callId: 'c', result: { isError: false, value: null, content: [] } }] }
      },
    }

    await driverWith({ tools }).callAgentTool({ name: 'read', sessionId: SESSION, timeoutMs: 1_000 })

    // The batch input is `{calls, signal, agent}`, never a single call object.
    expect(seen[0]).toHaveProperty('calls')
    expect(seen[0]).not.toHaveProperty('callId')
    expect(seen[0]).not.toHaveProperty('name')
  })

  it('reports a batch answer that carries no result instead of claiming the call ran', async () => {
    const tools = {
      resolve: async () => ({}),
      schemas: () => [schema('read')],
      execute: async () => ({ results: [] }),
    }

    await expect(driverWith({ tools }).callAgentTool({
      name: 'read', sessionId: SESSION, timeoutMs: 1_000,
    })).rejects.toThrow(/answered without a result/)
  })

  it('reports a batch result of an unrecognized shape rather than guessing', async () => {
    const tools = {
      resolve: async () => ({}),
      schemas: () => [schema('read')],
      execute: async () => ({ results: [{ callId: 'c', result: { value: 1 } }] }),
    }

    await expect(driverWith({ tools }).callAgentTool({
      name: 'read', sessionId: SESSION, timeoutMs: 1_000,
    })).rejects.toThrow(/unrecognized result shape/)
  })

  it('passes a cancellable signal through the batch path too', async () => {
    let received: AbortSignal | undefined
    const tools = {
      resolve: async () => ({}),
      schemas: () => [schema('read')],
      execute: async (input: { signal: AbortSignal }) => {
        received = input.signal
        return { results: [{ callId: 'c', result: { isError: false, value: null, content: [] } }] }
      },
    }

    await driverWith({ tools }).callAgentTool({ name: 'read', sessionId: SESSION, timeoutMs: 1_000 })

    // Cancellation is the caller's deadline or an MCP cancel; either way the
    // batch executor must be reachable through a signal.
    expect(received).toBeInstanceOf(AbortSignal)
    expect(received?.aborted).toBe(false)
  })
})
