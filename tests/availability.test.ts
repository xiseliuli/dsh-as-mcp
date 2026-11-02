import { describe, expect, it } from 'vitest'

import { describeToolAvailability } from '../src/mcp/availability.js'
import { testConfig } from './harness.js'

/** Every probe the availability rules consume, all true. */
const FULL = {
  workspaceRegistry: true,
  sessionController: true,
  sessionSearch: true,
  sessionQueue: true,
  sessionFork: true,
  sessionRename: true,
  sessionModel: true,
  tokenUsage: true,
  fs: true,
  shell: true,
  shellBackground: true,
  tools: true,
  agents: true,
  approval: true,
  costMeter: true,
  webServer: true,
  events: true,
  llm: true,
  agentPresets: true,
  permissionPresets: true,
  sandboxPolicy: true,
} as const

/** A config with every tool group on; the harness helper defaults three of them off. */
function allOn(overrides: Parameters<typeof testConfig>[0] = {}) {
  return testConfig({ shell: true, agentTools: true, usage: true, ...overrides })
}

describe('describeToolAvailability', () => {
  it('reports every advertised tool available when every probe is true', () => {
    const report = describeToolAvailability(allOn().tools, FULL, allOn())
    expect(report.unavailable).toEqual([])
    // dsh_info plus the 26 other registered tools (27 advertised in total).
    expect(report.available).toBe(27)
    expect(report.availableTools).toHaveLength(27)
    expect(new Set(report.availableTools).size).toBe(27)
    expect(report.availableTools[0]).toBe('dsh_info')
    expect(report.notes ?? []).toEqual([])
  })

  it('attributes a disabled group to the toggle, for every tool in it', () => {
    const config = allOn({ shell: false })
    const report = describeToolAvailability(config.tools, FULL, config)
    expect(report.unavailable.map((entry) => entry.tool)).toEqual([
      'shell_run', 'shell_start', 'shell_output', 'shell_kill', 'shell_list',
    ])
    expect(report.unavailable[0]?.reason).toMatch(/tools\.shell: false/)
    expect(report.available).toBe(22)
    expect(report.availableTools).not.toContain('shell_run')
  })

  it('names the missing service for a tool whose extra capability is absent', () => {
    const report = describeToolAvailability(allOn().tools, { ...FULL, sessionSearch: false }, allOn())
    const search = report.unavailable.find((entry) => entry.tool === 'session_search')
    expect(search?.reason).toMatch(/sessionController\.search\(\)/)
    // The rest of the session group is unaffected.
    expect(report.unavailable.map((entry) => entry.tool)).toEqual(['session_search'])
  })

  it('separates shell from background shell', () => {
    const report = describeToolAvailability(allOn().tools, { ...FULL, shellBackground: false }, allOn())
    expect(report.unavailable.map((entry) => entry.tool)).toEqual([
      'shell_start', 'shell_output', 'shell_kill', 'shell_list',
    ])
    expect(report.unavailable[0]?.reason).toMatch(/start\(\)\/execute\(\)/)
  })

  it('notes the session-query index even while session_search is nominally available', () => {
    const report = describeToolAvailability(allOn().tools, FULL, allOn())
    // No note when search is fully available...
    expect(report.notes ?? []).toEqual([])
    // ...but when the method is absent the note explains the second gate.
    const without = describeToolAvailability(allOn().tools, { ...FULL, sessionSearch: false }, allOn())
    expect(without.notes?.join('\n')).toMatch(/probeSearch/)
  })

  it('marks dsh_tool_* unavailable without an agents service', () => {
    const report = describeToolAvailability(allOn().tools, { ...FULL, agents: false }, allOn())
    expect(report.unavailable.map((entry) => entry.tool)).toEqual(['dsh_tool_list', 'dsh_tool_call'])
  })
})
