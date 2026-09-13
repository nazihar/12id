import { defineConfig } from 'drizzle-kit'

// Generates SQL migrations from src/db/schema.ts. Migrations are applied by the provision job,
// never by agent-service at start (one process migrates, as with the Askar store).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
})
