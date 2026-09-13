/**
 * Service database bootstrap shared by agent-service and endorser-service. Run from the
 * provision step only (one process), never at service start.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

/**
 * Creates the database named in `url` if it does not exist. Connects to the server's `postgres`
 * maintenance database with the same credentials, so the account needs CREATEDB on first run.
 */
export async function ensureDatabase(url: string): Promise<'created' | 'existing'> {
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

/** Applies pending drizzle SQL migrations from `migrationsFolder`. */
export async function runMigrations(url: string, migrationsFolder: string) {
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  try {
    await migrate(drizzle(pool), { migrationsFolder })
  } finally {
    await pool.end()
  }
}
