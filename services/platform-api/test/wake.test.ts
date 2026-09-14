/** Mediator webhook → wallet.sync_requested, with the mediator lookup doubled (needs Postgres). */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import { tenants, wallets, webhookDeliveries, webhookEndpoints } from '../src/db/schema.ts'
import { handleMediatorWebhook } from '../src/wake.ts'
import { createDispatcher } from '../src/webhooks/dispatcher.ts'
import { endpointLookup } from '../src/webhooks/events.ts'
import { silentLogger, testDatabase } from './helpers.ts'

const db = await testDatabase()

describe('wake path', { skip: db ? false : 'no test database' }, () => {
  it('maps a mediator connection to the wallet through its out-of-band id, debounces, and caches the mapping', async () => {
    const [tenant] = await db!.db.insert(tenants).values({ name: 'Acme', agentTenantId: 'agent-tenant-1', status: 'ready' }).returning()
    await db!.db.insert(webhookEndpoints).values({ tenantId: tenant.id, url: 'https://customer.test/hook', secret: 's', events: null })
    const [wallet] = await db!.db.insert(wallets).values({ tenantId: tenant.id, externalId: 'user-7', tokenHash: 'h', mediatorOobId: 'oob-w1' }).returning()
    const lookups: string[] = []
    let clock = new Date('2026-09-14T10:00:00Z')
    const deps = {
      db: db!.db,
      mediator: {
        outOfBandIdForConnection: async (connectionId: string) => {
          lookups.push(connectionId)
          return connectionId === 'med-1' ? 'oob-w1' : null
        },
      },
      endpoints: endpointLookup(db!.db),
      logger: silentLogger,
      debounceMs: 30_000,
      now: () => clock,
    }

    assert.equal(await handleMediatorWebhook(deps, 'stranger'), 'unknown_connection')
    assert.equal(await handleMediatorWebhook(deps, 'med-1'), 'requested')
    assert.equal(await handleMediatorWebhook(deps, 'med-1'), 'debounced', 'second message inside the window')
    assert.deepEqual(lookups, ['stranger', 'med-1'], 'the mapping is cached on the wallet after the first hit')

    clock = new Date(clock.getTime() + 31_000)
    assert.equal(await handleMediatorWebhook(deps, 'med-1'), 'requested')

    const deliveries = await db!.db.select().from(webhookDeliveries)
    assert.equal(deliveries.length, 2)
    const body = JSON.parse(deliveries[0].body) as { type: string; data: { walletId: string; externalId: string } }
    assert.equal(body.type, 'wallet.sync_requested')
    assert.equal(body.data.walletId, wallet.id)
    assert.equal(body.data.externalId, 'user-7')
    const [cached] = await db!.db.select().from(wallets).where(eq(wallets.id, wallet.id))
    assert.equal(cached.mediatorConnectionId, 'med-1')

    // A revoked wallet no longer wakes anyone.
    await db!.db.update(wallets).set({ revokedAt: new Date() }).where(eq(wallets.id, wallet.id))
    clock = new Date(clock.getTime() + 31_000)
    assert.equal(await handleMediatorWebhook(deps, 'med-1'), 'unknown_connection')
  })

  it('delivers, retries with backoff and dead-letters through the dispatcher', async () => {
    await db!.db.delete(webhookDeliveries)
    const [tenant] = await db!.db.insert(tenants).values({ name: 'Acme', agentTenantId: 'agent-tenant-2', status: 'ready' }).returning()
    await db!.db.insert(webhookEndpoints).values({ tenantId: tenant.id, url: 'https://customer.test/hook', secret: 'whsec_s', events: null })
    await db!.db.insert(webhookDeliveries).values([
      { tenantId: tenant.id, eventType: 'proof.state_changed', body: '{"n":1}', url: 'https://customer.test/ok' },
      { tenantId: tenant.id, eventType: 'proof.state_changed', body: '{"n":2}', url: 'https://customer.test/fail' },
    ])
    let clock = new Date('2026-09-14T10:00:00Z')
    const fetchMock = (async (url: string | URL | Request) => new Response('', { status: String(url).endsWith('/ok') ? 200 : 503 })) as typeof fetch
    const dispatcher = createDispatcher({ db: db!.db, logger: silentLogger, timeoutMs: 1000, maxAttempts: 2, fetch: fetchMock, now: () => clock, random: () => 0.5 })

    assert.equal(await dispatcher.runOnce(), 2)
    let rows = await db!.db.select().from(webhookDeliveries).orderBy(webhookDeliveries.id)
    assert.equal(rows[0].status, 'delivered')
    assert.equal(rows[1].status, 'pending')
    assert.equal(rows[1].attempts, 1)
    assert.equal(rows[1].lastStatusCode, 503)
    assert.equal(rows[1].nextAttemptAt.getTime() - clock.getTime(), 5_000)

    assert.equal(await dispatcher.runOnce(), 0, 'not due yet')
    clock = new Date(clock.getTime() + 6_000)
    assert.equal(await dispatcher.runOnce(), 1)
    rows = await db!.db.select().from(webhookDeliveries).orderBy(webhookDeliveries.id)
    assert.equal(rows[1].status, 'dead')
    assert.equal(rows[1].attempts, 2)

    // A crash between claim and result leaves `sending`; recovery returns it to pending after the lease.
    await db!.db.update(webhookDeliveries).set({ status: 'sending', nextAttemptAt: new Date(clock.getTime() - 200_000) }).where(eq(webhookDeliveries.id, rows[0].id))
    assert.equal(await dispatcher.recoverStale(), 1)
  })
})
