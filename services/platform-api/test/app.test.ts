/**
 * HTTP surface against a real Postgres (skipped without one) with agent-service and the mediator
 * doubled. Covers: admin bootstrap, API-key and wallet-token auth, idempotency, the customer
 * command → mirror-row path, setup routes being console only (review K1), the wake receiver's
 * secret, and the generic 500 body.
 */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import type { WakeOutcome } from '../src/wake.ts'
import { idempotencyKeys, webhookEndpoints } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

const db = await testDatabase()

describe('platform-api HTTP', { skip: db ? false : 'no test database' }, () => {
  const agent = fakeAgent()
  let mintedInvitations = 0
  const wakes: string[] = []
  const app = buildApp({
    config: testConfig,
    db: db!.db,
    agent: agent.client,
    mediator: {
      createInvitation: async () => {
        mintedInvitations += 1
        return { outOfBandId: `oob-w${mintedInvitations}`, invitationUrl: `https://mediator.test?oob=w${mintedInvitations}` }
      },
    },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async (connectionId: string): Promise<WakeOutcome> => {
      wakes.push(connectionId)
      return 'requested'
    },
  })
  const admin = { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN }
  let apiKey = ''
  let tenantId = ''
  // The console acting for the tenant (Phase 4 C1): setup routes accept only this principal.
  const consoleHeaders = () => ({ 'x-console-token': testConfig.CONSOLE_TOKEN!, 'x-console-actor': 'user-1', 'x-console-role': 'owner', 'x-console-tenant': tenantId })

  before(async () => {
    await app.ready()
  })

  it('serves public routes without credentials', async () => {
    const ledger = await app.inject({ method: 'GET', url: '/v1/ledger' })
    assert.equal(ledger.statusCode, 200)
    assert.equal(ledger.json().genesis.sha256, '0'.repeat(64))
    assert.equal((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode, 200)
  })

  it('refuses admin routes without the admin token', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/admin/tenants' })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/admin/tenants', headers: { 'x-admin-token': 'wrong' } })).statusCode, 401)
  })

  it('bootstraps a tenant through agent-service and issues an API key once', async () => {
    const created = await app.inject({ method: 'POST', url: '/admin/tenants', headers: admin, payload: { name: 'Acme' } })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.json().status, 'ready')
    assert.equal(created.json().did, 'did:indy:twelveid:staging:Abc')
    tenantId = created.json().id
    assert.deepEqual(agent.calls.map((c) => c.method), ['createTenant', 'onboardTenant'])

    const key = await app.inject({ method: 'POST', url: `/admin/tenants/${tenantId}/api-keys`, headers: admin, payload: { label: 'backend' } })
    assert.equal(key.statusCode, 201)
    apiKey = key.json().apiKey
    assert.ok(apiKey.startsWith('12id_sk_'))
    const listed = await app.inject({ method: 'GET', url: `/admin/tenants/${tenantId}/api-keys`, headers: admin })
    assert.equal(listed.json()[0].prefix, apiKey.slice(0, 12))
    assert.equal(listed.json()[0].apiKey, undefined)
  })

  it('authenticates customers by API key', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections' })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections', headers: { authorization: `Bearer ${apiKey}x` } })).statusCode, 401)
    const ok = await app.inject({ method: 'GET', url: '/v1/connections', headers: { authorization: `Bearer ${apiKey}` } })
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(ok.json(), { items: [], total: 0, page: 1, pageSize: 25 })
  })

  it('lists the catalogue with both identifier forms', async () => {
    const schemas = await app.inject({ method: 'GET', url: '/v1/schemas', headers: { authorization: `Bearer ${apiKey}` } })
    assert.equal(schemas.json().total, 2)
    assert.equal(schemas.json().items[0].schemaId, 'ABC:2:employee-badge:1.0')
    const defs = await app.inject({ method: 'GET', url: '/v1/credential-definitions', headers: { authorization: `Bearer ${apiKey}` } })
    assert.equal(defs.json().items[1].credentialDefinitionId, 'ABC:3:CL:12:default')
    assert.equal(defs.json().items[1].qualifiedId, 'q2')
  })

  it('offers a credential: mirror row is readable immediately, ledger id or catalogue id accepted', async () => {
    const headers = { authorization: `Bearer ${apiKey}` }
    const offer = await app.inject({ method: 'POST', url: '/v1/credentials/offer', headers, payload: { connectionId: 'conn-1', credentialDefinitionId: 'ABC:3:CL:12:default', attributes: { name: 'Ada', expiresAt: '9999999999' }, externalId: 'emp-42' } })
    assert.equal(offer.statusCode, 202, offer.body)
    assert.equal(offer.json().id, 'cred-1')
    assert.equal(offer.json().state, 'offer-sent')
    assert.equal(offer.json().credentialDefinitionId, 'ABC:3:CL:12:default')
    const sent = agent.calls.find((c) => c.method === 'offerCredential')?.args[1] as { credentialDefinitionObjectId: string; correlationId?: string }
    assert.equal(sent.credentialDefinitionObjectId, 'cd-2')
    assert.equal(sent.correlationId, 'emp-42')
    const read = await app.inject({ method: 'GET', url: '/v1/credentials/cred-1', headers })
    assert.equal(read.statusCode, 200)
    assert.equal(read.json().externalId, 'emp-42')
    assert.equal((await app.inject({ method: 'POST', url: '/v1/credentials/offer', headers, payload: { connectionId: 'conn-1', credentialDefinitionId: 'nope', attributes: {} } })).statusCode, 404)
  })

  it('replays idempotent requests and refuses a reused key with a different body', async () => {
    const headers = { authorization: `Bearer ${apiKey}`, 'idempotency-key': 'k-1' }
    const first = await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers, payload: { multiUse: false } })
    assert.equal(first.statusCode, 201)
    const invitations = agent.calls.filter((c) => c.method === 'createInvitation').length
    const replay = await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers, payload: { multiUse: false } })
    assert.equal(replay.statusCode, 201)
    assert.equal(replay.headers['idempotent-replayed'], 'true')
    assert.deepEqual(replay.json(), first.json())
    assert.equal(agent.calls.filter((c) => c.method === 'createInvitation').length, invitations)
    const mismatch = await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers, payload: { multiUse: true } })
    assert.equal(mismatch.statusCode, 422)
  })

  it('refuses a second request while the first holds the key, takes over a stale one, releases on 5xx', async () => {
    const auth = { authorization: `Bearer ${apiKey}` }
    const payload = { multiUse: false }
    // The stored request hash of an identical completed request, to reserve a key by hand.
    await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers: { ...auth, 'idempotency-key': 'probe' }, payload })
    const [probe] = await db!.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'probe'))
    await db!.db.insert(idempotencyKeys).values({ tenantId, key: 'busy-1', requestHash: probe.requestHash })

    const busy = await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers: { ...auth, 'idempotency-key': 'busy-1' }, payload })
    assert.equal(busy.statusCode, 409, busy.body)
    assert.equal(busy.json().error, 'idempotency_in_progress')
    assert.equal(busy.headers['retry-after'], '1')

    await db!.db.update(idempotencyKeys).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(idempotencyKeys.key, 'busy-1'))
    const takenOver = await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers: { ...auth, 'idempotency-key': 'busy-1' }, payload })
    assert.equal(takenOver.statusCode, 201, takenOver.body)
    assert.equal(takenOver.headers['idempotent-replayed'], undefined)
    const replay = await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers: { ...auth, 'idempotency-key': 'busy-1' }, payload })
    assert.equal(replay.headers['idempotent-replayed'], 'true')

    const createInvitation = agent.client.createInvitation
    agent.client.createInvitation = async () => {
      throw new Error('agent down')
    }
    try {
      const failed = await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers: { ...auth, 'idempotency-key': 'fails-1' }, payload })
      assert.ok(failed.statusCode >= 500, failed.body)
      assert.equal((await db!.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'fails-1'))).length, 0, 'a 5xx releases the key')
    } finally {
      agent.client.createInvitation = createInvitation
    }
    const retried = await app.inject({ method: 'POST', url: '/v1/connections/invitations', headers: { ...auth, 'idempotency-key': 'fails-1' }, payload })
    assert.equal(retried.statusCode, 201)
    assert.equal(retried.headers['idempotent-replayed'], undefined)
  })

  it('replays wallet creation as the same wallet with a new token, and never stores a token', async () => {
    const auth = { authorization: `Bearer ${apiKey}` }
    const phone = { ...auth, 'idempotency-key': 'install-phone' }
    const first = await app.inject({ method: 'POST', url: '/v1/wallets', headers: phone, payload: { externalId: 'user-8' } })
    assert.equal(first.statusCode, 201, first.body)
    const retry = await app.inject({ method: 'POST', url: '/v1/wallets', headers: phone, payload: { externalId: 'user-8' } })
    assert.equal(retry.statusCode, 201, retry.body)
    assert.equal(retry.headers['idempotent-replayed'], 'true')
    assert.equal(retry.json().id, first.json().id, 'same wallet')
    assert.notEqual(retry.json().walletToken, first.json().walletToken)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/wallet', headers: { authorization: `Bearer ${first.json().walletToken}` } })).statusCode, 401, 'the earlier token stops working')
    assert.equal((await app.inject({ method: 'GET', url: '/v1/wallet', headers: { authorization: `Bearer ${retry.json().walletToken}` } })).statusCode, 200)

    // The same user on a second device: another installation id, another wallet.
    const tablet = await app.inject({ method: 'POST', url: '/v1/wallets', headers: { ...auth, 'idempotency-key': 'install-tablet' }, payload: { externalId: 'user-8' } })
    assert.equal(tablet.statusCode, 201)
    assert.notEqual(tablet.json().id, first.json().id)

    const stored = await db!.db.select().from(idempotencyKeys)
    assert.ok(stored.every((row) => !(row.responseBody ?? '').includes('12id_wt_')), 'no wallet token is stored')

    await app.inject({ method: 'DELETE', url: `/v1/wallets/${first.json().id}`, headers: auth })
    const afterRevoke = await app.inject({ method: 'POST', url: '/v1/wallets', headers: phone, payload: { externalId: 'user-8' } })
    assert.equal(afterRevoke.statusCode, 409)
    assert.equal(afterRevoke.json().error, 'wallet_revoked')
  })

  it('keeps setup routes to the console: an API key gets 403 on every write, and still reads (K1)', async () => {
    const key = { authorization: `Bearer ${apiKey}` }
    const template = { name: 'k1', groups: [{ key: 'employee', attributes: ['name'], credentials: [{ schemaName: 'employee-badge' }] }] }
    const someId = '00000000-0000-4000-8000-000000000000'
    const writes: Array<{ method: 'POST' | 'PUT' | 'DELETE'; url: string; payload?: object }> = [
      { method: 'POST', url: '/v1/schemas', payload: { name: 'k1', version: '1.0', attributes: ['name', 'expiresAt'] } },
      { method: 'POST', url: `/v1/schemas/${someId}/deprecation`, payload: { deprecated: true } },
      { method: 'POST', url: '/v1/credential-definitions', payload: { schemaId: someId } },
      { method: 'POST', url: '/v1/proof-templates', payload: template },
      { method: 'PUT', url: `/v1/proof-templates/${someId}`, payload: template },
      { method: 'PUT', url: `/v1/proof-templates/${someId}/biometric-policy`, payload: { mode: 'off' } },
      { method: 'DELETE', url: `/v1/proof-templates/${someId}` },
      { method: 'PUT', url: '/v1/webhook', payload: { url: 'https://attacker.test/hook' } },
      { method: 'POST', url: '/v1/webhook/rotate-secret' },
      { method: 'DELETE', url: '/v1/webhook' },
      { method: 'POST', url: '/v1/webhook/deliveries/1/retry' },
    ]
    const publishes = agent.calls.filter((c) => c.method === 'publishSchema' || c.method === 'publishCredentialDefinition').length
    for (const write of writes) {
      const refused = await app.inject({ ...write, headers: key })
      assert.equal(refused.statusCode, 403, `${write.method} ${write.url}: ${refused.body}`)
      assert.equal(refused.json().error, 'forbidden')
    }
    assert.equal(agent.calls.filter((c) => c.method === 'publishSchema' || c.method === 'publishCredentialDefinition').length, publishes, 'nothing reached agent-service')

    for (const url of ['/v1/schemas', '/v1/credential-definitions', '/v1/proof-templates', '/v1/webhook/deliveries']) {
      assert.equal((await app.inject({ method: 'GET', url, headers: key })).statusCode, 200, url)
    }
    const published = await app.inject({ method: 'POST', url: '/v1/schemas', headers: consoleHeaders(), payload: { name: 'k1', version: '1.0', attributes: ['name', 'expiresAt'] } })
    assert.equal(published.statusCode, 201, published.body)

    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as { paths: Record<string, Record<string, unknown>> }
    assert.equal(spec.paths['/v1/schemas']?.post, undefined, 'publishing is left out of the customer document')
    assert.ok(spec.paths['/v1/schemas']?.get, 'reading stays in it')
    assert.equal(spec.paths['/v1/webhook']?.put, undefined)
  })

  it('requests a proof from a stored template, expanded against the catalogue', async () => {
    const headers = { authorization: `Bearer ${apiKey}` }
    const template = await app.inject({ method: 'POST', url: '/v1/proof-templates', headers: consoleHeaders(), payload: { name: 'badge', groups: [{ key: 'employee', attributes: ['name', 'department'], credentials: [{ schemaName: 'employee-badge' }], predicates: [{ name: 'employeeNumber', type: '>', value: 1000 }] }] } })
    assert.equal(template.statusCode, 201, template.body)
    const proof = await app.inject({ method: 'POST', url: '/v1/proofs/request', headers, payload: { connectionId: 'conn-1', templateId: template.json().id, externalId: 'check-1' } })
    assert.equal(proof.statusCode, 202, proof.body)
    assert.equal(proof.json().templateId, template.json().id)
    const sent = agent.calls.find((c) => c.method === 'requestProof')?.args[1] as { groups: Array<{ credentialDefinitionIds: string[] }> }
    assert.deepEqual(sent.groups[0].credentialDefinitionIds.sort(), ['ABC:3:CL:10:default', 'ABC:3:CL:12:default'])
    const both = await app.inject({ method: 'POST', url: '/v1/proofs/request', headers, payload: { connectionId: 'conn-1', templateId: template.json().id, request: { name: 'x', groups: [] } } })
    assert.equal(both.statusCode, 400)
  })

  it('creates wallets for the customer and mints mediator invitations for the app', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/wallets', headers: { authorization: `Bearer ${apiKey}` }, payload: { externalId: 'user-7' } })
    assert.equal(created.statusCode, 201, created.body)
    const walletToken = created.json().walletToken as string
    assert.ok(walletToken.startsWith('12id_wt_'))
    assert.equal(created.json().hasMediatorInvitation, false)

    assert.equal((await app.inject({ method: 'GET', url: '/v1/wallet/mediator-invitation', headers: { authorization: `Bearer ${apiKey}` } })).statusCode, 401, 'an API key is not a wallet token')
    const invitation = await app.inject({ method: 'GET', url: '/v1/wallet/mediator-invitation', headers: { authorization: `Bearer ${walletToken}` } })
    assert.equal(invitation.statusCode, 200, invitation.body)
    assert.equal(invitation.json().invitationUrl, 'https://mediator.test?oob=w1')
    const me = await app.inject({ method: 'GET', url: '/v1/wallet', headers: { authorization: `Bearer ${walletToken}` } })
    assert.equal(me.json().hasMediatorInvitation, true)

    const revoked = await app.inject({ method: 'DELETE', url: `/v1/wallets/${created.json().id}`, headers: { authorization: `Bearer ${apiKey}` } })
    assert.equal(revoked.statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/wallet', headers: { authorization: `Bearer ${walletToken}` } })).statusCode, 401)
  })

  it('configures the webhook endpoint from the console and returns the secret once', async () => {
    const headers = consoleHeaders()
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/webhook', headers, payload: { url: 'http://insecure.test/hook' } })).statusCode, 400)
    const set = await app.inject({ method: 'PUT', url: '/v1/webhook', headers, payload: { url: 'https://customer.test/hook', events: ['proof.state_changed'] } })
    assert.equal(set.statusCode, 200, set.body)
    assert.ok(String(set.json().secret).startsWith('whsec_'))
    const again = await app.inject({ method: 'PUT', url: '/v1/webhook', headers, payload: { url: 'https://customer.test/hook2' } })
    assert.equal(again.json().secret, undefined)
    assert.equal(again.json().events, null)
    const rotated = await app.inject({ method: 'POST', url: '/v1/webhook/rotate-secret', headers })
    assert.notEqual(rotated.json().secret, set.json().secret)
    // The replaced secret is kept for the rotation overlap (review M9).
    const [stored] = await db!.db.select().from(webhookEndpoints)
    assert.equal(stored.secret, rotated.json().secret)
    assert.equal(stored.previousSecret, set.json().secret)
    assert.ok(stored.rotatedAt)
  })

  it('accepts the mediator webhook only on the secret path', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/internal/mediator/wrong', payload: { connectionId: 'c' } })).statusCode, 404)
    const ok = await app.inject({ method: 'POST', url: `/internal/mediator/${testConfig.MEDIATOR_WEBHOOK_SECRET}`, payload: { connectionId: 'med-conn-1', fcmToken: null } })
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(wakes, ['med-conn-1'])
  })

  it('answers server errors generically and passes agent 4xx reasons through', async () => {
    const failing = fakeAgent({
      listCatalogue: async () => {
        throw new Error('Failed query: select secret from ...')
      },
      listCataloguePage: async () => {
        throw new Error('Failed query: select secret from ...')
      },
      createInvitation: async () => {
        const { AgentError } = await import('../src/agent-client.ts')
        throw new AgentError(409, 'exchange', 'tenant is not onboarded')
      },
    })
    const broken = buildApp({ config: testConfig, db: db!.db, agent: failing.client, mediator: { createInvitation: async () => ({ outOfBandId: 'x', invitationUrl: 'y' }) }, logger: silentLogger, readiness: async () => ({ ready: true, draining: false, checks: {} }), wake: async () => 'requested' })
    const headers = { authorization: `Bearer ${apiKey}` }
    const failed = await broken.inject({ method: 'GET', url: '/v1/schemas', headers })
    assert.equal(failed.statusCode, 500)
    assert.deepEqual(failed.json(), { error: 'internal', reason: 'internal error' })
    const refused = await broken.inject({ method: 'POST', url: '/v1/connections/invitations', headers, payload: {} })
    assert.equal(refused.statusCode, 409)
    assert.equal(refused.json().reason, 'tenant is not onboarded')
    await broken.close()
  })
})
