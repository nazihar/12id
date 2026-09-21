import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from './schema.ts'

export function createDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 5 })
  return { pool, db: drizzle(pool, { schema }) }
}

export type Database = ReturnType<typeof createDatabase>['db']
