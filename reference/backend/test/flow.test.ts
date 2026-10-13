import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { type Config, loadTenant } from '../src/config.ts'
import { type Platform, platformClient, PlatformError } from '../src/platform.ts'
import { createApp } from '../src/server.ts'
import { Store } from '../src/store.ts'
import { type Catalogue, tenantProblems } from '../src/tenant-check.ts'
import { credentialAttributes, dateNumber, verifySignature } from '../src/webhooks.ts'

const SECRET = 'whsec_test'
const config: Config = {
  platformApiUrl: 'http://platform.invalid',
  platformApiKey: '12id_sk_test',
  webhookSecret: SECRET,
  accessCode: 'open-sesame',
  port: 0,
  dataFile: '',
  appDownloadUrl: 'https://example.test/app.apk',
  tenant: {
    credentialDefinitionId: 'cred-def-1',
    credential: { validDays: 365, attributes: { fullName: '{name}', memberId: '{memberId}', level: '2' } },
    actions: { transfer: { proofTemplateId: 'template-1' } },
  },
}

/** Records every call and answers like the platform; a key or wallet id in `revoked` answers 409 wallet_revoked. */
function fakePlatform() {
  const calls: { call: string; input: unknown; key?: string }[] = []
  const revoked = new Set<string>()
  const state = { refuseOffers: false }
  let n = 0
  const platform: Platform = {
    async createWallet(externalId, key) {
      calls.push({ call: 'createWallet', input: { externalId }, key })
      if (revoked.has(key)) throw new PlatformError('POST', '/v1/wallets', 409, { error: 'wallet_revoked' })
      n += 1
      return { id: `wallet-${n}`, walletToken: `12id_wt_${n}` }
    },
    async reissueWalletToken(walletId) {
      calls.push({ call: 'reissueWalletToken', input: { walletId } })
      if (revoked.has(walletId)) throw new PlatformError('POST', `/v1/wallets/${walletId}/token`, 409, { error: 'wallet_revoked' })
      n += 1
      return { id: walletId, walletToken: `12id_wt_${n}` }
    },
    async createInvitation(externalId) {
      calls.push({ call: 'createInvitation', input: { externalId } })
      return { invitationId: 'oob-1', invitationUrl: 'https://agent.test/?oob=abc' }
    },
    async offerCredential(input, key) {
      calls.push({ call: 'offerCredential', input, key })
      if (state.refuseOffers) throw new PlatformError('POST', '/v1/credentials/offer', 400, { error: 'bad_request', reason: 'missing attributes: memberId' })
      return { id: 'credential-1', state: 'offer-sent' }
    },
    async requestProof(input, key) {
      calls.push({ call: 'requestProof', input, key })
      return { id: 'proof-1', state: 'request-sent' }
    },
  }
  return { platform, calls, revoked, state, of: (call: string) => calls.filter((c) => c.call === call) }
}

let dir: string
let app: Server
let base: string
let fake: ReturnType<typeof fakePlatform>
const logs: string[] = []

