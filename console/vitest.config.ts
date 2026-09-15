import { defineConfig } from 'vitest/config'

// Unit tests only. The TanStack Start plugin is not loaded here; sign-in, 2FA and page flows run in
// Playwright against a real server.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
