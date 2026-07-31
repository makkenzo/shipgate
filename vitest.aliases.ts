import { fileURLToPath } from 'node:url'

export const workspaceAliases = [
  {
    find: '@shipgate/jobs/testing',
    replacement: fileURLToPath(new URL('./packages/jobs/src/testing.ts', import.meta.url)),
  },
  {
    find: '@shipgate/config',
    replacement: fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
  },
  {
    find: '@shipgate/database',
    replacement: fileURLToPath(new URL('./packages/database/src/index.ts', import.meta.url)),
  },
  {
    find: '@shipgate/github',
    replacement: fileURLToPath(new URL('./packages/github/src/index.ts', import.meta.url)),
  },
  {
    find: '@shipgate/jobs',
    replacement: fileURLToPath(new URL('./packages/jobs/src/index.ts', import.meta.url)),
  },
  {
    find: '@shipgate/testing',
    replacement: fileURLToPath(new URL('./packages/testing/src/index.ts', import.meta.url)),
  },
]
