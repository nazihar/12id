/**
 * Webhook dispatcher against a real Postgres (skipped without one): the fair-share pool (review M2),
 * the endpoint's current URL on every attempt (M8) and both signatures during a rotation (M9).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import { tenants, webhookDeliveries, webhookEndpoints } from '../src/db/schema.ts'
import { createDispatcher } from '../src/webhooks/dispatcher.ts'
import { verifySignature } from '../src/webhooks/signer.ts'
import { silentLogger, testDatabase } from './helpers.ts'

const db = await testDatabase()

async function tenantWithEndpoint(name: string, url: string, extra: Partial<typeof webhookEndpoints.$inferInsert> = {}) {
  const [tenant] = await db!.db.insert(tenants).values({ name, agentTenantId: `agent-${name}`, status: 'ready' }).returning()
  await db!.db.insert(webhookEndpoints).values({ tenantId: tenant.id, url, secret: 'whsec_current', events: null, ...extra })
  return tenant.id
}

const due = (tenantId: string, n: number, at = new Date(Date.now() - 1000)) =>
  db!.db.insert(webhookDeliveries).values(Array.from({ length: n }, (_, i) => ({ tenantId, eventType: 'proof.state_changed', body: JSON.stringify({ n: i }), url: 'https://snapshot.test/old', nextAttemptAt: at })))

const waitUntil = async (label: string, check: () => Promise<boolean>, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out: ${label}`)
}

describe('webhook dispatcher pool', { skip: db ? false : 'no test database' }, () => {
  it('a slow endpoint does not hold up another tenant (M2)', async () => {
    await db!.db.delete(webhookDeliveries)
    const slow = await tenantWithEndpoint('slow', 'https://slow.test/hook')
    const fast = await tenantWithEndpoint('fast', 'https://fast.test/hook')
    await due(slow, 12)
    await due(fast, 5)

    let release: () => void = () => undefined
    const hanging = new Promise<void>((resolve) => (release = resolve))
    const fetchMock = (async (url: string | URL | Request) => {
      if (String(url).startsWith('https://slow.test')) await hanging
      return new Response('', { status: 200 })
    }) as typeof fetch
    const dispatcher = createDispatcher({ db: db!.db, logger: silentLogger, timeoutMs: 5000, maxAttempts: 3, fetch: fetchMock, concurrency: 8, perTenant: 2 })
    const started = Date.now()
    const stop = dispatcher.start(20)
    try {
      await waitUntil('every fast delivery delivered', async () => {
        const rows = await db!.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, fast))
        return rows.every((row) => row.status === 'delivered')
      })
      assert.ok(Date.now() - started < 1500, `fast tenant finished in ${Date.now() - started} ms while the slow one hangs`)
      await waitUntil('the slow tenant takes the freed slots once nobody else waits', async () => dispatcher.inFlight() === 8)
    } finally {
      release()
      await stop()
      await waitUntil('drained', async () => dispatcher.inFlight() === 0)
    }
  })

  it('a single tenant uses every slot (never throttled when alone)', async () => {
    await db!.db.delete(webhookDeliveries)
    const only = await tenantWithEndpoint('alone', 'https://alone.test/hook')
    await due(only, 20)
    let active = 0
    let peak = 0
    const fetchMock = (async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 50))
      active -= 1
      return new Response('', { status: 200 })
    }) as typeof fetch
    const dispatcher = createDispatcher({ db: db!.db, logger: silentLogger, timeoutMs: 1000, maxAttempts: 3, fetch: fetchMock, concurrency: 8, perTenant: 2 })
    assert.equal(await dispatcher.runOnce(), 8)
    assert.equal(peak, 8)
  })

  it('posts every attempt to the endpoint URL of that moment (M8)', async () => {
    await db!.db.delete(webhookDeliveries)
    const tenantId = await tenantWithEndpoint('moved', 'https://before.test/hook')
    let clock = new Date(Date.now() - 1000)
    await due(tenantId, 1, clock)
    const seen: string[] = []
    const fetchMock = (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response('', { status: seen.length === 1 ? 503 : 200 })
    }) as typeof fetch
    const dispatcher = createDispatcher({ db: db!.db, logger: silentLogger, timeoutMs: 1000, maxAttempts: 3, fetch: fetchMock, now: () => clock, random: () => 0.5 })
    assert.equal(await dispatcher.runOnce(), 1)
    await db!.db.update(webhookEndpoints).set({ url: 'https://after.test/hook' }).where(eq(webhookEndpoints.tenantId, tenantId))
    clock = new Date(clock.getTime() + 6_000)
    assert.equal(await dispatcher.runOnce(), 1)
    assert.deepEqual(seen, ['https://before.test/hook', 'https://after.test/hook'], 'never the snapshot, and the retry follows the change')
    const [row] = await db!.db.select().from(webhookDeliveries)
    assert.equal(row.status, 'delivered')
    assert.equal(row.url, 'https://after.test/hook', 'the row records where the last attempt went')
  })

  it('signs with the replaced secret too for 24 h after a rotation (M9)', async () => {
    await db!.db.delete(webhookDeliveries)
    const clock = new Date()
    const tenantId = await tenantWithEndpoint('rotated', 'https://rotated.test/hook', { secret: 'whsec_new', previousSecret: 'whsec_old', rotatedAt: new Date(clock.getTime() - 60 * 60 * 1000) })
    await due(tenantId, 1, new Date(clock.getTime() - 1000))
    const headers: string[] = []
    const bodies: string[] = []
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push((init?.headers as Record<string, string>)['x-12id-signature'])
      bodies.push(String(init?.body))
      return new Response('', { status: 200 })
    }) as typeof fetch
    const dispatcher = createDispatcher({ db: db!.db, logger: silentLogger, timeoutMs: 1000, maxAttempts: 3, fetch: fetchMock, now: () => clock })
    await dispatcher.runOnce()
    const nowSeconds = Math.floor(clock.getTime() / 1000)
    assert.equal(verifySignature('whsec_old', bodies[0], headers[0], nowSeconds), true, 'a receiver still on the old secret accepts it')
    assert.equal(verifySignature('whsec_new', bodies[0], headers[0], nowSeconds), true)

    // Past the overlap only the current secret signs.
    await db!.db.update(webhookEndpoints).set({ rotatedAt: new Date(clock.getTime() - 25 * 60 * 60 * 1000) }).where(eq(webhookEndpoints.tenantId, tenantId))
    await due(tenantId, 1, new Date(clock.getTime() - 1000))
    await dispatcher.runOnce()
    assert.equal(verifySignature('whsec_old', bodies[1], headers[1], nowSeconds), false)
    assert.equal(verifySignature('whsec_new', bodies[1], headers[1], nowSeconds), true)
  })
})
