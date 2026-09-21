import { defineConfig } from 'drizzle-kit'

// Migrations are applied by the biometric-service's own provision step, from one process.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
})
