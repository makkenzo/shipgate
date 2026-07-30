import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',

  fullyParallel: false,

  workers: process.env.CI ? 1 : undefined,

  retries: process.env.CI ? 1 : 0,

  reporter: [
    ['list'],

    [
      'html',
      {
        open: 'never',
      },
    ],
  ],

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3001',

    trace: 'retain-on-failure',

    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',

      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
})
