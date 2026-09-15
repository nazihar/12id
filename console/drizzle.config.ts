import { defineConfig } from 'drizzle-kit'

// SQL migrations for the console's own database (`console`): Better Auth's tables, generated into
// src/server/db/auth-schema.ts by the Better Auth CLI, then diffed here by drizzle-kit. Applied by
// scripts/migrate.ts (the console-migrate init job), never at app start.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/auth-schema.ts',
  out: './drizzle',
  strict: true,
})
