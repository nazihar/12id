/** Per-principal request limits (review M4): the store, and 429s through the real app (needs Postgres). */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import { tenants } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { memoryRateLimitStore } from '../src/http/rate-limit.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

describe('rate-limit store', () => {
  it('counts per key inside a fixed window and starts over after it', () => {
    const store = memoryRateLimitStore()
    assert.deepEqual(store.hit('a', 1000, 0), { count: 1, resetAt: 1000 })
    assert.equal(store.hit('a', 1000, 500).count, 2)
    assert.equal(store.hit('b', 1000, 500).count, 1, 'keys are independent')
    assert.deepEqual(store.hit('a', 1000, 1000), { count: 1, resetAt: 2000 }, 'a new window')
  })

  it('forgets expired windows', () => {
    const store = memoryRateLimitStore()
    for (let i = 0; i < 50; i += 1) store.hit(`k${i}`, 1000, 0)
    store.hit('late', 1000, 120_000)
    assert.equal(store.size(), 1)
  })
})

const db = await testDatabase()

describe('rate limits through the app', { skip: db ? false : 'no test database' }, () => {
  const config = { ...testConfig, RATE_LIMIT_API_KEY_PER_MIN: 3, RATE_LIMIT_WALLET_PER_MIN: 5, RATE_LIMIT_INVITATION_PER_10MIN: 2 }
  let invitations = 0
  const app = buildApp({
    config,
    db: db!.db,
    agent: fakeAgent().client,
    mediator: { createInvitation: async () => ({ outOfBandId: `oob-rl-${++invitations}`, invitationUrl: 'https://mediator.test' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async () => 'requested',
  })
  const admin = { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN }
  let key = ''
  let tenantId = ''

  before(async () => {
    await app.ready()
    tenantId = (await app.inject({ method: 'POST', url: '/admin/tenants', headers: admin, payload: { name: 'Limited' } })).json().id
    key = (await app.inject({ method: 'POST', url: `/admin/tenants/${tenantId}/api-keys`, headers: admin, payload: { label: 'rl' } })).json().apiKey
  })

  it('answers 429 with Retry-After once an API key passes its limit; the console is not limited', async () => {
    const auth = { authorization: `Bearer ${key}` }
    for (let i = 0; i < 3; i += 1) assert.equal((await app.inject({ url: '/v1/connections', headers: auth })).statusCode, 200)
    const limited = await app.inject({ url: '/v1/connections', headers: auth })
    assert.equal(limited.statusCode, 429)
    assert.equal(limited.json().error, 'rate_limited')
    assert.ok(Number(limited.headers['retry-after']) >= 1)
    const console = { 'x-console-token': testConfig.CONSOLE_TOKEN!, 'x-console-actor': 'u', 'x-console-role': 'owner', 'x-console-tenant': tenantId }
    for (let i = 0; i < 5; i += 1) assert.equal((await app.inject({ url: '/v1/connections', headers: console })).statusCode, 200)
  })

  it('an operator override on the tenant replaces the default limit', async () => {
    await db!.db.update(tenants).set({ rateLimitPerMin: 50 }).where(eq(tenants.id, tenantId))
    const fresh = (await app.inject({ method: 'POST', url: `/admin/tenants/${tenantId}/api-keys`, headers: admin, payload: { label: 'rl2' } })).json().apiKey
    for (let i = 0; i < 6; i += 1) assert.equal((await app.inject({ url: '/v1/connections', headers: { authorization: `Bearer ${fresh}` } })).statusCode, 200)
  })

  it('limits mediator invitations per wallet more tightly than other wallet calls', async () => {
    const fresh = (await app.inject({ method: 'POST', url: `/admin/tenants/${tenantId}/api-keys`, headers: admin, payload: { label: 'rl3' } })).json().apiKey
    const walletToken = (await app.inject({ method: 'POST', url: '/v1/wallets', headers: { authorization: `Bearer ${fresh}` }, payload: {} })).json().walletToken
    const wallet = { authorization: `Bearer ${walletToken}` }
    assert.equal((await app.inject({ url: '/v1/wallet/mediator-invitation', headers: wallet })).statusCode, 200)
    assert.equal((await app.inject({ url: '/v1/wallet/mediator-invitation', headers: wallet })).statusCode, 200)
    const third = await app.inject({ url: '/v1/wallet/mediator-invitation', headers: wallet })
    assert.equal(third.statusCode, 429)
    assert.equal(invitations, 2, 'the refused call created no mediator record')
    assert.equal((await app.inject({ url: '/v1/wallet', headers: wallet })).statusCode, 200, 'other wallet calls still pass')
    for (let i = 0; i < 2; i += 1) await app.inject({ url: '/v1/wallet', headers: wallet })
    assert.equal((await app.inject({ url: '/v1/wallet', headers: wallet })).statusCode, 429, 'then the per-wallet limit applies')
  })
})
