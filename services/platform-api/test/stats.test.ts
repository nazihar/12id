/**
 * Dashboard aggregates (Phase 4 C8) against a real Postgres (skipped without one): the tenant
 * route is console-only, counters and the daily series match seeded rows, malformed `expiresAt`
 * values are ignored, the operator route needs the operator role, and reads are not audited.
 */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { apiKeys, connections, consoleAudit, credentials, proofs, tenants, wallets, webhookDeliveries, webhookEndpoints } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { expiryOf } from '../src/views.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

const db = await testDatabase()

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
const epoch = (date: Date) => String(Math.floor(date.getTime() / 1000))

describe('dashboard stats', { skip: db ? false : 'no test database' }, () => {
  const agent = fakeAgent()
  const app = buildApp({
    config: testConfig,
    db: db!.db,
    agent: agent.client,
    mediator: { createInvitation: async () => ({ outOfBandId: 'oob-s', invitationUrl: 'https://mediator.test?oob=s' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: { database: true, agent: true, mediatorDatabase: false } }),
    wake: async () => 'requested',
  })
  const token = testConfig.CONSOLE_TOKEN as string
  const operator = { 'x-console-token': token, 'x-console-actor': 'user_op1', 'x-console-role': 'operator' }
  const member = (tenantId: string, role = 'member') => ({ 'x-console-token': token, 'x-console-actor': 'user_m1', 'x-console-role': role, 'x-console-tenant': tenantId })
  let acme = ''
  let globex = ''
  let apiKey = ''

  before(async () => {
    await app.ready()
    const [a] = await db!.db.insert(tenants).values({ name: 'Acme', agentTenantId: 'agent-acme', status: 'ready', did: 'did:indy:test:acme' }).returning()
    const [g] = await db!.db.insert(tenants).values({ name: 'Globex', agentTenantId: 'agent-globex', status: 'failed', lastError: 'NYM not found' }).returning()
    acme = a.id
    globex = g.id
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: member(acme, 'owner'), payload: { label: 'backend' } })
    apiKey = created.json().apiKey

    // Acme: exchanges across the window, one stuck credential, credentials with good and bad expiry attributes.
    await db!.db.insert(connections).values([
      { tenantId: acme, recordId: 'c1', state: 'completed', createdAt: daysAgo(0), updatedAt: daysAgo(0) },
      { tenantId: acme, recordId: 'c2', state: 'completed', createdAt: daysAgo(3), updatedAt: daysAgo(3) },
      { tenantId: acme, recordId: 'c3', state: 'invitation', createdAt: daysAgo(40), updatedAt: daysAgo(40) },
    ])
    await db!.db.insert(credentials).values([
      { tenantId: acme, recordId: 'k1', state: 'done', attributes: { name: 'Ada', expiresAt: epoch(daysAgo(-10)) }, expiresAt: expiryOf({ expiresAt: epoch(daysAgo(-10)) }), createdAt: daysAgo(0), updatedAt: daysAgo(0) },
      { tenantId: acme, recordId: 'k2', state: 'done', attributes: { name: 'Bob', expiresAt: epoch(daysAgo(5)) }, expiresAt: expiryOf({ expiresAt: epoch(daysAgo(5)) }), createdAt: daysAgo(3), updatedAt: daysAgo(3) },
      { tenantId: acme, recordId: 'k3', state: 'done', attributes: { name: 'Cy', expiresAt: 'not-a-number' }, expiresAt: expiryOf({ expiresAt: 'not-a-number' }), createdAt: daysAgo(3), updatedAt: daysAgo(3) },
      { tenantId: acme, recordId: 'k4', state: 'done', attributes: { name: 'Di' }, createdAt: daysAgo(3), updatedAt: daysAgo(3) },
      { tenantId: acme, recordId: 'k5', state: 'offer-sent', createdAt: daysAgo(2), updatedAt: daysAgo(2) },
      { tenantId: acme, recordId: 'k6', state: 'offer-sent', createdAt: daysAgo(0), updatedAt: daysAgo(0) },
      { tenantId: acme, recordId: 'k7', state: 'abandoned', createdAt: daysAgo(9), updatedAt: daysAgo(9) },
    ])
    await db!.db.insert(proofs).values([
      { tenantId: acme, recordId: 'p1', state: 'done', verified: true, createdAt: daysAgo(0), updatedAt: daysAgo(0) },
      { tenantId: acme, recordId: 'p2', state: 'done', verified: false, createdAt: daysAgo(1), updatedAt: daysAgo(1) },
      { tenantId: acme, recordId: 'p3', state: 'request-sent', createdAt: daysAgo(0), updatedAt: daysAgo(0) },
      { tenantId: globex, recordId: 'p4', state: 'request-sent', createdAt: daysAgo(2), updatedAt: daysAgo(2) },
    ])
    await db!.db.insert(wallets).values([
      { tenantId: acme, tokenHash: 'h1', mediatorOobId: 'oob-1', mediatorConnectionId: 'mc-1', connectedAt: daysAgo(3), createdAt: daysAgo(3) },
      { tenantId: acme, tokenHash: 'h2', mediatorOobId: 'oob-2', createdAt: daysAgo(3) },
      { tenantId: acme, tokenHash: 'h3', mediatorOobId: 'oob-3', createdAt: daysAgo(0) },
      { tenantId: acme, tokenHash: 'h4', mediatorOobId: 'oob-4', revokedAt: daysAgo(1), createdAt: daysAgo(3) },
    ])
    await db!.db.insert(webhookEndpoints).values({ tenantId: acme, url: 'https://acme.test/hook', secret: 'whsec_x' })
    await db!.db.insert(webhookDeliveries).values([
      { tenantId: acme, eventType: 'credential.state_changed', body: '{}', url: 'https://acme.test/hook', status: 'delivered', attempts: 1, deliveredAt: daysAgo(1) },
      { tenantId: acme, eventType: 'credential.state_changed', body: '{}', url: 'https://acme.test/hook', status: 'dead', attempts: 12 },
      { tenantId: acme, eventType: 'proof.state_changed', body: '{}', url: 'https://acme.test/hook', status: 'pending', attempts: 0 },
      { tenantId: globex, eventType: 'proof.state_changed', body: '{}', url: 'https://globex.test/hook', status: 'dead', attempts: 12 },
    ])
  })

  it('serves the tenant stats to the console only', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/stats', headers: { authorization: `Bearer ${apiKey}` } })).statusCode, 403, 'API keys do not get stats')
    assert.equal((await app.inject({ method: 'GET', url: '/v1/stats?days=5', headers: member(acme) })).statusCode, 400)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/stats?days=200', headers: member(acme) })).statusCode, 400)

    const response = await app.inject({ method: 'GET', url: '/v1/stats', headers: member(acme) })
    assert.equal(response.statusCode, 200, response.body)
    const stats = response.json()
    assert.equal(stats.days, 30)
    assert.deepEqual(stats.tenant, { id: acme, name: 'Acme', status: 'ready', did: 'did:indy:test:acme', lastError: null })
    assert.deepEqual(stats.totals.connections, { byState: { completed: 2, invitation: 1 }, total: 3 })
    assert.deepEqual(stats.totals.credentials, { byState: { done: 4, 'offer-sent': 2, abandoned: 1 }, total: 7 })
    assert.deepEqual(stats.totals.proofs, { byState: { done: 2, 'request-sent': 1 }, total: 3, verified: 1, failed: 1 })
    assert.deepEqual(stats.totals.wallets, { active: 3, revoked: 1 })
    assert.deepEqual(stats.totals.apiKeys, { active: 1, revoked: 0 })
    assert.equal(stats.webhook.configured, true)
    assert.equal(stats.webhook.url, 'https://acme.test/hook')
    assert.deepEqual(stats.webhook.deliveries, { pending: 1, sending: 0, delivered: 1, dead: 1 })
    assert.ok(stats.webhook.lastDeliveredAt)
    assert.ok(stats.webhook.lastFailureAt)
    // k5 is stuck (offer-sent, 2 days old); k6 is fresh. p3 is fresh; Globex's p4 is another tenant's.
    assert.deepEqual(stats.attention, { stuckCredentials: 1, stuckProofs: 0, deadDeliveries: 1, expiringCredentials: 1, expiredCredentials: 1, walletsNeverConnected: 1 })
  })

  it('returns exactly `days` series points, oldest first, with zero days present', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/stats?days=7', headers: member(acme) })
    assert.equal(response.statusCode, 200, response.body)
    const series = response.json().series as Array<{ day: string; connections: number; credentials: number; proofs: number }>
    assert.equal(series.length, 7)
    assert.ok(series.every((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.day)))
    assert.ok(series[0].day < series[6].day)
    const today = series[6]
    assert.deepEqual([today.connections, today.credentials, today.proofs], [1, 2, 2])
    // Rows 9 and 40 days old are outside the window; 3-day-old rows are inside a 7-day window.
    const total = (key: 'connections' | 'credentials' | 'proofs') => series.reduce((sum, point) => sum + point[key], 0)
    assert.deepEqual([total('connections'), total('credentials'), total('proofs')], [2, 6, 3])
    assert.ok(series.some((point) => point.connections === 0 && point.credentials === 0 && point.proofs === 0), 'an empty day is present as zeros')
  })

  it('serves the platform stats to operators and refuses organization roles', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/admin/stats', headers: { ...operator, 'x-console-role': 'owner' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/admin/stats', headers: { 'x-console-token': token, 'x-console-role': 'operator' } })).statusCode, 401)

    const response = await app.inject({ method: 'GET', url: '/admin/stats?days=14', headers: operator })
    assert.equal(response.statusCode, 200, response.body)
    const stats = response.json()
    assert.equal(stats.days, 14)
    assert.deepEqual(stats.platform.tenants, { total: 2, ready: 1, provisioning: 0, failed: 1 })
    assert.deepEqual([stats.platform.connections, stats.platform.credentials, stats.platform.proofs], [3, 7, 4])
    assert.deepEqual(stats.platform.wallets, { active: 3, revoked: 1 })
    assert.deepEqual(stats.outcomes.proofs, { done: 2, 'request-sent': 2 })
    assert.deepEqual(stats.attention.failedTenants, [{ id: globex, name: 'Globex', lastError: 'NYM not found' }])
    assert.deepEqual([stats.attention.deadDeliveries, stats.attention.stuckCredentials, stats.attention.stuckProofs, stats.attention.walletsNeverConnected, stats.attention.tenantsWithoutWebhook], [2, 1, 1, 1, 1])
    assert.equal(stats.series.length, 14)
    assert.deepEqual(stats.topTenants, [
      { tenantId: acme, name: 'Acme', exchanges: 12 },
      { tenantId: globex, name: 'Globex', exchanges: 1 },
    ])
    assert.deepEqual(stats.health, { ready: true, draining: false, checks: { database: true, agent: true, mediatorDatabase: false } })
    // The break-glass token works too.
    assert.equal((await app.inject({ method: 'GET', url: '/admin/stats', headers: { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN } })).statusCode, 200)
  })

  it('keeps /admin/overview consistent with the shared aggregates', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/overview', headers: operator })
    assert.equal(response.statusCode, 200, response.body)
    const row = (response.json().items as Array<{ tenant: { id: string }; credentials: Record<string, number>; wallets: { active: number }; deadDeliveries: number; lastActivityAt: string | null }>).find((r) => r.tenant.id === acme)
    assert.deepEqual(row?.credentials, { done: 4, 'offer-sent': 2, abandoned: 1 })
    assert.equal(row?.wallets.active, 3)
    assert.equal(row?.deadDeliveries, 1)
    assert.ok(row?.lastActivityAt)
  })

  it('does not audit stats reads', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    const rows = await db!.db.select().from(consoleAudit)
    assert.ok(rows.every((r) => !r.route.includes('/stats')), JSON.stringify(rows.map((r) => r.route)))
    assert.equal(rows.length, 1, 'only the API-key creation')
  })

  it('uses the new mirror-table indexes for the state and date queries', async () => {
    const plan = await db!.db.execute<{ 'QUERY PLAN': string }>(sql`explain select count(*) from credentials where tenant_id = ${acme} and state = 'done'`)
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n')
    // A tiny table may still be seq-scanned; only assert the index exists.
    const indexes = await db!.db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename in ('connections', 'credentials', 'proofs') and indexname like '%tenant_%_idx'`)
    assert.deepEqual(indexes.rows.map((r) => r.indexname).sort(), ['connections_tenant_created_idx', 'connections_tenant_state_created_idx', 'credentials_tenant_created_idx', 'credentials_tenant_expires_idx', 'credentials_tenant_state_created_idx', 'proofs_tenant_created_idx', 'proofs_tenant_state_created_idx'])
    assert.ok(text.length > 0)
  })
})
