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
  worktrees: true,
  agentResolve: true,
  commands: true,
  goals: true,
  schedule: true,
  sessionViews: true,
  sessionArchive: true,
  sessionPin: true,
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
    // dsh_info plus the 37 other registered tools (38 advertised in total).
    expect(report.available).toBe(42)
    expect(report.availableTools).toHaveLength(42)
    expect(new Set(report.availableTools).size).toBe(42)
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
    expect(report.available).toBe(37)
    expect(report.availableTools).not.toContain('shell_run')
  })

  it('counts the 25-tool session group, including the worktree, archive, orchestration and schedule additions', () => {
    const config = allOn({ session: false })
    const report = describeToolAvailability(config.tools, FULL, config)
    const sessionTools = [
      'session_create', 'worktree_create', 'worktree_restore', 'session_search', 'session_status', 'session_list',
      'session_prompt', 'session_messages', 'session_tool_result', 'session_queue', 'session_cancel', 'session_fork',
      'session_rename', 'session_set_model', 'session_archive', 'session_unarchive', 'session_pin', 'session_unpin',
      'session_command_list', 'session_command', 'session_goal',
      'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
    ]
    expect(report.unavailable.map((entry) => entry.tool)).toEqual(sessionTools)
    expect(report.available).toBe(17)
    expect(report.availableTools).not.toContain('session_create')
    expect(report.availableTools).not.toContain('worktree_create')
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

  it('names the worktree service for both worktree tools, and keeps sessions working without it', () => {
    const report = describeToolAvailability(allOn().tools, { ...FULL, worktrees: false }, allOn())
    expect(report.unavailable.map((entry) => entry.tool)).toEqual(['worktree_create', 'worktree_restore'])
    expect(report.unavailable[0]?.reason).toMatch(/worktree service \(the forge bundle in DSH Desktop\/Web\)/)
    // The tools are unavailable, but session_create/session_status/session_list stay:
    // a profile without worktrees can still create and drive sessions.
    expect(report.availableTools).toContain('session_create')
    expect(report.availableTools).toContain('session_status')
    // And the note says what a caller loses, now that the tools are gone from the list.
    expect(report.notes?.join('\n')).toMatch(/Without a worktrees service/)
    expect(report.notes?.join('\n')).toMatch(/session_create \{ worktree \}/)
    expect(report.notes?.join('\n')).toMatch(/worktree_create\/worktree_restore/)
  })

  it('separates the worktree service from the agent bridge it needs', () => {
    const report = describeToolAvailability(allOn().tools, { ...FULL, agentResolve: false }, allOn())
    // Commands and goals are agent-scoped too, so the same missing bridge takes
    // them out as well.
    expect(report.unavailable.map((entry) => entry.tool)).toEqual([
      'worktree_create', 'worktree_restore', 'session_command_list', 'session_command', 'session_goal',
    ])
    // The schedule tools do not need an agent bridge (they are Host records), so a
    // missing resolveAgent leaves them available.
    expect(report.unavailable[0]?.reason).toMatch(/sessionController\.resolveAgent\(\)/)
  })

  it('separates archive from pin, so a profile can serve one and not the other', () => {
    const archiveMissing = describeToolAvailability(
      allOn().tools,
      { ...FULL, sessionArchive: false },
      allOn(),
    )
    expect(archiveMissing.unavailable.map((entry) => entry.tool)).toEqual([
      'session_archive', 'session_unarchive',
    ])
    expect(archiveMissing.availableTools).toContain('session_pin')
    expect(archiveMissing.notes?.join('\n')).toMatch(/Archive\/pin tools need the workspace registry/)

    const pinMissing = describeToolAvailability(allOn().tools, { ...FULL, sessionPin: false }, allOn())
    expect(pinMissing.unavailable.map((entry) => entry.tool)).toEqual(['session_pin', 'session_unpin'])
    expect(pinMissing.availableTools).toContain('session_archive')
  })

  it('keeps status and list available without a projection reader, and says what is lost', () => {
    const report = describeToolAvailability(allOn().tools, { ...FULL, sessionViews: false }, allOn())
    // Neither tool is blocked: the views are additive diagnostics.
    expect(report.unavailable).toEqual([])
    expect(report.available).toBe(42)
    expect(report.notes?.join('\n')).toMatch(/session_status and session_list cannot report workingDirectory/)
  })
})
