import { defineConfig, devices } from '@playwright/test'

import { consoleEnv } from './e2e/env'

// Browser flows against a real dev server: sign-in, 2FA, guards and data through platform-api.
// Needs the local Postgres and a local platform-api with CONSOLE_TOKEN (see e2e/env.ts).
export default defineConfig({
  testDir: 'e2e',
  testIgnore: 'staging*.spec.ts',
  workers: 1,
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: consoleEnv.BETTER_AUTH_URL,
    trace: 'retain-on-failure',
    // A stuck click fails with its locator instead of silently using up the test timeout.
    actionTimeout: 15_000,
  },
  webServer: {
    command: 'npx vite dev --port 3600 --strictPort',
    url: `${consoleEnv.BETTER_AUTH_URL}/api/health`,
    env: consoleEnv,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
