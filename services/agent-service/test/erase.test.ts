/**
 * Erasure (Phase 7 H1): finished exchange records are deleted with their DIDComm messages, running
 * ones are refused, unknown ids are a no-op; acknowledged outbox rows are pruned after retention
 * (real Postgres, skipped when unreachable).
 */
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'

import { pino } from 'pino'

import { createDatabase } from '../src/db/client.ts'
import { ensureDatabase, runMigrations } from '../src/db/migrate.ts'
import { outbox } from '../src/db/schema.ts'
import { PendingCorrelations } from '../src/events/correlation.ts'
import { pruneOutbox } from '../src/events/outbox-prune.ts'
import { type ExchangeDeps, ExchangeError, eraseConnection, eraseExchange } from '../src/exchanges/exchanges.ts'

const silent = pino({ level: 'silent' }, new Writable({ write: (_c, _e, cb) => cb() }))

function fakeDeps(records: { credentials?: { id: string; state: string }[]; proofs?: { id: string; state: string }[]; connections?: { id: string }[] }) {
  const deleted: { kind: string; id: string; options?: unknown }[] = []
  const store = {
    credentials: new Map((records.credentials ?? []).map((r) => [r.id, r])),
    proofs: new Map((records.proofs ?? []).map((r) => [r.id, r])),
    connections: new Map((records.connections ?? []).map((r) => [r.id, r])),
  }
  const api = (kind: keyof typeof store) => ({
    findById: async (id: string) => store[kind].get(id) ?? null,
    deleteById: async (id: string, options?: unknown) => {
      deleted.push({ kind, id, options })
      store[kind].delete(id)
    },
  })
  const tenantAgent = { modules: { didcomm: { credentials: api('credentials'), proofs: api('proofs'), connections: api('connections') } } }
  const deps = {
    agent: { modules: { tenants: { withTenantAgent: async (_options: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tenantAgent) } } },
    db: {},
    didcommEndpoint: 'https://agent.test',
    logger: silent,
    pendingCorrelations: new PendingCorrelations(),
  } as unknown as ExchangeDeps
  return { deps, deleted }
}

describe('erase exchange records', () => {
  it('deletes a finished credential exchange with its DIDComm messages', async () => {
    const { deps, deleted } = fakeDeps({ credentials: [{ id: 'c1', state: 'done' }] })
    assert.deepEqual(await eraseExchange(deps, 't1', 'credential', 'c1'), { id: 'c1', erased: true })
    assert.deepEqual(deleted, [{ kind: 'credentials', id: 'c1', options: { deleteAssociatedDidCommMessages: true } }])
  })

  it('deletes abandoned and declined proofs', async () => {
    const { deps, deleted } = fakeDeps({ proofs: [{ id: 'p1', state: 'abandoned' }, { id: 'p2', state: 'declined' }] })
    await eraseExchange(deps, 't1', 'proof', 'p1')
    await eraseExchange(deps, 't1', 'proof', 'p2')
    assert.deepEqual(deleted.map((d) => d.id), ['p1', 'p2'])
  })

  it('refuses a running exchange with 409 and keeps it', async () => {
    const { deps, deleted } = fakeDeps({ credentials: [{ id: 'c1', state: 'offer-sent' }] })
    await assert.rejects(eraseExchange(deps, 't1', 'credential', 'c1'), (error: unknown) => error instanceof ExchangeError && error.status === 409)
    assert.equal(deleted.length, 0)
  })

  it('answers erased: false for an unknown id (idempotent)', async () => {
    const { deps } = fakeDeps({})
    assert.deepEqual(await eraseExchange(deps, 't1', 'proof', 'gone'), { id: 'gone', erased: false })
    assert.deepEqual(await eraseConnection(deps, 't1', 'gone'), { id: 'gone', erased: false })
  })

  it('deletes a connection record', async () => {
    const { deps, deleted } = fakeDeps({ connections: [{ id: 'k1' }] })
    assert.deepEqual(await eraseConnection(deps, 't1', 'k1'), { id: 'k1', erased: true })
    assert.deepEqual(deleted.map((d) => d.kind), ['connections'])
  })
})

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

describe('outbox retention', { skip: database ? false : 'no test database' }, () => {
  after(async () => {
    await database?.pool.end()
  })

  it('deletes acknowledged rows past retention, keeps recent and unacknowledged ones', async () => {
    const { db } = database!
    await db.delete(outbox)
    const now = new Date('2026-09-28T12:00:00Z')
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)
    const base = { tenantId: 't1', recordType: 'credential' as const, state: 'done', payload: {} }
    await db.insert(outbox).values([
      { ...base, recordId: 'old-acked', deliveredAt: daysAgo(40), createdAt: daysAgo(40) },
      { ...base, recordId: 'recent-acked', deliveredAt: daysAgo(5), createdAt: daysAgo(5) },
      { ...base, recordId: 'old-unacked', deliveredAt: null, createdAt: daysAgo(40) },
    ])
    assert.equal(await pruneOutbox(db, 30, now, 1), 1)
    const left = await db.select({ recordId: outbox.recordId }).from(outbox).orderBy(outbox.recordId)
    assert.deepEqual(left.map((r) => r.recordId), ['old-unacked', 'recent-acked'])
    assert.equal(await pruneOutbox(db, 0, now), 0, '0 keeps everything')
  })
})
