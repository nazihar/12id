/**
 * Outbox commit order (review M7), against a real Postgres (TEST_DATABASE_URL, default the Phase 2
 * local Docker Postgres; skipped when unreachable). The platform consumer advances past every id it
 * reads, so a lower id must never become visible after a higher one.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { createDatabase } from '../src/db/client.ts'
import { ensureDatabase, runMigrations } from '../src/db/migrate.ts'
import { outbox } from '../src/db/schema.ts'
import { OUTBOX_LOCK_KEY, insertOutboxRow } from '../src/events/outbox-writer.ts'

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:spike-only@127.0.0.1:55432/agent_service_test'

async function connect() {
  try {
    await ensureDatabase(url)
    await runMigrations(url)
    return createDatabase(url)
  } catch {
    return null
  }
}

const database = await connect()
const row = (recordId: string) => ({ tenantId: 't1', recordType: 'credential' as const, recordId, state: 'offer-sent', payload: {} })

describe('outbox commit order', { skip: database ? false : 'no test database' }, () => {
  after(async () => {
    await database?.pool.end()
  })

  it('a writer that drew a later id cannot commit before an earlier one still in flight', async () => {
    const { db, pool } = database!
    await db.delete(outbox)
    // A slow writer: holds the outbox lock with its row inserted but not committed (a stalled commit).
    const slow = await pool.connect()
    try {
      await slow.query('begin')
      await slow.query('select pg_advisory_xact_lock($1)', [OUTBOX_LOCK_KEY])
      const first = await slow.query<{ id: string }>(`insert into outbox (tenant_id, record_type, record_id, state) values ('t1', 'credential', 'slow', 'offer-sent') returning id`)

      let secondDone = false
      const second = insertOutboxRow(db, row('fast')).then(() => (secondDone = true))
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(secondDone, false, 'the second writer waits for the first to commit')
      const visible = await db.select().from(outbox)
      assert.equal(visible.length, 0, 'nothing is visible yet, so a reader cannot skip the slow row')

      await slow.query('commit')
      await second
      const rows = await db.select({ id: outbox.id, recordId: outbox.recordId }).from(outbox).orderBy(outbox.id)
      assert.deepEqual(rows.map((r) => r.recordId), ['slow', 'fast'])
      assert.equal(rows[0].id, Number(first.rows[0].id))
    } finally {
      slow.release()
    }
  })

  it('serialises many concurrent writers without losing any row', async () => {
    const { db } = database!
    await db.delete(outbox)
    await Promise.all(Array.from({ length: 25 }, (_, i) => insertOutboxRow(db, row(`r${i}`))))
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(outbox)
    assert.equal(n, 25)
  })
})
