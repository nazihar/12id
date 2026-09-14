/**
 * HTTP surface against a real Postgres (skipped without one) with agent-service and the mediator
 * doubled. Covers: admin bootstrap, API-key and wallet-token auth, idempotency, the customer
 * command → mirror-row path, the wake receiver's secret, and the generic 500 body.
 */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import type { WakeOutcome } from '../src/wake.ts'
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
    assert.deepEqual(ok.json(), [])
  })

  it('lists the catalogue with both identifier forms', async () => {
    const schemas = await app.inject({ method: 'GET', url: '/v1/schemas', headers: { authorization: `Bearer ${apiKey}` } })
    assert.equal(schemas.json().length, 2)
    assert.equal(schemas.json()[0].schemaId, 'ABC:2:employee-badge:1.0')
    const defs = await app.inject({ method: 'GET', url: '/v1/credential-definitions', headers: { authorization: `Bearer ${apiKey}` } })
    assert.equal(defs.json()[1].credentialDefinitionId, 'ABC:3:CL:12:default')
    assert.equal(defs.json()[1].qualifiedId, 'q2')
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

  it('requests a proof from a stored template, expanded against the catalogue', async () => {
    const headers = { authorization: `Bearer ${apiKey}` }
    const template = await app.inject({ method: 'POST', url: '/v1/proof-templates', headers, payload: { name: 'badge', groups: [{ key: 'employee', attributes: ['name', 'department'], credentials: [{ schemaName: 'employee-badge' }], predicates: [{ name: 'employeeNumber', type: '>', value: 1000 }] }] } })
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

  it('configures the webhook endpoint and returns the secret once', async () => {
    const headers = { authorization: `Bearer ${apiKey}` }
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/webhook', headers, payload: { url: 'http://insecure.test/hook' } })).statusCode, 400)
    const set = await app.inject({ method: 'PUT', url: '/v1/webhook', headers, payload: { url: 'https://customer.test/hook', events: ['proof.state_changed'] } })
    assert.equal(set.statusCode, 200, set.body)
    assert.ok(String(set.json().secret).startsWith('whsec_'))
    const again = await app.inject({ method: 'PUT', url: '/v1/webhook', headers, payload: { url: 'https://customer.test/hook2' } })
    assert.equal(again.json().secret, undefined)
    assert.equal(again.json().events, null)
    const rotated = await app.inject({ method: 'POST', url: '/v1/webhook/rotate-secret', headers })
    assert.notEqual(rotated.json().secret, set.json().secret)
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
