import { defineConfig } from 'vitest/config'

import { workspaceAliases } from './vitest.aliases.js'

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },

  test: {
    include: ['apps/**/*.integration.test.ts', 'packages/**/*.integration.test.ts'],

    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],

    environment: 'node',

    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',

    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
  },
})
