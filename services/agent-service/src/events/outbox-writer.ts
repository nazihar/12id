/**
 * The only way to write an outbox row (review M7).
 *
 * The platform consumer reads `id > cursor` and advances past every id it saw, so a row must never
 * commit after a row with a higher id was already served. Plain concurrent inserts allow exactly
 * that: two transactions draw ids 7 and 8, 8 commits, the feed serves it, then 7 commits and is
 * skipped for good. Taking one transaction-scoped advisory lock before the insert makes id order
 * and commit order the same, across processes and replicas. At our event rate serialising these
 * single-row inserts costs nothing. The feed's 2 s settle window stays as a margin.
 */
import { sql } from 'drizzle-orm'

import type { Database } from '../db/client.ts'
import { outbox } from '../db/schema.ts'

/** Arbitrary, fixed: the advisory lock every outbox writer takes. */
export const OUTBOX_LOCK_KEY = 1_214_210_577

export type OutboxInsert = typeof outbox.$inferInsert

export async function insertOutboxRow(db: Database, row: OutboxInsert): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${OUTBOX_LOCK_KEY})`)
    await tx.insert(outbox).values(row)
  })
}
