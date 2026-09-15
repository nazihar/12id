/**
 * console-migrate init job: creates the `console` database if missing and applies the committed
 * SQL migrations (Better Auth tables). One process migrates; the app never does at start.
 * Same shape as services/credo-base/src/postgres-migrate.ts, copied because the console is its own
 * package.
 *
 *   node scripts/migrate.ts
 */
import { fileURLToPath } from 'node:url'

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

async function ensureDatabase(url: string): Promise<'created' | 'existing'> {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`refusing to create database with unexpected name '${name}'`)
  const maintenance = new URL(url)
  maintenance.pathname = '/postgres'
  const client = new pg.Client({ connectionString: maintenance.toString() })
  await client.connect()
  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [name])
    if (existing.rowCount && existing.rowCount > 0) return 'existing'
    // Identifier validated above; CREATE DATABASE cannot take a bind parameter.
    await client.query(`create database "${name}"`)
    return 'created'
  } finally {
    await client.end()
  }
}

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const database = await ensureDatabase(url)
const pool = new pg.Pool({ connectionString: url, max: 1 })
try {
  await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) })
} finally {
  await pool.end()
}
console.log(JSON.stringify({ database, migrations: 'applied' }))
