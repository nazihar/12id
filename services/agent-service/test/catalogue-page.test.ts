/**
 * Paged catalogue (Phase 4 C9) against a real Postgres (TEST_DATABASE_URL, default the Phase 2 local
 * Docker Postgres; skipped when unreachable): one kind per page, newest first, filters, and the
 * unpaged list unchanged for lookups.
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { createDatabase } from '../src/db/client.ts'
import { ensureDatabase, runMigrations } from '../src/db/migrate.ts'
import { ledgerObjects, tenants } from '../src/db/schema.ts'
import { listCatalogue, listCataloguePage } from '../src/ledger/deprecation.ts'

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

describe('catalogue page', { skip: database ? false : 'no test database' }, () => {
  after(async () => {
    await database?.pool.end()
  })

  it('pages one kind newest first with status and name filters', async () => {
    const { db } = database!
    await db.delete(ledgerObjects)
    await db.delete(tenants).catch(() => undefined)
    await db.insert(tenants).values([{ id: 'cat-a', label: 'A' }, { id: 'cat-b', label: 'B' }] as never)
    const at = (n: number) => new Date(Date.UTC(2026, 8, 1 + n))
    await db.insert(ledgerObjects).values([
      ...Array.from({ length: 30 }, (_, i) => ({ tenantId: 'cat-a', kind: 'schema' as const, name: i === 5 ? 'Employee_Badge' : `schema-${i}`, version: '1.0', status: i % 2 ? ('published' as const) : ('deprecated' as const), createdAt: at(i) })),
      { tenantId: 'cat-a', kind: 'credential_definition' as const, name: 'schema-1', version: '1.0', tag: 'gold', status: 'published' as const, createdAt: at(40) },
      { tenantId: 'cat-b', kind: 'schema' as const, name: 'employee_badge', version: '1.0', status: 'published' as const, createdAt: at(1) },
    ])

    const first = await listCataloguePage(db, 'cat-a', { kind: 'schema', page: 1, pageSize: 25 })
    assert.equal(first.total, 30)
    assert.equal(first.items.length, 25)
    assert.equal(first.items[0].name, 'schema-29', 'newest first')
    assert.ok(first.items.every((o) => o.kind === 'schema'))
    assert.equal((await listCataloguePage(db, 'cat-a', { kind: 'schema', page: 2, pageSize: 25 })).items.length, 5)
    assert.equal((await listCataloguePage(db, 'cat-a', { kind: 'schema', status: 'published', page: 1, pageSize: 25 })).total, 15)
    assert.deepEqual((await listCataloguePage(db, 'cat-a', { kind: 'schema', q: 'badge', page: 1, pageSize: 25 })).items.map((o) => o.name), ['Employee_Badge'], 'contains, case-insensitive, one tenant')
    assert.equal((await listCataloguePage(db, 'cat-a', { kind: 'schema', q: 'e_b', page: 1, pageSize: 25 })).total, 1, '_ is literal')
    assert.deepEqual((await listCataloguePage(db, 'cat-a', { kind: 'credential_definition', q: 'GOLD', page: 1, pageSize: 25 })).items.map((o) => o.tag), ['gold'], 'q matches the tag')
    assert.equal((await listCatalogue(db, 'cat-a')).length, 31, 'the unpaged list still returns everything')
  })
})
