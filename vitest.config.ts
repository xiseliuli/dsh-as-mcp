import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every test run gets its own DSH_HOME: the plugin persists an ownership
    // record under it, and writing that into the developer's real `~/.dsh` from a
    // test is both a side effect on their machine and a source of order-dependent
    // failures between test files.
    setupFiles: ['tests/setup.ts'],
  },
})
