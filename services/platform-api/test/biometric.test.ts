/**
 * Biometric gate (Phase 6 B3) end to end inside platform-api, against a real Postgres (skipped
 * without one), with agent-service and biometric-service doubled. Covers policy resolution, gated
 * offers and proofs, the SDK routes, both event orders, lockout, expiry, proof withholding, the
 * biometric log, and that no image reaches webhooks, idempotency rows or the log.
 */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import type { OutboxRow } from '../src/agent-client.ts'
import { createGateEngine } from '../src/biometric/gate.ts'
import { WALLET_TOKEN_PREFIX, generateSecret, hashSecret } from '../src/auth/tokens.ts'
import { exchangeGates, tenants, wallets } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { createOutboxConsumer } from '../src/outbox-consumer.ts'
import { endpointLookup } from '../src/webhooks/events.ts'
import { fakeAgent, fakeBiometric, referenceImage, silentLogger, testConfig, testDatabase } from './helpers.ts'

const db = await testDatabase()

describe('biometric gate', { skip: db ? false : 'no test database' }, () => {
  let credN = 0
  let proofN = 0
  const agent = fakeAgent({
    offerCredential: async (tenantId, input) => {
      agent.calls.push({ method: 'offerCredential', args: [tenantId, input] })
      credN += 1
      return { credentialExchangeId: `cred-${credN}`, threadId: `thread-c${credN}`, state: 'offer-sent' }
    },
    requestProof: async (tenantId, input) => {
      agent.calls.push({ method: 'requestProof', args: [tenantId, input] })
      proofN += 1
      return { proofExchangeId: `proof-${proofN}`, threadId: `thread-p${proofN}`, state: 'request-sent' }
    },
    getProof: async (_tenantId, id) => ({ id, state: 'done', threadId: 't', connectionId: 'conn-1', isVerified: true, errorMessage: null, disclosed: { badge: { name: 'Ada' } } }),
  })
  const bio = fakeBiometric()
  const endpoints = endpointLookup(db!.db)
  const gates = createGateEngine({ db: db!.db, agent: agent.client, biometric: bio.client, endpoints, logger: silentLogger })
  const consumer = createOutboxConsumer({ db: db!.db, agent: agent.client, logger: silentLogger, endpoints, gates })
  const app = buildApp({
    config: testConfig,
    db: db!.db,
    agent: agent.client,
    mediator: { createInvitation: async () => ({ outOfBandId: 'oob-x', invitationUrl: 'https://mediator.test?oob=x' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async () => 'requested',
    biometric: { client: bio.client, gates },
  })

  const admin = { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN }
  let key = ''
  let tenantId = ''
  let consoleHeaders: Record<string, string> = {}
  let walletToken = ''
  let outboxId = 0
  const api = () => ({ authorization: `Bearer ${key}` })
  const wallet = () => ({ authorization: `Bearer ${walletToken}` })
  const outbox = (row: Partial<OutboxRow> & Pick<OutboxRow, 'recordType' | 'recordId' | 'state'>) =>
    agent.outbox.push({ id: ++outboxId, tenantId: 'agent-tenant-1', threadId: null, previousState: null, correlationId: null, payload: { connectionId: 'conn-1' }, createdAt: new Date().toISOString(), ...row })
  const callsTo = (method: string) => agent.calls.filter((c) => c.method === method)
  const offer = (extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/v1/credentials/offer', headers: api(), payload: { connectionId: 'conn-1', credentialDefinitionId: 'cd-2', attributes: { name: 'Ada', expiresAt: '9999999999' }, ...extra } })
  const logOf = async (kind: 'credentials' | 'proofs', id: string) => (await app.inject({ url: `/v1/${kind}/${id}/biometric-log`, headers: api() })).json()

  before(async () => {
    await app.ready()
    tenantId = (await app.inject({ method: 'POST', url: '/admin/tenants', headers: admin, payload: { name: 'Gate Co' } })).json().id
    key = (await app.inject({ method: 'POST', url: `/admin/tenants/${tenantId}/api-keys`, headers: admin, payload: { label: 'backend' } })).json().apiKey
    consoleHeaders = { 'x-console-token': testConfig.CONSOLE_TOKEN!, 'x-console-actor': 'owner@gate.test', 'x-console-role': 'owner', 'x-console-tenant': tenantId }
    walletToken = (await app.inject({ method: 'POST', url: '/v1/wallets', headers: api(), payload: {} })).json().walletToken
    const hook = await app.inject({ method: 'PUT', url: '/v1/webhook', headers: consoleHeaders, payload: { url: 'https://hooks.gate.test/12id' } })
    assert.equal(hook.statusCode < 300, true, hook.body)
  })

  it('settings are console-only and start switched off; nothing is gated', async () => {
    assert.equal((await app.inject({ url: '/v1/biometrics', headers: api() })).statusCode, 403)
    const settings = await app.inject({ url: '/v1/biometrics', headers: consoleHeaders })
    assert.equal(settings.statusCode, 200, settings.body)
    assert.equal(settings.json().enabled, false)
    assert.equal(settings.json().externalId, '12id-ext')

    const res = await offer()
    assert.equal(res.statusCode, 202, res.body)
    assert.equal(res.json().biometric, null)
    assert.equal((callsTo('offerCredential').at(-1)!.args[1] as { hold?: boolean }).hold, undefined)
  })

  it('switching on with required-by-default gates offers and needs a reference image', async () => {
    const on = await app.inject({ method: 'PUT', url: '/v1/biometrics/settings', headers: consoleHeaders, payload: { enabled: true, defaultPolicy: { required: true, minMatchScore: 92, minLivenessScore: 85, maxAttempts: 2, ttlMinutes: 30 } } })
    assert.equal(on.statusCode, 200, on.body)

    const missing = await offer()
    assert.deepEqual([missing.statusCode, missing.json().error], [422, 'biometric_reference_required'])

    const res = await offer({ biometric: { referenceImage } })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal(res.json().biometric.status, 'pending')
    assert.equal(res.json().biometric.attemptsRemaining, 2)
    assert.equal((callsTo('offerCredential').at(-1)!.args[1] as { hold?: boolean }).hold, true)
    const check = bio.calls.filter((c) => c.method === 'createCheck').at(-1)!.args[0] as { thresholds: unknown; purpose: string }
    assert.deepEqual([check.purpose, check.thresholds], ['issue', { minLivenessScore: 85, minMatchScore: 92 }])
  })

  it('a credential definition override can switch the gate off (set from the console only, K1)', async () => {
    const byKey = await app.inject({ method: 'PUT', url: '/v1/credential-definitions/cd-2/biometric-policy', headers: api(), payload: { mode: 'off' } })
    assert.equal(byKey.statusCode, 403, byKey.body)
    assert.equal((await app.inject({ url: '/v1/credential-definitions/cd-2/biometric-policy', headers: api() })).statusCode, 200, 'an API key still reads it')
    const put = await app.inject({ method: 'PUT', url: '/v1/credential-definitions/cd-2/biometric-policy', headers: consoleHeaders, payload: { mode: 'off' } })
    assert.equal(put.statusCode, 200, put.body)
    assert.equal((await offer()).json().biometric, null)
    await app.inject({ method: 'PUT', url: '/v1/credential-definitions/cd-2/biometric-policy', headers: consoleHeaders, payload: { mode: 'required', maxAttempts: 3 } })
    const gated = await offer({ biometric: { referenceImage } })
    assert.equal(gated.json().biometric.attemptsRemaining, 3)
  })

  it('pass before hold: issues when the request arrives, and logs every step', async () => {
    const created = (await offer({ biometric: { referenceImage } })).json()
    const thread = created.threadId

    const reqs = await app.inject({ url: `/v1/wallet/biometric-requirements?threadId=${thread}&threadId=unknown`, headers: wallet() })
    assert.equal(reqs.statusCode, 200, reqs.body)
    assert.deepEqual(reqs.json().requirements.map((r: { threadId: string; captureProvider: string }) => [r.threadId, r.captureProvider]), [[thread, 'mock']])

    const noModule = await app.inject({ method: 'POST', url: '/v1/wallet/biometric-sessions', headers: wallet(), payload: { threadId: thread, captureModules: [{ provider: 'aws-rekognition', version: 1 }] } })
    assert.deepEqual([noModule.statusCode, noModule.json().error], [409, 'capture_module_missing'])

    const started = await app.inject({ method: 'POST', url: '/v1/wallet/biometric-sessions', headers: wallet(), payload: { threadId: thread, captureModules: [{ provider: 'mock', version: 1 }] } })
    assert.equal(started.statusCode, 201, started.body)
    const done = await app.inject({ method: 'POST', url: `/v1/wallet/biometric-sessions/${started.json().sessionId}/complete`, headers: wallet(), payload: { clientOutput: { pass: true } } })
    assert.deepEqual(done.json(), { outcome: 'passed', attemptsRemaining: 0 })
    assert.equal(callsTo('issueCredential').length, 0, 'nothing to issue before the request arrives')

    outbox({ recordType: 'credential', recordId: created.id, threadId: thread, state: 'request-received' })
    await consumer.runOnce()
    assert.deepEqual(callsTo('issueCredential').at(-1)!.args, ['agent-tenant-1', created.id])

    const log = await logOf('credentials', created.id)
    assert.deepEqual(log.events.map((e: { type: string }) => e.type), ['gate_created', 'session_started', 'attempt_completed', 'hold_reached', 'issued'])
    const attempt = log.events[2]
    assert.deepEqual([attempt.matchScore, attempt.decision, attempt.thresholds.minMatchScore], [99, 'passed', 92])
    assert.match(log.events[1].vendorSessionId, /^vendor-/)
    assert.equal(log.biometric.status, 'passed')
  })

  it('hold before pass: waits at request-received, issues on the pass', async () => {
    const created = (await offer({ biometric: { referenceImage } })).json()
    outbox({ recordType: 'credential', recordId: created.id, threadId: created.threadId, state: 'request-received' })
    await consumer.runOnce()
    const issuedBefore = callsTo('issueCredential').length

    const started = (await app.inject({ method: 'POST', url: '/v1/wallet/biometric-sessions', headers: wallet(), payload: { threadId: created.threadId, captureModules: [{ provider: 'mock', version: 1 }] } })).json()
    await app.inject({ method: 'POST', url: `/v1/wallet/biometric-sessions/${started.sessionId}/complete`, headers: wallet(), payload: { clientOutput: { pass: true } } })
    assert.equal(callsTo('issueCredential').length, issuedBefore + 1)
    assert.deepEqual((await logOf('credentials', created.id)).events.map((e: { type: string }) => e.type), ['gate_created', 'hold_reached', 'session_started', 'attempt_completed', 'issued'])
  })

  it('locks after the last failed attempt and abandons the exchange', async () => {
    const created = (await offer({ biometric: { referenceImage } })).json()
    const outcomes = []
    for (let i = 0; i < 3; i++) {
      const s = (await app.inject({ method: 'POST', url: '/v1/wallet/biometric-sessions', headers: wallet(), payload: { threadId: created.threadId, captureModules: [{ provider: 'mock', version: 1 }] } })).json()
      outcomes.push((await app.inject({ method: 'POST', url: `/v1/wallet/biometric-sessions/${s.sessionId}/complete`, headers: wallet(), payload: { clientOutput: { pass: false } } })).json().outcome)
    }
    assert.deepEqual(outcomes, ['failed', 'failed', 'locked'])
    assert.deepEqual(callsTo('abandonCredential').at(-1)!.args, ['agent-tenant-1', created.id, 'biometric check failed'])
    const again = await app.inject({ method: 'POST', url: '/v1/wallet/biometric-sessions', headers: wallet(), payload: { threadId: created.threadId, captureModules: [{ provider: 'mock', version: 1 }] } })
    assert.deepEqual([again.statusCode, again.json().error], [409, 'check_failed'])
    const types = (await logOf('credentials', created.id)).events.map((e: { type: string }) => e.type)
    assert.equal(types.at(-1), 'declined')
    assert.equal(types.filter((t: string) => t === 'attempt_completed').length, 3)
  })

  it('expires overdue gates and abandons their exchanges', async () => {
    const created = (await offer({ biometric: { referenceImage } })).json()
    await db!.db.update(exchangeGates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(exchangeGates.recordId, created.id))
    assert.equal(await gates.expireDue(), 1)
    assert.deepEqual(callsTo('abandonCredential').at(-1)!.args, ['agent-tenant-1', created.id, 'biometric check expired'])
    assert.equal((await app.inject({ url: `/v1/credentials/${created.id}`, headers: api() })).json().biometric.status, 'expired')
  })

  it('a holder decline cancels the gate and the check', async () => {
    const created = (await offer({ biometric: { referenceImage } })).json()
    outbox({ recordType: 'credential', recordId: created.id, threadId: created.threadId, state: 'abandoned' })
    await consumer.runOnce()
    assert.equal((await logOf('credentials', created.id)).biometric.status, 'cancelled')
    assert.equal(bio.calls.some((c) => c.method === 'cancelCheck'), true)
  })

  it('refuses a wallet of another tenant', async () => {
    // The agent double hands every tenant the same agent id, so the second tenant is inserted directly.
    const [other] = await db!.db.insert(tenants).values({ name: 'Other Co', agentTenantId: 'agent-tenant-2', status: 'ready' }).returning()
    const otherWallet = generateSecret(WALLET_TOKEN_PREFIX)
    await db!.db.insert(wallets).values({ tenantId: other!.id, tokenHash: hashSecret(otherWallet) })
    const created = (await offer({ biometric: { referenceImage } })).json()
    const reqs = await app.inject({ url: `/v1/wallet/biometric-requirements?threadId=${created.threadId}`, headers: { authorization: `Bearer ${otherWallet}` } })
    assert.deepEqual(reqs.json().requirements, [])
    const start = await app.inject({ method: 'POST', url: '/v1/wallet/biometric-sessions', headers: { authorization: `Bearer ${otherWallet}` }, payload: { threadId: created.threadId, captureModules: [{ provider: 'mock', version: 1 }] } })
    assert.equal(start.statusCode, 404)
  })

  it('gated proofs withhold verified and disclosed until the pass', async () => {
    const template = await app.inject({
      method: 'POST',
      url: '/v1/proof-templates',
      headers: consoleHeaders,
      payload: { name: 'badge check', groups: [{ key: 'badge', attributes: ['name'], credentials: [{ schemaName: 'employee-badge' }] }], biometricPolicy: { mode: 'required', minMatchScore: 95 } },
    })
    assert.equal(template.statusCode, 201, template.body)
    assert.deepEqual(template.json().biometricPolicy, { mode: 'required', minMatchScore: 95 })
    assert.equal(template.json().definition.biometricPolicy, undefined, 'the policy is stored outside the definition')

    // Editing the template without the field (the console builder) keeps the policy; the policy route changes it.
    const edited = await app.inject({ method: 'PUT', url: `/v1/proof-templates/${template.json().id}`, headers: consoleHeaders, payload: { name: 'badge check v2', groups: template.json().definition.groups } })
    assert.deepEqual(edited.json().biometricPolicy, { mode: 'required', minMatchScore: 95 })
    const viaRoute = await app.inject({ method: 'PUT', url: `/v1/proof-templates/${template.json().id}/biometric-policy`, headers: consoleHeaders, payload: { mode: 'required', minMatchScore: 95 } })
    assert.equal(viaRoute.statusCode, 200, viaRoute.body)
    assert.deepEqual((await app.inject({ url: `/v1/proof-templates/${template.json().id}/biometric-policy`, headers: api() })).json().biometricPolicy, { mode: 'required', minMatchScore: 95 })

    const created = (await app.inject({ method: 'POST', url: '/v1/proofs/request', headers: api(), payload: { connectionId: 'conn-1', templateId: template.json().id, biometric: { referenceImage } } })).json()
    assert.equal(created.biometric.status, 'pending')
    assert.equal((callsTo('requestProof').at(-1)!.args[1] as { hold?: boolean }).hold, true)

    // The presentation arrives (verified) before the holder passed: nothing may be released.
    outbox({ recordType: 'proof', recordId: created.id, threadId: created.threadId, state: 'presentation-received', payload: { connectionId: 'conn-1', isVerified: true } })
    await consumer.runOnce()
    const held = (await app.inject({ url: `/v1/proofs/${created.id}`, headers: api() })).json()
    assert.deepEqual([held.state, held.verified, held.disclosed], ['presentation-received', null, null])
    assert.equal(callsTo('acceptPresentation').length, 0)

    const s = (await app.inject({ method: 'POST', url: '/v1/wallet/biometric-sessions', headers: wallet(), payload: { threadId: created.threadId, captureModules: [{ provider: 'mock', version: 1 }] } })).json()
    await app.inject({ method: 'POST', url: `/v1/wallet/biometric-sessions/${s.sessionId}/complete`, headers: wallet(), payload: { clientOutput: { pass: true } } })
    assert.deepEqual(callsTo('acceptPresentation').at(-1)!.args, ['agent-tenant-1', created.id])

    outbox({ recordType: 'proof', recordId: created.id, threadId: created.threadId, state: 'done', payload: { connectionId: 'conn-1', isVerified: true } })
    await consumer.runOnce()
    const released = (await app.inject({ url: `/v1/proofs/${created.id}`, headers: api() })).json()
    assert.deepEqual([released.verified, released.disclosed], [true, { badge: { name: 'Ada' } }])
    assert.equal((await logOf('proofs', created.id)).events.at(-1).type, 'accepted')
  })

  it('adoption counts the capture add-ons wallets reported', async () => {
    const res = await app.inject({ url: '/v1/biometrics/adoption', headers: consoleHeaders })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json().modules, [{ module: 'mock@1', wallets: 1 }])
  })

  it('never stores the reference image outside biometric-service', async () => {
    const probe = referenceImage.slice(0, 40)
    for (const table of ['webhook_deliveries', 'idempotency_keys', 'exchange_gate_events', 'exchange_gates', 'credentials', 'proofs']) {
      const rows = await db!.db.execute(sql.raw(`select count(*)::int as n from ${table} t where t::text like '%${probe.replace(/[%_]/g, '')}%'`))
      assert.equal((rows.rows[0] as { n: number }).n, 0, `image found in ${table}`)
    }
    const deliveries = await db!.db.execute(sql.raw(`select count(*)::int as n from webhook_deliveries where event_type = 'biometric.check_completed'`))
    assert.ok((deliveries.rows[0] as { n: number }).n > 0, 'biometric webhooks were enqueued')
  })
})
