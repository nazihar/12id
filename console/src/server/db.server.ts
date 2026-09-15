/** The console's own database (Better Auth tables). One pool per process, created on first use. */
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from './db/auth-schema'
import { serverEnv } from './env.server'

let instance: { pool: pg.Pool; db: NodePgDatabase<typeof schema> } | undefined

export function consoleDb() {
  if (!instance) {
    const pool = new pg.Pool({ connectionString: serverEnv().DATABASE_URL, max: 10 })
    instance = { pool, db: drizzle(pool, { schema }) }
  }
  return instance
}

export async function closeConsoleDb() {
  if (!instance) return
  const { pool } = instance
  instance = undefined
  await pool.end()
}
