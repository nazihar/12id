import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import type { Config } from '../src/config.ts'
import { type Platform, PlatformError } from '../src/platform.ts'
import { createApp } from '../src/server.ts'
import { Store } from '../src/store.ts'
import { type Catalogue, tenantProblems } from '../src/tenant-check.ts'

/** An organisation that uses face checks: tenant.json has "photoOnFile": true. */
const config: Config = {
  platformApiUrl: 'http://platform.invalid',
  platformApiKey: '12id_sk_test',
  webhookSecret: 'whsec_test',
  accessCode: 'open-sesame',
  port: 0,
  dataFile: '',
  appDownloadUrl: null,
  tenant: {
    credentialDefinitionId: 'cred-def-1',
    credential: { validDays: 365, attributes: { memberId: '{memberId}' } },
    photoOnFile: true,
    actions: { transfer: { proofTemplateId: 'template-1' } },
  },
}

const offers: { input: any; key: string }[] = []
const proofs: { input: any; key: string }[] = []
const state = { requireReference: false }
const platform: Platform = {
  createWallet: async () => ({ id: 'wallet-1', walletToken: '12id_wt_1' }),
  createInvitation: async () => ({ invitationId: 'oob-1', invitationUrl: 'https://agent.test/?oob=abc' }),
  async offerCredential(input, key) {
    offers.push({ input, key })
    return { id: 'credential-1', state: 'offer-sent' }
  },
  async requestProof(input, key) {
    proofs.push({ input, key })
    if (state.requireReference && !input.biometric) throw new PlatformError('POST', '/v1/proofs/request', 422, { error: 'biometric_reference_required' })
    return { id: 'proof-1', state: 'request-sent' }
  },
}

let dir: string
let app: Server
let base: string
const logs: string[] = []

before(async () => {
  dir = mkdtempSync(join(tmpdir(), '12id-reference-face-'))
  app = createApp({ config, platform, store: new Store(join(dir, 'store.json')), log: (m) => logs.push(m) })
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
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, any> }
}

async function webhook(type: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ id: 'event', type, createdAt: new Date().toISOString(), tenantId: 'tenant', data })
  const t = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')
  return (await fetch(`${base}/webhooks/12id`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-12id-signature': `t=${t},v1=${signature}` }, body })).status
}

/** The smallest thing that starts like a JPEG; the backend checks the type and the size, not the picture. */
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)])

test('a photo is needed before enrolling, and it travels with the offer and the proof request', async () => {
  const session = await call('POST', '/session', { name: 'Ada', accessCode: 'open-sesame', installationId: '33333333-2222-4333-8444-555555555555' })
  const token = session.json.sessionToken as string
  const userId = session.json.user.id as string
  assert.equal(session.json.user.photoRequired, true)
  assert.deepEqual((await call('POST', '/enrol', {}, token)).json, { error: 'photo_required' })

  // Only an image, of a sane size, from the signed-in user.
  assert.equal((await call('POST', '/photo', { image: Buffer.from('not an image').toString('base64') }, token)).status, 400)
  assert.equal((await call('POST', '/photo', { image: Buffer.concat([jpeg, Buffer.alloc(1_000_000)]).toString('base64') }, token)).status, 400)
  assert.equal((await call('POST', '/photo', { image: jpeg.toString('base64') })).status, 401)
  const saved = await call('POST', '/photo', { image: jpeg.toString('base64') }, token)
  assert.equal(saved.status, 200)
  assert.equal(saved.json.photoRequired, false)
  const file = join(dir, 'photos', `${userId}.jpg`)
  assert.ok(existsSync(file))
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)

  // Enrol now works, and the offer carries the photo as the reference image.
  assert.equal((await call('POST', '/enrol', {}, token)).json.invitationUrl, 'https://agent.test/?oob=abc')
  assert.equal(await webhook('connection.state_changed', { id: 'connection-1', state: 'completed', externalId: userId }), 200)
  assert.equal(offers.length, 1)
  assert.equal(offers[0].input.biometric.referenceImage, jpeg.toString('base64'))

  // So does the proof request of an action.
  state.requireReference = true
  const action = await call('POST', '/actions', { type: 'transfer', details: { amount: '900000' } }, token)
  assert.equal(action.status, 200)
  assert.equal(proofs.at(-1)!.input.biometric.referenceImage, jpeg.toString('base64'))

  // The photo is in no answer to the app and in no log line.
  assert.ok(!JSON.stringify([session.json, saved.json, action.json, (await call('GET', '/me', undefined, token)).json]).includes(jpeg.toString('base64').slice(0, 40)))
  assert.ok(!logs.join('\n').includes(jpeg.toString('base64').slice(0, 40)))
})

test('a face-check attempt is logged with its scores', async () => {
  // The event's shape as the platform sends it (seen on staging, 2026-10-10).
  const event = { recordType: 'credential', recordId: 'credential-1', threadId: 't', attempt: { attempt: 1, decision: 'passed', reason: 'passed', livenessScore: 99.5, matchScore: 99.9 }, biometric: { required: true, status: 'passed', attempts: 1, attemptsRemaining: 2 } }
  assert.equal(await webhook('biometric.check_completed', event), 200)
  assert.ok(logs.some((line) => line.includes('face check for credential credential-1: passed (liveness 99.5, match 99.9), 2 attempts left')))
  // An expired check has no attempt.
  assert.equal(await webhook('biometric.check_completed', { ...event, attempt: null, biometric: { status: 'expired', attemptsRemaining: 3 } }), 200)
  assert.ok(logs.some((line) => line.includes('face check for credential credential-1: expired, 3 attempts left')))
})

test('tenant.json must say photoOnFile where the console requires a face check', () => {
  const catalogue: Catalogue = {
    definitions: [{ id: 'cred-def-1', credentialDefinitionId: 'L:3:CL:9:default', schemaId: 'schema-1', schemaName: 'customer', schemaVersion: '3.0', tag: 'default', status: 'published' }],
    schemas: [{ id: 'schema-1', name: 'customer', version: '3.0', attributes: ['memberId', 'expiresOn'] }],
    templates: [{ id: 'template-1', name: 'transaction', definition: { groups: [{ attributes: ['memberId'] }] } }],
    facePolicies: { 'cred-def-1': 'inherit', 'template-1': 'required' },
  }
  assert.deepEqual(tenantProblems(config.tenant, catalogue), [])
  assert.deepEqual(tenantProblems({ ...config.tenant, photoOnFile: false }, catalogue), ['a face check is required for template-1 (console, Biometrics): set "photoOnFile": true'])
  assert.deepEqual(tenantProblems({ ...config.tenant, photoOnFile: undefined }, { ...catalogue, facePolicies: { 'cred-def-1': 'inherit', 'template-1': 'off' } }), [])
})
