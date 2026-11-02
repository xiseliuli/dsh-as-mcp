import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

/**
 * The release script runs `tools/check-docs.mjs` separately, but the drift it
 * catches (a README table missing a tool, an input-schema option that never reaches
 * the handler, a changelog heading disagreeing with `package.json`) is introduced by
 * ordinary edits and found by whoever runs the tests. Running it here means
 * `vitest run` alone reports documentation drift instead of leaving it for the
 * release step.
 */
describe('documentation drift', () => {
  it('passes for the current tree', () => {
    const result = spawnSync(process.execPath, ['tools/check-docs.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    expect(result.stdout).toContain('docs consistent:')
  })
})