before(async () => {
  dir = mkdtempSync(join(tmpdir(), '12id-reference-'))
  fake = fakePlatform()
  app = createApp({ config, platform: fake.platform, store: new Store(join(dir, 'store.json')), log: (m) => logs.push(m) })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise((resolve) => app.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, any>, headers: response.headers }
}

async function webhook(type: string, data: Record<string, unknown>, secret = SECRET) {
  const body = JSON.stringify({ id: 'event', type, createdAt: new Date().toISOString(), tenantId: 'tenant', data })
  const t = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  const response = await fetch(`${base}/webhooks/12id`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-12id-signature': `t=${t},v1=${signature}` }, body })
  return response.status
}

const installationId = '11111111-2222-4333-8444-555555555555'

test('sign-in needs the access code', async () => {
  assert.equal((await call('POST', '/session', { name: 'Ada', accessCode: 'wrong', installationId })).status, 401)
  assert.equal((await call('POST', '/session', { name: '', accessCode: 'open-sesame', installationId })).status, 400)
  assert.equal((await call('GET', '/me')).status, 401)
  assert.equal((await call('POST', '/enrol', {}, 'not-a-token')).status, 401)
})

test('sign-in, wallet token, enrol, credential offer, action, approval', async () => {
  const session = await call('POST', '/session', { name: 'Ada Lovelace', accessCode: 'open-sesame', installationId })
  assert.equal(session.status, 200)
  const token = session.json.sessionToken as string
  const userId = session.json.user.id as string
  assert.equal(session.json.user.connected, false)

  // The SDK asks for the wallet token on every app start: one wallet, the same token.
  const first = await call('POST', '/wallet-token', {}, token)
  const second = await call('POST', '/wallet-token', {}, token)
  assert.equal(first.json.walletToken, '12id_wt_1')
  assert.equal(second.json.walletToken, '12id_wt_1')
  assert.equal(fake.of('createWallet').length, 1)
  assert.deepEqual(fake.of('createWallet')[0], { call: 'createWallet', input: { externalId: userId }, key: `${installationId}:0` })

  // An action before the wallet is connected is refused.
  assert.equal((await call('POST', '/actions', { type: 'transfer' }, token)).status, 409)

  const enrol = await call('POST', '/enrol', {}, token)
  assert.deepEqual(enrol.json, { connected: false, invitationUrl: 'https://agent.test/?oob=abc' })
  assert.deepEqual(fake.of('createInvitation')[0].input, { externalId: userId })

  // The platform reports the connection; earlier states do nothing, `completed` sends the offer once.
  assert.equal(await webhook('connection.state_changed', { id: 'connection-1', state: 'response-sent', externalId: userId }), 200)
  assert.equal(fake.of('offerCredential').length, 0)
  assert.equal(await webhook('connection.state_changed', { id: 'connection-1', state: 'completed', externalId: userId }), 200)
  assert.equal(await webhook('connection.state_changed', { id: 'connection-1', state: 'completed', externalId: userId }), 200)
  const offers = fake.of('offerCredential')
  assert.equal(offers.length, 1)
  const offer = offers[0].input as { connectionId: string; credentialDefinitionId: string; attributes: Record<string, string>; externalId: string }
  assert.equal(offer.connectionId, 'connection-1')
  assert.equal(offer.credentialDefinitionId, 'cred-def-1')
  assert.equal(offer.externalId, userId)
  assert.equal(offer.attributes.fullName, 'Ada Lovelace')
  assert.match(offer.attributes.memberId, /^\d{8}$/)
  assert.equal(offer.attributes.level, '2')
  assert.match(offer.attributes.expiresOn, /^\d{8}$/)

  await webhook('credential.state_changed', { id: 'credential-1', state: 'done', externalId: userId })
  const me = await call('GET', '/me', undefined, token)
  assert.deepEqual({ connected: me.json.connected, credentialState: me.json.credentialState }, { connected: true, credentialState: 'done' })
  assert.deepEqual((await call('POST', '/enrol', {}, token)).json, { connected: true, invitationUrl: null })
  assert.equal(fake.of('createInvitation').length, 1)

  // The action: a proof request on the stored connection, with the action id as our reference.
  assert.equal((await call('POST', '/actions', { type: 'nope' }, token)).status, 400)
  const action = await call('POST', '/actions', { type: 'transfer', details: { amount: '5000', payee: 'Rahim Traders' } }, token)
  assert.equal(action.status, 200)
  assert.equal(action.json.state, 'pending')
  assert.deepEqual(fake.of('requestProof')[0].input, { connectionId: 'connection-1', templateId: 'template-1', externalId: action.json.id })

  // Unverified presentations and other users' actions change nothing.
  await webhook('proof.state_changed', { id: 'proof-1', state: 'presentation-received', externalId: action.json.id, verified: null })
  assert.equal((await call('GET', `/actions/${action.json.id}`, undefined, token)).json.state, 'pending')
  await webhook('proof.state_changed', { id: 'proof-1', state: 'done', externalId: action.json.id, verified: true, disclosed: { member: { memberId: '12345678' } } })
  const done = await call('GET', `/actions/${action.json.id}`, undefined, token)
  assert.equal(done.json.state, 'approved')
  assert.deepEqual(done.json.disclosed, { member: { memberId: '12345678' } })
  assert.deepEqual(done.json.details, { amount: '5000', payee: 'Rahim Traders' })

  // A second user cannot read it.
  const other = await call('POST', '/session', { name: 'Eve', accessCode: 'open-sesame', installationId: '99999999-2222-4333-8444-555555555555' })
  assert.equal((await call('GET', `/actions/${action.json.id}`, undefined, other.json.sessionToken)).status, 404)
})

test('a declined or failed proof does not approve the action', async () => {
  const session = await call('POST', '/session', { name: 'Ada Lovelace', accessCode: 'open-sesame', installationId })
  const token = session.json.sessionToken as string
  const declined = await call('POST', '/actions', { type: 'transfer' }, token)
  await webhook('proof.state_changed', { id: 'proof-2', state: 'abandoned', externalId: declined.json.id })
  assert.equal((await call('GET', `/actions/${declined.json.id}`, undefined, token)).json.state, 'declined')

  const invalid = await call('POST', '/actions', { type: 'transfer' }, token)
  await webhook('proof.state_changed', { id: 'proof-3', state: 'done', externalId: invalid.json.id, verified: false })
  assert.equal((await call('GET', `/actions/${invalid.json.id}`, undefined, token)).json.state, 'failed')
  // A late duplicate cannot flip a settled action.
  await webhook('proof.state_changed', { id: 'proof-3', state: 'done', externalId: invalid.json.id, verified: true })
  assert.equal((await call('GET', `/actions/${invalid.json.id}`, undefined, token)).json.state, 'failed')
})

test('an abandoned offer is offered again on the next enrol', async () => {
  const session = await call('POST', '/session', { name: 'Ada Lovelace', accessCode: 'open-sesame', installationId })
  const before = fake.of('offerCredential').length
  await webhook('credential.state_changed', { id: 'credential-1', state: 'abandoned', externalId: session.json.user.id })
  assert.deepEqual((await call('POST', '/enrol', {}, session.json.sessionToken)).json, { connected: true, invitationUrl: null })
  assert.equal(fake.of('offerCredential').length, before + 1)
})

test('a rejected token is re-issued for the same wallet; a revoked wallet is replaced under a new key', async () => {
  const session = await call('POST', '/session', { name: 'Ada Lovelace', accessCode: 'open-sesame', installationId })
  const token = session.json.sessionToken as string
  const created = fake.of('createWallet').length
  const refreshed = await call('POST', '/wallet-token', { refresh: true }, token)
  assert.equal(refreshed.json.walletToken, '12id_wt_2')
  assert.deepEqual(fake.of('reissueWalletToken').at(-1)!.input, { walletId: 'wallet-1' })
  assert.equal(fake.of('createWallet').length, created, 'no second wallet')
  assert.equal((await call('POST', '/wallet-token', {}, token)).json.walletToken, '12id_wt_2')

  fake.revoked.add('wallet-1')
  const replaced = await call('POST', '/wallet-token', { refresh: true }, token)
  assert.equal(replaced.status, 200)
  assert.equal(fake.of('createWallet').at(-1)!.key, `${installationId}:1`)
  assert.equal((await call('POST', '/wallet-token', {}, token)).json.walletToken, replaced.json.walletToken)
})

test('webhooks need a valid, recent signature', async () => {
  assert.equal(await webhook('wallet.sync_requested', { walletId: 'wallet-1' }), 200)
  assert.ok(logs.some((line) => line.includes('sync requested')))
  assert.equal(await webhook('wallet.sync_requested', { walletId: 'wallet-1' }, 'another-secret'), 401)

  const body = '{"a":1}'
  const t = 1_800_000_000
  const good = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')
  const old = createHmac('sha256', 'previous').update(`${t}.${body}`).digest('hex')
  assert.equal(verifySignature(SECRET, `t=${t},v1=${good}`, body, t), true)
  // After a rotation the platform sends the new and the previous secret's signature; either is enough.
  assert.equal(verifySignature(SECRET, `t=${t},v1=${old},v1=${good}`, body, t), true)
  assert.equal(verifySignature(SECRET, `t=${t},v1=${good}`, '{"a":2}', t), false)
  assert.equal(verifySignature(SECRET, `t=${t},v1=${good}`, body, t + 301), false)
  assert.equal(verifySignature(SECRET, `v1=${good}`, body, t), false)
  assert.equal(verifySignature(SECRET, '', body, t), false)
})

test('other routes', async () => {
  assert.deepEqual((await call('GET', '/healthz')).json, { ok: true })
  const app = await call('GET', '/app')
  assert.equal(app.status, 302)
  assert.equal(app.headers.get('location'), 'https://example.test/app.apk')
  assert.equal((await call('GET', '/nothing')).status, 404)
  const bad = await fetch(`${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
  assert.equal(bad.status, 400)
})

test('the store survives a restart', () => {
  const store = new Store(join(dir, 'store.json'))
  const user = store.findUser((u) => u.installationId === installationId)
  assert.equal(user?.connectionId, 'connection-1')
  assert.equal(user?.walletGeneration, 1)
})

test('credential attributes: placeholders and the expiry date', () => {
  const attributes = credentialAttributes(config.tenant, { name: 'Ada', memberId: '42' }, new Date('2026-10-10T12:00:00Z'))
  assert.deepEqual(attributes, { fullName: 'Ada', memberId: '42', level: '2', expiresOn: '20271010' })
  assert.equal(dateNumber(new Date('2026-01-02T23:59:59Z')), '20260102')
})

test('an offer the platform refused is sent again by the next enrol, and each attempt has its own key', async () => {
  const session = await call('POST', '/session', { name: 'Grace', accessCode: 'open-sesame', installationId: '22222222-2222-4333-8444-555555555555' })
  const token = session.json.sessionToken as string
  const userId = session.json.user.id as string
  await call('POST', '/enrol', {}, token)

  // The platform refuses the offer (say, tenant.json names the wrong attributes): the webhook is not acknowledged.
  fake.state.refuseOffers = true
  assert.equal(await webhook('connection.state_changed', { id: 'connection-2', state: 'completed', externalId: userId }), 502)
  assert.deepEqual((await call('GET', '/me', undefined, token)).json.credentialState, null)
  assert.equal((await call('POST', '/enrol', {}, token)).status, 502)

  // Fixed: the app's next enrol offers on the connection it already has.
  fake.state.refuseOffers = false
  assert.deepEqual((await call('POST', '/enrol', {}, token)).json, { connected: true, invitationUrl: null })
  assert.equal((await call('GET', '/me', undefined, token)).json.credentialState, 'offer-sent')
  const first = fake.of('offerCredential').at(-1)!.key!
  assert.match(first, new RegExp(`^offer:${userId}:0:[0-9a-f]{24}$`))
  // While that offer is on its way, enrol does not send another.
  const count = fake.of('offerCredential').length
  await call('POST', '/enrol', {}, token)
  assert.equal(fake.of('offerCredential').length, count)

  // Declined: the next offer is a new attempt, so the platform does not answer it from the first.
  await webhook('credential.state_changed', { id: 'credential-9', state: 'abandoned', externalId: userId })
  await call('POST', '/enrol', {}, token)
  const second = fake.of('offerCredential').at(-1)!.key!
  assert.match(second, new RegExp(`^offer:${userId}:1:`))
  assert.notEqual(second, first)
})

test('tenant.json is compared with the catalogue', () => {
  const catalogue: Catalogue = {
    definitions: [
      { id: 'def-3', credentialDefinitionId: 'L:3:CL:9:default', schemaId: 'schema-3', schemaName: 'customer', schemaVersion: '3.0', tag: 'default', status: 'published' },
      { id: 'def-1', credentialDefinitionId: 'L:3:CL:7:default', schemaId: 'schema-1', schemaName: 'customer', schemaVersion: '1.0', tag: 'default', status: 'deprecated' },
    ],
    schemas: [
      { id: 'schema-3', name: 'customer', version: '3.0', attributes: ['memberId', 'expiresOn'] },
      { id: 'schema-1', name: 'customer', version: '1.0', attributes: ['id', 'expiresOn'] },
    ],
    templates: [{ id: 'template-1', name: 'transaction', definition: { groups: [{ attributes: ['memberId'] }] } }],
  }
  const tenant = (credentialDefinitionId: string, attributes: Record<string, string>, proofTemplateId = 'template-1') => ({ credentialDefinitionId, credential: { validDays: 365, attributes }, actions: { transfer: { proofTemplateId } } })

  assert.deepEqual(tenantProblems(tenant('def-3', { memberId: '{memberId}' }), catalogue), [])
  assert.deepEqual(tenantProblems(tenant('L:3:CL:9:default', { memberId: '{memberId}' }), catalogue), [])
  // The new credential definition with the old schema's attribute: what "your card did not arrive" was.
  assert.deepEqual(tenantProblems(tenant('def-3', { id: '{memberId}' }), catalogue), [
    'credential.attributes lacks memberId, which schema customer 3.0 has',
    'credential.attributes has id, which schema customer 3.0 does not have',
  ])
  assert.match(tenantProblems(tenant('def-1', { id: '{memberId}' }), catalogue)[0], /is deprecated; offers from it are refused/)
  assert.match(tenantProblems(tenant('nope', { memberId: 'x' }), catalogue)[0], /is not one of this organisation's credential definitions/)
  assert.match(tenantProblems(tenant('def-3', { memberId: 'x' }, 'gone'), catalogue)[0], /actions\.transfer\.proofTemplateId gone is not one of/)
})

test('a tenant file with a mistake is refused with a message that names it', () => {
  const file = join(dir, 'tenant.json')
  const write = (text: string) => writeFileSync(file, text)
  const good = { credentialDefinitionId: 'd', credential: { validDays: 30, attributes: { id: '{memberId}' } }, actions: { transfer: { proofTemplateId: 't' } } }

  write(JSON.stringify(good))
  assert.equal(loadTenant(file).credentialDefinitionId, 'd')
  write('{ "credentialDefinitionId": "d", "credential": { "validDays": 30, "attributes": { "id": "{memberId}", } }, "actions": {} }')
  assert.throws(() => loadTenant(file), /is not valid JSON/)
  write(JSON.stringify({ ...good, credential: { validDays: 30, attributes: { id: '{id}' } } }))
  assert.throws(() => loadTenant(file), /unknown placeholder \{id\}/)
  write(JSON.stringify({ ...good, credentialDefinitionId: 'REPLACE: …' }))
  assert.throws(() => loadTenant(file), /fill in/)
  write(JSON.stringify({ ...good, credential: { validDays: 30, attributes: { expiresOn: '20300101' } } }))
  assert.throws(() => loadTenant(file), /leave expiresOn out/)
})

test('the platform client sends the API key and the idempotency key, and reports refusals', async () => {
  const seen: { url?: string; headers: Record<string, unknown>; body: string }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      seen.push({ url: request.url, headers: request.headers, body })
      if (request.url === '/v1/wallets') response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'w', walletToken: 't' }))
      else response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'wallet_revoked' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = platformClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, '12id_sk_abc')
    assert.deepEqual(await client.createWallet('user-1', 'installation:0'), { id: 'w', walletToken: 't' })
    assert.equal(seen[0].headers.authorization, 'Bearer 12id_sk_abc')
    assert.equal(seen[0].headers['idempotency-key'], 'installation:0')
    assert.deepEqual(JSON.parse(seen[0].body), { externalId: 'user-1' })
    await assert.rejects(client.createInvitation('user-1'), (error: unknown) => error instanceof PlatformError && error.status === 409)
    assert.equal(seen[1].headers['idempotency-key'], undefined)
    await assert.rejects(client.reissueWalletToken('w'), (error: unknown) => error instanceof PlatformError && error.status === 409)
    assert.equal(seen[2].url, '/v1/wallets/w/token')
    assert.equal(seen[2].headers['idempotency-key'], undefined)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
