/**
 * Console scope (Phase 4 C1) against a real Postgres (skipped without one): console headers on the
 * customer routes, API-key management reserved to the console, operator routes and the audit log.
 */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { consoleAudit, idempotencyKeys, webhookDeliveries } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

const db = await testDatabase()

/** Audit rows are written after the response is sent; wait until at least `atLeast` exist. */
async function auditRows(atLeast: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await db!.db.select().from(consoleAudit).orderBy(consoleAudit.id)
    if (rows.length >= atLeast) return rows
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return db!.db.select().from(consoleAudit).orderBy(consoleAudit.id)
}

describe('console scope', { skip: db ? false : 'no test database' }, () => {
  let agentTenants = 0
  const agent = fakeAgent({ createTenant: async () => ({ tenantId: `agent-tenant-${(agentTenants += 1)}`, status: 'pending' }) })
  const app = buildApp({
    config: testConfig,
    db: db!.db,
    agent: agent.client,
    mediator: { createInvitation: async () => ({ outOfBandId: 'oob-c', invitationUrl: 'https://mediator.test?oob=c' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async () => 'requested',
  })
  const token = testConfig.CONSOLE_TOKEN as string
  const operator = { 'x-console-token': token, 'x-console-actor': 'user_op1', 'x-console-role': 'operator' }
  const member = (tenantId: string, role = 'admin') => ({ 'x-console-token': token, 'x-console-actor': 'user_m1', 'x-console-role': role, 'x-console-tenant': tenantId })
  let tenantA = ''
  let tenantB = ''

  before(async () => {
    await app.ready()
  })

  it('lets operators use the admin routes through the console and refuses anyone else', async () => {
    const a = await app.inject({ method: 'POST', url: '/admin/tenants', headers: operator, payload: { name: 'Acme' } })
    assert.equal(a.statusCode, 201, a.body)
    tenantA = a.json().id
    const b = await app.inject({ method: 'POST', url: '/admin/tenants', headers: operator, payload: { name: 'Globex' } })
    assert.equal(b.statusCode, 201, b.body)
    tenantB = b.json().id

    assert.equal((await app.inject({ method: 'GET', url: '/admin/tenants', headers: { ...operator, 'x-console-role': 'owner' } })).statusCode, 403, 'organization roles are not operators')
    assert.equal((await app.inject({ method: 'GET', url: '/admin/tenants', headers: { ...operator, 'x-console-token': 'x'.repeat(40) } })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/admin/tenants', headers: { 'x-console-token': token, 'x-console-role': 'operator' } })).statusCode, 401, 'an actor is required')
    const detail = await app.inject({ method: 'GET', url: `/admin/tenants/${tenantA}`, headers: operator })
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.json().name, 'Acme')
  })

  it('resolves the tenant from the console headers on the customer routes', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections', headers: member(tenantA) })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections', headers: member('00000000-0000-4000-8000-000000000000') })).statusCode, 401, 'unknown tenant')
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections', headers: member('not-a-uuid') })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections', headers: { ...member(tenantA), 'x-console-role': 'root' } })).statusCode, 401)
    const offer = await app.inject({ method: 'POST', url: '/v1/credentials/offer', headers: member(tenantA), payload: { connectionId: 'conn-1', credentialDefinitionId: 'ABC:3:CL:12:default', attributes: { name: 'Ada', expiresAt: '9999999999' } } })
    assert.equal(offer.statusCode, 202, offer.body)
  })

  it('reserves API-key management to the console; a created key works and can be revoked', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: member(tenantA), payload: { label: 'backend' } })
    assert.equal(created.statusCode, 201, created.body)
    const apiKey = created.json().apiKey as string
    const apiKeyId = created.json().id as string
    assert.ok(apiKey.startsWith('12id_sk_'))
    const bearer = { authorization: `Bearer ${apiKey}` }
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections', headers: bearer })).statusCode, 200)
    assert.equal((await app.inject({ method: 'POST', url: '/v1/api-keys', headers: bearer, payload: { label: 'escalation' } })).statusCode, 403, 'an API key cannot mint API keys')
    assert.equal((await app.inject({ method: 'GET', url: '/v1/api-keys', headers: bearer })).statusCode, 403)

    const listed = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: member(tenantA) })
    assert.equal(listed.json().length, 1)
    assert.equal(listed.json()[0].prefix, apiKey.slice(0, 12))
    assert.equal(listed.json()[0].apiKey, undefined)

    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/api-keys', headers: member(tenantB) })).json(), [])
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/api-keys/${apiKeyId}`, headers: member(tenantB) })).statusCode, 404, 'another tenant cannot revoke it')
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/api-keys/${apiKeyId}`, headers: member(tenantA) })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections', headers: bearer })).statusCode, 401)
  })

  it('never stores a new API key for idempotency replays', async () => {
    const headers = { ...member(tenantA), 'idempotency-key': 'keys-1' }
    const first = await app.inject({ method: 'POST', url: '/v1/api-keys', headers, payload: { label: 'ci' } })
    const second = await app.inject({ method: 'POST', url: '/v1/api-keys', headers, payload: { label: 'ci' } })
    assert.equal(first.statusCode, 201)
    assert.equal(second.statusCode, 201)
    assert.notEqual(first.json().apiKey, second.json().apiKey)
    assert.equal(second.headers['idempotent-replayed'], undefined)
    const stored = await db!.db.select().from(idempotencyKeys)
    assert.ok(stored.every((row) => !row.responseBody.includes('12id_sk_')))
  })

  it('serves the cross-tenant overview and dead deliveries to operators', async () => {
    const [dead] = await db!.db.insert(webhookDeliveries).values({ tenantId: tenantB, eventType: 'proof.state_changed', body: '{"data":{}}', url: 'https://globex.test/hook', status: 'dead', attempts: 12 }).returning()
    const overview = await app.inject({ method: 'GET', url: '/admin/overview', headers: operator })
    assert.equal(overview.statusCode, 200, overview.body)
    const rows = overview.json() as Array<{ tenant: { id: string }; credentials: Record<string, number>; apiKeys: { active: number; revoked: number }; deadDeliveries: number; lastActivityAt: string | null }>
    const acme = rows.find((row) => row.tenant.id === tenantA)
    const globex = rows.find((row) => row.tenant.id === tenantB)
    assert.deepEqual(acme?.credentials, { 'offer-sent': 1 })
    assert.deepEqual(acme?.apiKeys, { active: 2, revoked: 1 })
    assert.ok(acme?.lastActivityAt)
    assert.equal(globex?.deadDeliveries, 1)
    assert.equal(globex?.lastActivityAt, null)

    const deliveries = await app.inject({ method: 'GET', url: '/admin/webhook-deliveries?status=dead', headers: operator })
    assert.equal(deliveries.statusCode, 200, deliveries.body)
    assert.deepEqual(deliveries.json().map((d: { id: number; tenantId: string }) => [d.id, d.tenantId]), [[dead.id, tenantB]])

    const body = await app.inject({ method: 'GET', url: `/v1/webhook/deliveries/${dead.id}`, headers: member(tenantB, 'member') })
    assert.equal(body.statusCode, 200, body.body)
  })

  it('audits console mutations, sensitive reads and the break-glass token, with the actor', async () => {
    const onboard = await app.inject({ method: 'POST', url: `/admin/tenants/${tenantB}/onboard`, headers: { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN } })
    assert.equal(onboard.statusCode, 200, onboard.body)

    // 2 tenant creations, 1 offer, 3 key creations, 2 revocations, 1 delivery body read, 1 onboard.
    const rows = await auditRows(10)
    assert.equal(rows.length, 10, JSON.stringify(rows.map((r) => `${r.method} ${r.route} ${r.statusCode}`)))
    assert.ok(rows.some((r) => r.method === 'POST' && r.route === '/admin/tenants' && r.actor === 'user_op1' && r.role === 'operator' && r.tenantId === null))
    assert.ok(rows.some((r) => r.method === 'DELETE' && r.route === '/v1/api-keys/:id' && r.statusCode === 404 && r.tenantId === tenantB && r.actor === 'user_m1'))
    assert.ok(rows.some((r) => r.method === 'GET' && r.route === '/v1/webhook/deliveries/:id' && r.role === 'member' && r.tenantId === tenantB))
    assert.ok(rows.some((r) => r.route === '/admin/tenants/:id/onboard' && r.actor === 'admin-token' && r.tenantId === tenantB))
    assert.equal(rows.filter((r) => r.method === 'GET').length, 1, 'plain reads are not audited')

    const listed = await app.inject({ method: 'GET', url: `/admin/audit?tenantId=${tenantB}`, headers: operator })
    assert.equal(listed.statusCode, 200, listed.body)
    assert.equal(listed.json().length, 3)
  })
})
