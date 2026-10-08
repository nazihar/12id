/**
 * Message purge: a finished exchange's stored DIDComm messages are deleted once the platform has
 * acknowledged the final outbox row, and never before (real Postgres, skipped when unreachable).
 */
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'

import { eq } from 'drizzle-orm'
import { pino } from 'pino'

import type { RootAgent } from '../src/agent/root-agent.ts'
import { createDatabase } from '../src/db/client.ts'
import { ensureDatabase, runMigrations } from '../src/db/migrate.ts'
import { OUTBOX_FINAL_STATES, outbox } from '../src/db/schema.ts'
import { FINAL_CREDENTIAL_STATES, FINAL_PROOF_STATES } from '../src/exchanges/exchanges.ts'
import { purgeFinishedMessages } from '../src/exchanges/message-purge.ts'

const silent = pino({ level: 'silent' }, new Writable({ write: (_c, _e, cb) => cb() }))

/** Tenant wallets holding message records keyed by the exchange they belong to. */
function fakeAgent(messages: Record<string, string[]>, failing: { tenants?: string[]; records?: string[] } = {}) {
  const stored = new Map(Object.entries(messages).map(([recordId, ids]) => [recordId, [...ids]]))
  const repository = {
    findByQuery: async (_context: unknown, query: { associatedRecordId: string }) => {
      if (failing.records?.includes(query.associatedRecordId)) throw new Error('wallet error')
      return (stored.get(query.associatedRecordId) ?? []).map((id) => ({ id, associatedRecordId: query.associatedRecordId }))
    },
    delete: async (_context: unknown, message: { id: string; associatedRecordId: string }) => {
      stored.set(message.associatedRecordId, (stored.get(message.associatedRecordId) ?? []).filter((id) => id !== message.id))
    },
  }
  const tenantAgent = { context: {}, dependencyManager: { resolve: () => repository } }
  const agent = {
    modules: {
      tenants: {
        withTenantAgent: async ({ tenantId }: { tenantId: string }, fn: (t: unknown) => Promise<unknown>) => {
          if (failing.tenants?.includes(tenantId)) throw new Error('no session for tenant')
          return fn(tenantAgent)
        },
      },
    },
  } as unknown as RootAgent
  return { agent, left: (recordId: string) => stored.get(recordId)?.length ?? 0 }
}

describe('final states', () => {
  it('the outbox predicate covers exactly the states the erase path calls final', () => {
    assert.deepEqual([...OUTBOX_FINAL_STATES].sort(), [...new Set([...FINAL_CREDENTIAL_STATES, ...FINAL_PROOF_STATES])].sort())
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

describe('message purge', { skip: database ? false : 'no test database' }, () => {
  after(async () => {
    await database?.pool.end()
  })

  const delivered = new Date('2026-10-08T10:00:00Z')
  const row = (tenantId: string, recordType: 'connection' | 'credential' | 'proof', recordId: string, state: string, deliveredAt: Date | null = delivered) => ({ tenantId, recordType, recordId, state, deliveredAt, payload: {} })
  const purgedIds = async () => {
    const rows = await database!.db.select({ recordId: outbox.recordId, state: outbox.state, at: outbox.messagesPurgedAt }).from(outbox).orderBy(outbox.id)
    return rows.filter((r) => r.at).map((r) => `${r.recordId}:${r.state}`)
  }

  it('purges acknowledged finished exchanges only, and a second run does nothing', async () => {
    const { db } = database!
    await db.delete(outbox)
    await db.insert(outbox).values([
      row('t1', 'credential', 'c-done', 'offer-sent'),
      row('t1', 'credential', 'c-done', 'done'),
      row('t1', 'credential', 'c-running', 'request-received'),
      row('t1', 'credential', 'c-unacked', 'done', null),
      row('t1', 'proof', 'p-abandoned', 'abandoned'),
      row('t2', 'proof', 'p-done', 'done'),
      row('t2', 'connection', 'k-completed', 'completed'),
    ])
    const { agent, left } = fakeAgent({ 'c-done': ['m1', 'm2', 'm3'], 'c-running': ['m4', 'm5'], 'c-unacked': ['m6', 'm7', 'm8'], 'p-abandoned': ['m9'], 'p-done': ['m10', 'm11'], 'k-completed': ['m12'] })

    // A batch of 2 makes the run page through the due rows.
    assert.deepEqual(await purgeFinishedMessages(agent, db, silent, { batch: 2 }), { exchanges: 3, messages: 6 })
    assert.deepEqual([left('c-done'), left('p-abandoned'), left('p-done')], [0, 0, 0])
    assert.deepEqual([left('c-running'), left('c-unacked'), left('k-completed')], [2, 3, 1], 'running, unacknowledged and connection records keep their messages')
    assert.deepEqual(await purgedIds(), ['c-done:done', 'p-abandoned:abandoned', 'p-done:done'])

    assert.deepEqual(await purgeFinishedMessages(agent, db, silent), { exchanges: 0, messages: 0 })

    // The platform acknowledges the row later: the next run takes it.
    await db.update(outbox).set({ deliveredAt: delivered }).where(eq(outbox.recordId, 'c-unacked'))
    assert.deepEqual(await purgeFinishedMessages(agent, db, silent), { exchanges: 1, messages: 3 })
    assert.equal(left('c-unacked'), 0)
  })

  it('marks an exchange that has no stored messages (already erased)', async () => {
    const { db } = database!
    await db.delete(outbox)
    await db.insert(outbox).values([row('t1', 'credential', 'c-erased', 'done')])
    assert.deepEqual(await purgeFinishedMessages(fakeAgent({}).agent, db, silent), { exchanges: 1, messages: 0 })
    assert.deepEqual(await purgedIds(), ['c-erased:done'])
  })

  it('a failing tenant or record does not block the others, and stays due', async () => {
    const { db } = database!
    await db.delete(outbox)
    await db.insert(outbox).values([
      row('t-broken', 'credential', 'c-1', 'done'),
      row('t1', 'credential', 'c-bad', 'done'),
      row('t1', 'credential', 'c-good', 'done'),
      row('t2', 'proof', 'p-1', 'done'),
    ])
    const messages = { 'c-1': ['m1'], 'c-bad': ['m2'], 'c-good': ['m3'], 'p-1': ['m4'] }
    const broken = fakeAgent(messages, { tenants: ['t-broken'], records: ['c-bad'] })
    assert.deepEqual(await purgeFinishedMessages(broken.agent, db, silent, { batch: 1 }), { exchanges: 2, messages: 2 })
    assert.deepEqual(await purgedIds(), ['c-good:done', 'p-1:done'])

    const healthy = fakeAgent({ 'c-1': ['m1'], 'c-bad': ['m2'] })
    assert.deepEqual(await purgeFinishedMessages(healthy.agent, db, silent), { exchanges: 2, messages: 2 })
  })

  it('stops between batches when asked', async () => {
    const { db } = database!
    await db.delete(outbox)
    await db.insert(outbox).values([row('t1', 'credential', 'c-1', 'done'), row('t1', 'credential', 'c-2', 'done')])
    const { agent, left } = fakeAgent({ 'c-1': ['m1'], 'c-2': ['m2'] })
    // Asked to stop as soon as the first exchange is done.
    assert.deepEqual(await purgeFinishedMessages(agent, db, silent, { batch: 1, stopped: () => left('c-1') === 0 }), { exchanges: 1, messages: 1 })
    assert.equal(left('c-2'), 1)
  })
})
