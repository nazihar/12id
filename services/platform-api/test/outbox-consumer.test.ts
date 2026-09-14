/** Outbox consumer against a real Postgres (skipped without one), agent-service doubled. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import type { OutboxRow } from '../src/agent-client.ts'
import { credentials, outboxCursor, proofs, tenants, webhookDeliveries, webhookEndpoints } from '../src/db/schema.ts'
import { createOutboxConsumer } from '../src/outbox-consumer.ts'
import { endpointLookup } from '../src/webhooks/events.ts'
import { fakeAgent, silentLogger, testDatabase } from './helpers.ts'

const db = await testDatabase()

const row = (id: number, recordType: OutboxRow['recordType'], recordId: string, state: string, previousState: string | null, extra: Partial<OutboxRow> = {}): OutboxRow => ({
  id,
  tenantId: 'agent-tenant-1',
  recordType,
  recordId,
  threadId: `thread-${recordId}`,
  state,
  previousState,
  correlationId: null,
  payload: { connectionId: 'conn-1' },
  createdAt: new Date().toISOString(),
  ...extra,
})

describe('outbox consumer', { skip: db ? false : 'no test database' }, () => {
  it('mirrors transitions, ignores stale/duplicate rows, enriches proofs on done and enqueues subscribed events', async () => {
    const [tenant] = await db!.db.insert(tenants).values({ name: 'Acme', agentTenantId: 'agent-tenant-1', status: 'ready' }).returning()
    await db!.db.insert(webhookEndpoints).values({ tenantId: tenant.id, url: 'https://customer.test/hook', secret: 's', events: ['credential.state_changed', 'proof.state_changed'] })
    const agent = fakeAgent()
    agent.outbox.push(
      row(1, 'credential', 'cred-1', 'offer-sent', null, { correlationId: 'emp-42' }),
      row(2, 'credential', 'cred-1', 'request-received', 'offer-sent'),
      row(3, 'connection', 'conn-1', 'completed', 'response-sent', { payload: { outOfBandId: 'oob-1' } }),
      row(4, 'proof', 'proof-1', 'request-sent', null),
      row(5, 'proof', 'proof-1', 'done', 'presentation-received', { payload: { connectionId: 'conn-1', isVerified: true } }),
      row(6, 'credential', 'cred-9', 'offer-sent', null, { tenantId: 'unknown-tenant' })
    )
    const consumer = createOutboxConsumer({ db: db!.db, agent: agent.client, logger: silentLogger, endpoints: endpointLookup(db!.db), batch: 10 })

    assert.equal(await consumer.runOnce(), 6)
    assert.equal(await consumer.readCursor(), 6)

    const [cred] = await db!.db.select().from(credentials).where(eq(credentials.recordId, 'cred-1'))
    assert.equal(cred.state, 'request-received')
    assert.equal(cred.externalId, 'emp-42', 'correlation id from the first event is kept')
    assert.equal(cred.credentialDefinitionId, 'ABC:3:CL:12:default', 'row first seen here is completed from the agent detail')
    assert.equal(cred.lastOutboxId, 2)

    const [proof] = await db!.db.select().from(proofs).where(eq(proofs.recordId, 'proof-1'))
    assert.equal(proof.state, 'done')
    assert.equal(proof.verified, true)
    assert.deepEqual(proof.disclosed, { employee: { name: 'Ada' } })

    const deliveries = await db!.db.select().from(webhookDeliveries).orderBy(webhookDeliveries.id)
    assert.deepEqual(deliveries.map((d) => d.eventType), ['credential.state_changed', 'credential.state_changed', 'proof.state_changed', 'proof.state_changed'], 'connection events are not subscribed; unknown tenant dropped')
    const last = JSON.parse(deliveries[3].body) as { type: string; data: { id: string; state: string; verified: boolean; disclosed: unknown; previousState: string } }
    assert.equal(last.data.id, 'proof-1')
    assert.equal(last.data.verified, true)
    assert.equal(last.data.previousState, 'presentation-received')

    // A replay from a reset cursor (rows 1-6 again, i.e. older ids) changes nothing.
    await db!.db.update(outboxCursor).set({ lastId: 0 })
    assert.equal(await consumer.runOnce(), 6)
    const [again] = await db!.db.select().from(credentials).where(eq(credentials.recordId, 'cred-1'))
    assert.equal(again.state, 'request-received')
    assert.equal((await db!.db.select().from(webhookDeliveries)).length, 4, 'no duplicate deliveries on replay')
  })
})
