/**
 * Data protection (Phase 7 H1) against a real Postgres (skipped without one): erasure on request by
 * API key and console, scrubbing everywhere the platform holds the data while the rows stay, operator
 * masking with an audited reveal, the retention job, the retention setting, the retry guard (L5) and
 * operator-created API keys.
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it } from 'node:test'

import { and, eq } from 'drizzle-orm'

import { API_KEY_PREFIX, generateSecret, hashSecret, lookupPrefix } from '../src/auth/tokens.ts'
import { createGateEngine } from '../src/biometric/gate.ts'
import type { ConditionOutcome } from '../src/biometric/policy.ts'
import { apiKeys, connections, consoleAudit, credentials, erasures, exchangeGateEvents, exchangeGates, proofs, tenants, webhookDeliveries, webhookEndpoints } from '../src/db/schema.ts'
import { applyRow, tenantResolver } from '../src/outbox-consumer.ts'
import { buildApp } from '../src/http/app.ts'
import { MASK } from '../src/http/personal-data.ts'
import { retentionOnce } from '../src/retention.ts'
import { endpointLookup, enqueueEvent } from '../src/webhooks/events.ts'
import { fakeAgent, fakeBiometric, silentLogger, testConfig, testDatabase } from './helpers.ts'

const database = await testDatabase()
const DAY = 86_400_000

describe('data protection', { skip: database ? false : 'no test database' }, () => {
  const db = database!.db
  const agent = fakeAgent()
  const biometric = fakeBiometric()
  const endpoints = endpointLookup(db)
  const gates = createGateEngine({ db, agent: agent.client, biometric: biometric.client, endpoints, logger: silentLogger })
  const app = buildApp({
    config: testConfig,
    db,
    agent: agent.client,
    mediator: { createInvitation: async () => ({ outOfBandId: 'oob-x', invitationUrl: 'https://mediator.test?oob=x' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async () => 'requested',
    biometric: { client: biometric.client, gates },
  })
  const token = testConfig.CONSOLE_TOKEN as string
  let tenantId = ''
  let bearer = ''
  const consoleAs = (role: string, actor = `user_${role}`) => ({ 'x-console-token': token, 'x-console-actor': actor, 'x-console-role': role, 'x-console-tenant': tenantId })
  const apiKey = () => ({ authorization: `Bearer ${bearer}` })

  const expiresOn = '20991231'
  // The end of the expiry day (UTC): when the credential stops being accepted.
  const validUntil = Date.UTC(2100, 0, 1)
  async function seedCredential(recordId: string, state = 'done', extra: Partial<typeof credentials.$inferInsert> = {}) {
    const attributes = { name: 'Ada Lovelace', expiresOn }
    await db.insert(credentials).values({ tenantId, recordId, connectionId: 'conn-1', state, attributes, expiresAt: new Date(validUntil), credentialDefinitionId: 'ABC:3:CL:12:default', ...extra })
    await enqueueEvent(db, endpoints, tenantId, 'credential.state_changed', { id: recordId, state, attributes })
  }
  /** What a conditional face-check rule decided for a proof, with the numbers the customer sent. */
  const condition: ConditionOutcome = {
    match: 'any',
    required: true,
    conditions: [
      { param: 'amount', op: 'gte', value: 5000, input: 7200, met: true },
      { param: 'riskScore', op: 'gt', value: 70, input: 20, met: false },
    ],
  }

  before(async () => {
    await app.ready()
  })

  beforeEach(async () => {
    await testDatabase()
    agent.calls.length = 0
    biometric.calls.length = 0
    const [tenant] = await db.insert(tenants).values({ name: 'Acme', agentTenantId: 'agent-acme', status: 'ready' }).returning()
    tenantId = tenant!.id
    bearer = generateSecret(API_KEY_PREFIX)
    await db.insert(apiKeys).values({ tenantId, prefix: lookupPrefix(bearer), keyHash: hashSecret(bearer), label: 'backend' })
    await db.insert(webhookEndpoints).values({ tenantId, url: 'https://hooks.test/12id', secret: 's'.repeat(40) })
    await db.insert(connections).values({ tenantId, recordId: 'conn-1', state: 'completed', theirLabel: 'Ada phone', externalId: 'user-42' })
  })

  it('an API key erases a finished credential: personal data goes everywhere, the row and expiry stay', async () => {
    await seedCredential('cred-1')
    const [gate] = await db
      .insert(exchangeGates)
      .values({ tenantId, recordType: 'credential', recordId: 'cred-1', threadId: 't1', checkId: '00000000-0000-4000-8000-00000000abcd', providerId: 'mock', status: 'passed', maxAttempts: 3, thresholds: { minLivenessScore: 90, minMatchScore: 90 }, livenessScore: 97, matchScore: 99, expiresAt: new Date() })
      .returning()
    await db.insert(exchangeGateEvents).values({ gateId: gate!.id, tenantId, type: 'attempt_completed', livenessScore: 97, matchScore: 99, vendorSessionId: 'vendor-1' })

    const response = await app.inject({ method: 'POST', url: '/v1/credentials/cred-1/erase', headers: apiKey(), payload: {} })
    assert.equal(response.statusCode, 200, response.body)
    const view = response.json()
    assert.equal(view.attributes, null)
    assert.ok(view.erasedAt)
    assert.equal(view.state, 'done')
    assert.equal(view.biometric.livenessScore, null)
    assert.equal(view.biometric.status, 'passed', 'the decision stays')

    const [row] = await db.select().from(credentials).where(eq(credentials.recordId, 'cred-1'))
    assert.equal(row!.attributes, null)
    assert.equal(row!.expiresAt?.getTime(), validUntil, 'the validity date stays for the dashboard')
    assert.match(row!.erasedBy!, /^api_key:/)
    assert.ok(agent.calls.some((c) => c.method === 'eraseCredential' && c.args[1] === 'cred-1'))
    assert.ok(biometric.calls.some((c) => c.method === 'eraseCheck'))
    const [event] = await db.select().from(exchangeGateEvents).where(eq(exchangeGateEvents.gateId, gate!.id))
    assert.deepEqual([event!.livenessScore, event!.matchScore, event!.vendorSessionId, event!.type], [null, null, null, 'attempt_completed'])

    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId)).orderBy(webhookDeliveries.id)
    const original = deliveries.find((d) => d.eventType === 'credential.state_changed')!
    assert.ok(original.erasedAt)
    assert.equal(original.status, 'dead', 'a pending delivery with personal data is never sent')
    assert.ok(!original.body.includes('Ada'), 'the body no longer holds the value')
    assert.equal(JSON.parse(original.body).data.attributes, null)
    const erased = deliveries.find((d) => d.eventType === 'record.erased')!
    assert.deepEqual({ ...JSON.parse(erased.body).data, erasedAt: undefined }, { recordType: 'credential', recordId: 'cred-1', erasedAt: undefined, initiator: 'api_key' })

    const log = await db.select().from(erasures)
    assert.deepEqual(log.map((e) => [e.recordType, e.recordId, e.via]), [['credential', 'cred-1', 'api_key']])

    const again = await app.inject({ method: 'POST', url: '/v1/credentials/cred-1/erase', headers: apiKey(), payload: {} })
    assert.equal(again.statusCode, 200, 'a repeat is harmless')
    assert.equal((await db.select().from(erasures)).length, 1)
  })

  it('refuses a running exchange (409) and an unknown one (404); erases proofs', async () => {
    await seedCredential('cred-run', 'offer-sent')
    const running = await app.inject({ method: 'POST', url: '/v1/credentials/cred-run/erase', headers: apiKey(), payload: {} })
    assert.equal(running.statusCode, 409)
    assert.equal(running.json().error, 'exchange_in_progress')
    assert.equal((await app.inject({ method: 'POST', url: '/v1/credentials/nope/erase', headers: apiKey(), payload: {} })).statusCode, 404)

    await db.insert(proofs).values({ tenantId, recordId: 'proof-1', connectionId: 'conn-1', state: 'done', verified: true, disclosed: { g: { name: 'Ada' } }, biometricCondition: condition })
    await db.insert(proofs).values({ tenantId, recordId: 'proof-2', connectionId: 'conn-1', state: 'done', verified: true, disclosed: { g: { name: 'Ada' } } })
    const proof = await app.inject({ method: 'POST', url: '/v1/proofs/proof-1/erase', headers: apiKey() })
    assert.equal(proof.statusCode, 200, proof.body)
    assert.equal(proof.json().disclosed, null)
    assert.equal(proof.json().verified, true, 'the verification result stays')

    // The numbers sent for a conditional face-check rule go; the rule and the decision stay, in order.
    const [erased] = await db.select().from(proofs).where(eq(proofs.recordId, 'proof-1'))
    assert.deepEqual(erased!.biometricCondition, { ...condition, conditions: condition.conditions.map((c) => ({ ...c, input: null })) })
    assert.deepEqual((await app.inject({ url: '/v1/proofs/proof-1/biometric-log', headers: apiKey() })).json().condition.conditions.map((c: { param: string; input: number | null }) => [c.param, c.input]), [['amount', null], ['riskScore', null]])
    assert.equal((await app.inject({ method: 'POST', url: '/v1/proofs/proof-2/erase', headers: apiKey() })).statusCode, 200)
    const [plain] = await db.select().from(proofs).where(eq(proofs.recordId, 'proof-2'))
    assert.equal(plain!.biometricCondition, null, 'a proof without a rule stays without one')
  })

  it('erasing a connection erases every exchange on it, and waits for running ones', async () => {
    await seedCredential('cred-a')
    await seedCredential('cred-b', 'request-received')
    const blocked = await app.inject({ method: 'POST', url: '/v1/connections/conn-1/erase', headers: apiKey(), payload: {} })
    assert.equal(blocked.statusCode, 409)
    await db.update(credentials).set({ state: 'abandoned' }).where(eq(credentials.recordId, 'cred-b'))

    const response = await app.inject({ method: 'POST', url: '/v1/connections/conn-1/erase', headers: apiKey(), payload: {} })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().theirLabel, null)
    assert.equal(response.json().externalId, 'user-42', 'the customer reference stays')
    assert.deepEqual(response.json().erasedExchanges.credentials.sort(), ['cred-a', 'cred-b'])
    assert.ok(agent.calls.some((c) => c.method === 'eraseConnection'))
    const rows = await db.select().from(credentials).where(eq(credentials.tenantId, tenantId))
    assert.ok(rows.every((r) => r.erasedAt && r.attributes === null))
    assert.equal((await db.select().from(erasures)).length, 3)
  })

  it('console: members cannot erase, operators must give a reason, and the reason is audited', async () => {
    await seedCredential('cred-c')
    assert.equal((await app.inject({ method: 'POST', url: '/v1/credentials/cred-c/erase', headers: consoleAs('member'), payload: {} })).statusCode, 403)
    const noReason = await app.inject({ method: 'POST', url: '/v1/credentials/cred-c/erase', headers: consoleAs('operator'), payload: {} })
    assert.equal(noReason.statusCode, 400)
    assert.equal(noReason.json().error, 'reason_required')
    const ok = await app.inject({ method: 'POST', url: '/v1/credentials/cred-c/erase', headers: consoleAs('operator'), payload: { reason: 'ticket 812: tenant asked by mail' } })
    assert.equal(ok.statusCode, 200, ok.body)

    const [logged] = await db.select().from(erasures)
    assert.deepEqual([logged!.via, logged!.role, logged!.reason], ['console', 'operator', 'ticket 812: tenant asked by mail'])
    const audit = await waitForAudit((row) => row.route === '/v1/credentials/:id/erase' && row.statusCode === 200)
    assert.equal(audit?.reason, 'erase: ticket 812: tenant asked by mail')
    const event = (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventType, 'record.erased')))[0]!
    assert.equal(JSON.parse(event.body).data.initiator, 'operator')

    await seedCredential('cred-d')
    assert.equal((await app.inject({ method: 'POST', url: '/v1/credentials/cred-d/erase', headers: consoleAs('owner'), payload: {} })).statusCode, 200, 'owners need no reason')
  })

  it('operators see personal data masked unless they reveal it with a reason; the tenant sees it', async () => {
    await seedCredential('cred-m')
    const operatorView = await app.inject({ method: 'GET', url: '/v1/credentials/cred-m', headers: consoleAs('operator') })
    assert.deepEqual(operatorView.json().attributes, { name: MASK, expiresOn: MASK })
    const connection = await app.inject({ method: 'GET', url: '/v1/connections/conn-1', headers: consoleAs('operator') })
    assert.equal(connection.json().theirLabel, MASK)
    const list = await app.inject({ method: 'GET', url: '/v1/credentials', headers: consoleAs('operator') })
    assert.equal(list.json().items[0].attributes.name, MASK)

    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId))
    const body = await app.inject({ method: 'GET', url: `/v1/webhook/deliveries/${delivery!.id}`, headers: consoleAs('operator') })
    assert.ok(!body.json().body.includes('Ada'), 'the delivery body is masked too')

    const revealed = await app.inject({ method: 'GET', url: '/v1/credentials/cred-m', headers: { ...consoleAs('operator'), 'x-console-reveal-reason': 'support ticket 77' } })
    assert.equal(revealed.json().attributes.name, 'Ada Lovelace')
    const audit = await waitForAudit((row) => row.method === 'GET' && row.reason === 'reveal: support ticket 77')
    assert.ok(audit, 'the reveal is audited with its reason')

    assert.equal((await app.inject({ method: 'GET', url: '/v1/credentials/cred-m', headers: consoleAs('owner') })).json().attributes.name, 'Ada Lovelace')
    assert.equal((await app.inject({ method: 'GET', url: '/v1/credentials/cred-m', headers: apiKey() })).json().attributes.name, 'Ada Lovelace')

    // The numbers sent for a conditional face-check rule are masked the same way; the rule is not.
    await db.insert(proofs).values({ tenantId, recordId: 'proof-m', connectionId: 'conn-1', state: 'done', verified: true, biometricCondition: condition })
    const inputs = async (headers: Record<string, string>) => (await app.inject({ url: '/v1/proofs/proof-m/biometric-log', headers })).json().condition.conditions.map((c: { input: number | null; value: number }) => [c.value, c.input])
    assert.deepEqual(await inputs(consoleAs('operator')), [[5000, null], [70, null]])
    assert.deepEqual(await inputs({ ...consoleAs('operator'), 'x-console-reveal-reason': 'support ticket 78' }), [[5000, 7200], [70, 20]])
    assert.deepEqual(await inputs(consoleAs('owner')), [[5000, 7200], [70, 20]])

    // An auditor opens every tenant too: the same masks, and no reveal (implement/22 C14).
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/credentials/cred-m', headers: consoleAs('auditor') })).json().attributes, { name: MASK, expiresOn: MASK })
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections/conn-1', headers: consoleAs('auditor') })).json().theirLabel, MASK)
    assert.deepEqual(await inputs(consoleAs('auditor')), [[5000, null], [70, null]])
    const refusedReveal = await app.inject({ method: 'GET', url: '/v1/credentials/cred-m', headers: { ...consoleAs('auditor'), 'x-console-reveal-reason': 'curious' } })
    assert.equal(refusedReveal.statusCode, 403, refusedReveal.body)
    assert.equal(refusedReveal.json().reason, 'auditors cannot reveal personal data')
  })

  it('retention scrubs finished exchanges past the period and old delivery bodies; 0 keeps them', async () => {
    const old = new Date(Date.now() - 100 * DAY)
    await seedCredential('cred-old', 'done', { updatedAt: old })
    await seedCredential('cred-new', 'done')
    await seedCredential('cred-running', 'offer-sent', { updatedAt: old })
    await db.insert(proofs).values({ tenantId, recordId: 'proof-old', connectionId: 'conn-1', state: 'done', verified: true, biometricCondition: condition, updatedAt: old })
    await db.insert(proofs).values({ tenantId, recordId: 'proof-new', connectionId: 'conn-1', state: 'done', verified: true, biometricCondition: condition })
    await db.update(webhookDeliveries).set({ status: 'delivered', createdAt: old }).where(eq(webhookDeliveries.tenantId, tenantId))
    await enqueueEvent(db, endpoints, tenantId, 'wallet.sync_requested', { walletId: 'w1', externalId: 'user-42' })

    const report = await retentionOnce({ db, agent: agent.client, biometric: biometric.client, endpoints, logger: silentLogger, defaultDays: 90 })
    assert.equal(report.credentials, 1)
    const rows = Object.fromEntries((await db.select().from(credentials).where(eq(credentials.tenantId, tenantId))).map((r) => [r.recordId, r]))
    assert.equal(rows['cred-old']!.attributes, null)
    assert.equal(rows['cred-old']!.erasedBy, 'retention')
    assert.equal(rows['cred-new']!.attributes?.name, 'Ada Lovelace', 'inside the period')
    assert.equal(rows['cred-running']!.attributes?.name, 'Ada Lovelace', 'running exchanges are never scrubbed')
    const sent = Object.fromEntries((await db.select().from(proofs).where(eq(proofs.tenantId, tenantId))).map((r) => [r.recordId, r.biometricCondition!.conditions.map((c) => c.input)]))
    assert.deepEqual(sent, { 'proof-old': [null, null], 'proof-new': [7200, 20] }, 'the numbers sent for a conditional rule go with the exchange')
    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId))
    assert.ok(deliveries.filter((d) => d.status === 'delivered').every((d) => d.erasedAt && !d.body.includes('Ada')))
    assert.equal((await db.select().from(erasures)).length, 0, 'retention is not an erasure request')
    assert.equal(deliveries.filter((d) => d.eventType === 'record.erased').length, 0, 'and sends no webhook')

    await seedCredential('cred-keep', 'done', { updatedAt: old })
    await db.update(tenants).set({ retentionDays: 0 }).where(eq(tenants.id, tenantId))
    await retentionOnce({ db, agent: agent.client, biometric: biometric.client, endpoints, logger: silentLogger, defaultDays: 90 })
    const [kept] = await db.select().from(credentials).where(and(eq(credentials.tenantId, tenantId), eq(credentials.recordId, 'cred-keep')))
    assert.equal(kept!.attributes?.name, 'Ada Lovelace', 'a tenant setting of 0 keeps the data')
  })

  it('the retention period is read by anyone of the tenant and set from the console by owners, admins and operators', async () => {
    const read = await app.inject({ method: 'GET', url: '/v1/data-retention', headers: apiKey() })
    assert.deepEqual(read.json(), { retentionDays: 90, tenantSetting: null, platformDefault: 90 })
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/data-retention', headers: apiKey(), payload: { retentionDays: 30 } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/data-retention', headers: consoleAs('member'), payload: { retentionDays: 30 } })).statusCode, 403)
    const set = await app.inject({ method: 'PUT', url: '/v1/data-retention', headers: consoleAs('admin'), payload: { retentionDays: 30 } })
    assert.deepEqual(set.json(), { retentionDays: 30, tenantSetting: 30, platformDefault: 90 })
    const reset = await app.inject({ method: 'PUT', url: '/v1/data-retention', headers: consoleAs('operator'), payload: { retentionDays: null } })
    assert.equal(reset.json().retentionDays, 90)
  })

  it('retries only dead or pending deliveries, never an erased one (review L5)', async () => {
    await seedCredential('cred-r')
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.tenantId, tenantId))
    await db.update(webhookDeliveries).set({ status: 'delivered' }).where(eq(webhookDeliveries.id, delivery!.id))
    const delivered = await app.inject({ method: 'POST', url: `/v1/webhook/deliveries/${delivery!.id}/retry`, headers: consoleAs('admin') })
    assert.equal(delivered.statusCode, 409)
    assert.equal(delivered.json().error, 'delivery_not_retryable')

    await db.update(webhookDeliveries).set({ status: 'dead' }).where(eq(webhookDeliveries.id, delivery!.id))
    await app.inject({ method: 'POST', url: '/v1/credentials/cred-r/erase', headers: apiKey(), payload: {} })
    const erased = await app.inject({ method: 'POST', url: `/v1/webhook/deliveries/${delivery!.id}/retry`, headers: consoleAs('admin') })
    assert.equal(erased.json().error, 'delivery_erased')
  })

  it('flags API keys created by an operator', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/api-keys', headers: consoleAs('operator', 'user_op9'), payload: { label: 'support' } })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.json().createdByRole, 'operator')
    const list = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: consoleAs('owner') })
    const byLabel = Object.fromEntries(list.json().items.map((k: { label: string; createdByRole: string | null }) => [k.label, k.createdByRole]))
    assert.deepEqual(byLabel, { support: 'operator', backend: null })
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.label, 'support'))
    assert.equal(row!.createdBy, 'user_op9')
  })

  it('the outbox consumer never refills an erased exchange', async () => {
    await seedCredential('cred-z')
    await app.inject({ method: 'POST', url: '/v1/credentials/cred-z/erase', headers: apiKey(), payload: {} })
    agent.calls.length = 0
    await applyRow({ db, agent: agent.client, logger: silentLogger, endpoints }, tenantResolver(db), { id: 999_999, tenantId: 'agent-acme', recordType: 'credential', recordId: 'cred-z', threadId: null, state: 'abandoned', previousState: 'done', correlationId: null, payload: {}, createdAt: new Date().toISOString() })
    assert.ok(!agent.calls.some((c) => c.method === 'getCredential'))
    const [row] = await db.select().from(credentials).where(eq(credentials.recordId, 'cred-z'))
    assert.equal(row!.attributes, null)
  })

  async function waitForAudit(match: (row: typeof consoleAudit.$inferSelect) => boolean) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const found = (await db.select().from(consoleAudit)).find(match)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return undefined
  }
})
