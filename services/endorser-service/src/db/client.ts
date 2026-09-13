import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import type { AuditEntry } from '../http/endorser-api.ts'
import * as schema from './schema.ts'

export function createDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 5 })
  return { pool, db: drizzle(pool, { schema }) }
}

export function createAuditWriter(db: ReturnType<typeof createDatabase>['db']) {
  return {
    async record(entry: AuditEntry) {
      await db.insert(schema.endorsementAudit).values(entry)
    },
  }
}
