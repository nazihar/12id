import { defineConfig, devices } from '@playwright/test'

// Acceptance against the deployed console; no local server, no global setup.
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'staging*.spec.ts',
  workers: 1,
  retries: 0,
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
