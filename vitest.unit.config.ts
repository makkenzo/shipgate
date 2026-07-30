import { defineConfig } from 'vitest/config'

import { workspaceAliases } from './vitest.aliases.js'

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },

  test: {
    include: ['apps/**/*.unit.test.{ts,tsx}', 'packages/**/*.unit.test.{ts,tsx}'],

    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],

    environment: 'node',
    passWithNoTests: false,
  },
})
