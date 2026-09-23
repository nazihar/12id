import { and, count, eq, gt, inArray } from 'drizzle-orm'
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
    /** Schemas and cred defs signed for the tenant in the last 24 h (review M3), from the audit rows. */
    async ledgerWritesSince(tenantId: string, since: Date) {
      const [row] = await db
        .select({ n: count() })
        .from(schema.endorsementAudit)
        .where(and(eq(schema.endorsementAudit.tenantId, tenantId), eq(schema.endorsementAudit.allowed, true), inArray(schema.endorsementAudit.kind, ['schema', 'credentialDefinition']), gt(schema.endorsementAudit.createdAt, since)))
      return row?.n ?? 0
    },
  }
}
