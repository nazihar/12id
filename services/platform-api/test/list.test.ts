/**
 * List routes (Phase 4 C9) against a real Postgres (skipped without one): the page envelope, the
 * fixed newest-first order with a stable tie-break, contains search, state and date filters,
 * tenant isolation, per-page operator overview, and the 0007 indexes.
 */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { connections, consoleAudit, credentials, tenants, wallets, webhookDeliveries } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

const db = await testDatabase()

describe('list routes', { skip: db ? false : 'no test database' }, () => {
  const agent = fakeAgent()
  const app = buildApp({
    config: testConfig,
    db: db!.db,
    agent: agent.client,
    mediator: { createInvitation: async () => ({ outOfBandId: 'oob-l', invitationUrl: 'https://mediator.test?oob=l' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async () => 'requested',
  })
  const token = testConfig.CONSOLE_TOKEN as string
  const operator = { 'x-console-token': token, 'x-console-actor': 'user_op1', 'x-console-role': 'operator' }
  const member = (tenantId: string) => ({ 'x-console-token': token, 'x-console-actor': 'user_m1', 'x-console-role': 'member', 'x-console-tenant': tenantId })
  const at = new Date('2026-09-01T12:00:00Z')
  const day = (n: number) => new Date(at.getTime() + n * 24 * 60 * 60 * 1000)
  let acme = ''
  let globex = ''
  let failed = ''

  const get = async (url: string, headers: Record<string, string>) => {
    const response = await app.inject({ method: 'GET', url, headers })
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`)
    return response.json() as { items: Array<Record<string, unknown>>; total: number; page: number; pageSize: number }
  }

  before(async () => {
    await app.ready()
    const [a] = await db!.db.insert(tenants).values({ name: 'Acme Corp', agentTenantId: 'agent-acme', status: 'ready' }).returning()
    const [g] = await db!.db.insert(tenants).values({ name: 'Globex', agentTenantId: 'agent-globex', status: 'ready' }).returning()
    const [f] = await db!.db.insert(tenants).values({ name: 'Initech', agentTenantId: 'agent-initech', status: 'failed' }).returning()
    failed = f.id
    acme = a.id
    globex = g.id
    // 30 connections for Acme: ten share one created_at (tie-break), the rest one per day.
    await db!.db.insert(connections).values(
      Array.from({ length: 30 }, (_, i) => ({
        tenantId: acme,
        recordId: `conn-${String(i).padStart(2, '0')}`,
        state: i % 3 === 0 ? 'completed' : 'response-sent',
        externalId: i === 7 ? 'Customer-100_%-special' : `customer-${i}`,
        theirLabel: i === 4 ? 'Ada Lovelace' : null,
        createdAt: i < 10 ? at : day(i),
      }))
    )
    await db!.db.insert(connections).values({ tenantId: globex, recordId: 'conn-g', state: 'completed', externalId: 'customer-7', createdAt: at })
    await db!.db.insert(credentials).values([
      { tenantId: acme, recordId: 'cred-1', state: 'done', externalId: 'order-ABC-1', createdAt: day(1) },
      { tenantId: acme, recordId: 'cred-2', state: 'offer-sent', externalId: 'order-xyz-2', createdAt: day(2) },
      { tenantId: acme, recordId: 'cred-3', state: 'abandoned', externalId: 'order-abc-3', createdAt: day(3) },
    ])
    await db!.db.insert(wallets).values([
      { tenantId: acme, externalId: 'phone-1', tokenHash: 'h1', createdAt: day(1) },
      { tenantId: acme, externalId: 'phone-2', tokenHash: 'h2', createdAt: day(2), revokedAt: day(3) },
    ])
    await db!.db.insert(webhookDeliveries).values([
      { tenantId: acme, eventType: 'credential.state_changed', body: '{}', url: 'https://a.test', status: 'dead', createdAt: day(1) },
      { tenantId: acme, eventType: 'proof.state_changed', body: '{}', url: 'https://a.test', status: 'delivered', createdAt: day(2) },
      { tenantId: globex, eventType: 'proof.state_changed', body: '{}', url: 'https://g.test', status: 'dead', createdAt: day(3) },
    ])
    await db!.db.insert(consoleAudit).values([
      { actor: 'user_a', role: 'owner', tenantId: acme, method: 'POST', route: '/v1/api-keys', statusCode: 201, requestId: 'r1', at: day(1) },
      { actor: 'user_b', role: 'admin', tenantId: acme, method: 'PUT', route: '/v1/webhook', statusCode: 200, requestId: 'r2', at: day(2) },
    ])
  })

  it('pages newest first with a total and a stable tie-break', async () => {
    const first = await get('/v1/connections', member(acme))
    assert.equal(first.total, 30)
    assert.equal(first.page, 1)
    assert.equal(first.pageSize, 25)
    assert.equal(first.items.length, 25)
    assert.equal(first.items[0].id, 'conn-29', 'newest first')
    const second = await get('/v1/connections?page=2', member(acme))
    assert.equal(second.items.length, 5)
    const ids = [...first.items, ...second.items].map((row) => row.id)
    assert.equal(new Set(ids).size, 30, 'pages never overlap, even at equal createdAt')
    assert.deepEqual((await get('/v1/connections?page=9', member(acme))).items, [])
  })

  it('refuses page sizes other than 25, 50 or 100', async () => {
    assert.equal((await get('/v1/connections?pageSize=50', member(acme))).items.length, 30)
    for (const size of ['10', '200', 'x']) assert.equal((await app.inject({ url: `/v1/connections?pageSize=${size}`, headers: member(acme) })).statusCode, 400, size)
    assert.equal((await app.inject({ url: '/v1/connections?page=0', headers: member(acme) })).statusCode, 400)
    assert.equal((await app.inject({ url: '/v1/connections?limit=10', headers: member(acme) })).statusCode, 200, 'unknown parameters are ignored')
  })

  it('searches the external id as a case-insensitive contains, with LIKE wildcards taken literally', async () => {
    const byFragment = await get('/v1/connections?externalId=OMER-2', member(acme))
    assert.deepEqual(byFragment.items.map((row) => row.externalId).sort(), ['customer-2', 'customer-20', 'customer-21', 'customer-22', 'customer-23', 'customer-24', 'customer-25', 'customer-26', 'customer-27', 'customer-28', 'customer-29'])
    assert.deepEqual((await get(`/v1/connections?externalId=${encodeURIComponent('_%')}`, member(acme))).items.map((row) => row.externalId), ['Customer-100_%-special'])
    assert.equal((await get(`/v1/connections?externalId=${encodeURIComponent('%')}`, member(acme))).total, 1, '% is not a wildcard')
    assert.deepEqual((await get('/v1/connections?q=lovelace', member(acme))).items.map((row) => row.id), ['conn-04'], 'q also matches the holder label')
    assert.deepEqual((await get('/v1/credentials?externalId=abc', member(acme))).items.map((row) => row.id), ['cred-3', 'cred-1'])
  })

  it('never returns another tenant’s rows', async () => {
    // Acme's conn-07 carries a different external id, so only Globex has `customer-7`.
    assert.deepEqual((await get('/v1/connections?externalId=customer-7', member(acme))).items, [])
    assert.deepEqual((await get('/v1/connections?externalId=customer-7', member(globex))).items.map((row) => row.id), ['conn-g'])
    assert.equal((await get('/v1/connections?pageSize=100', member(acme))).total, 30)
  })

  it('filters by one or several states and by a created range', async () => {
    assert.equal((await get('/v1/connections?state=completed', member(acme))).total, 10)
    assert.equal((await get('/v1/connections?state=completed&state=response-sent', member(acme))).total, 30)
    assert.deepEqual((await get('/v1/credentials?state=done&state=abandoned', member(acme))).items.map((row) => row.id), ['cred-3', 'cred-1'])
    const range = await get(`/v1/credentials?from=${encodeURIComponent(day(2).toISOString())}&to=${encodeURIComponent(day(3).toISOString())}`, member(acme))
    assert.deepEqual(range.items.map((row) => row.id), ['cred-2'], 'from inclusive, to exclusive')
    assert.equal((await app.inject({ url: '/v1/credentials?from=yesterday', headers: member(acme) })).statusCode, 400)
  })

  it('filters wallets, deliveries, API keys, templates and the audit log', async () => {
    assert.deepEqual((await get('/v1/wallets?status=revoked', member(acme))).items.map((row) => row.externalId), ['phone-2'])
    assert.deepEqual((await get('/v1/wallets?q=PHONE', member(acme))).items.map((row) => row.externalId), ['phone-2', 'phone-1'])
    assert.deepEqual((await get('/v1/webhook/deliveries?eventType=credential.state_changed', member(acme))).items.map((row) => row.status), ['dead'])
    assert.equal((await get('/v1/webhook/deliveries', member(acme))).total, 2)
    assert.equal((await get('/v1/api-keys?status=active', member(acme))).total, 0)
    assert.equal((await get('/v1/proof-templates?q=none', member(acme))).total, 0)
    const dead = await get('/admin/webhook-deliveries?status=dead', operator)
    assert.deepEqual(dead.items.map((row) => row.tenantId), [globex, acme], 'newest first across tenants')
    assert.deepEqual((await get('/admin/audit?actor=user_a&actor=user_b', operator)).items.map((row) => row.requestId), ['r2', 'r1'])
    assert.deepEqual((await get('/admin/audit?q=webhook', operator)).items.map((row) => row.requestId), ['r2'])
    // One search box: the route, the actor id, or an account the console resolved from a name or email.
    assert.deepEqual((await get('/admin/audit?q=user_a', operator)).items.map((row) => row.requestId), ['r1'])
    assert.deepEqual((await get('/admin/audit?q=ada%40acme.test&qActor=user_b', operator)).items.map((row) => row.requestId), ['r2'])
  })

  it('pages the operator overview and computes its aggregates for that page only', async () => {
    const byName = await get('/admin/overview?q=acme', operator)
    assert.equal(byName.total, 1)
    const row = byName.items[0] as { tenant: { id: string }; connections: Record<string, number>; deadDeliveries: number }
    assert.equal(row.tenant.id, acme)
    assert.deepEqual(row.connections, { completed: 10, 'response-sent': 20 })
    assert.equal(row.deadDeliveries, 1)
    assert.deepEqual((await get('/admin/overview?status=failed', operator)).items.map((r) => (r.tenant as { id: string }).id), [failed])
    assert.deepEqual((await get('/admin/overview?q=nobody', operator)).items, [])
  })

  it('pages the catalogue through agent-service', async () => {
    const schemas = await get('/v1/schemas?status=published', member(acme))
    assert.deepEqual(schemas.items.map((row) => row.id), ['schema-2'])
    const defs = await get('/v1/credential-definitions?q=visitor', member(acme))
    assert.deepEqual(defs.items.map((row) => row.id), ['cd-3'])
    const call = agent.calls.filter((c) => c.method === 'listCataloguePage').pop()
    assert.deepEqual(call?.args[1], { kind: 'credential_definition', q: 'visitor', page: 1, pageSize: 25 })
  })

  it('has the 0007 list indexes and pg_trgm', async () => {
    const ext = await db!.db.execute<{ extname: string }>(sql`select extname from pg_extension where extname = 'pg_trgm'`)
    assert.equal(ext.rows.length, 1)
    const indexes = await db!.db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public'`)
    const names = new Set(indexes.rows.map((r) => r.indexname))
    for (const name of [
      'connections_external_id_trgm_idx',
      'connections_their_label_trgm_idx',
      'credentials_external_id_trgm_idx',
      'proofs_external_id_trgm_idx',
      'wallets_external_id_trgm_idx',
      'connections_tenant_state_created_idx',
      'wallets_tenant_created_idx',
      'api_keys_tenant_created_idx',
      'proof_templates_tenant_created_idx',
      'webhook_deliveries_tenant_created_idx',
      'webhook_deliveries_dead_created_idx',
      'console_audit_actor_idx',
    ]) assert.ok(names.has(name), name)
  })
})
