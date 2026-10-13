import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { INTERNAL_TOKEN_HEADER } from '@12id/credo-base/biometric-contract.ts'

import type { Database } from '../src/db/client.ts'
import { buildBiometricApi } from '../src/http/api.ts'
import { closeTestDatabase, defaultCheck, silentLogger, testDatabase, testService } from './helpers.ts'

const TOKEN = 'b'.repeat(40)
const auth = { [INTERNAL_TOKEN_HEADER]: TOKEN }

describe('biometric-service HTTP API', () => {
  let db: Database | null = null
  beforeEach(async () => {
    db = await testDatabase()
  })
  after(closeTestDatabase)

  const api = () => buildBiometricApi({ logger: silentLogger, token: TOKEN, service: testService(db!) })

  it('requires the token everywhere except /healthz', async (t) => {
    if (!db) return t.skip()
    const app = api()
    assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200)
    assert.equal((await app.inject({ url: '/providers' })).statusCode, 401)
    assert.equal((await app.inject({ url: '/providers', headers: { [INTERNAL_TOKEN_HEADER]: 'x'.repeat(40) } })).statusCode, 401)
    assert.equal((await app.inject({ url: '/providers', headers: auth })).statusCode, 200)
  })

  it('serves the catalogue with JSON Schemas and capture modules', async (t) => {
    if (!db) return t.skip()
    const body = (await api().inject({ url: '/providers', headers: auth })).json()
    assert.deepEqual(body.providers.map((p: { id: string }) => p.id), ['mock'])
    assert.equal(body.providers[0].configSchema.type, 'object')
    assert.deepEqual(body.providers[0].captureModule, { provider: 'mock', minVersion: 1 })
  })

  it('stores, activates and drops a provider configuration that waits for approval', async (t) => {
    if (!db) return t.skip()
    const app = api()
    const pending = '/tenants/t1/provider/pending'
    assert.equal((await app.inject({ method: 'PUT', url: pending, payload: { providerId: 'mock', config: {} } })).statusCode, 401)
    const stored = await app.inject({ method: 'PUT', url: pending, headers: auth, payload: { providerId: 'mock', config: {} } })
    assert.deepEqual([stored.statusCode, stored.json()], [200, { providerId: 'mock', publicConfig: {} }])
    assert.equal((await app.inject({ url: '/tenants/t1/provider', headers: auth })).json().provider, null)
    const activated = await app.inject({ method: 'POST', url: `${pending}/activate`, headers: auth })
    assert.deepEqual([activated.statusCode, activated.json().provider.status], [200, 'untested'])
    const again = await app.inject({ method: 'POST', url: `${pending}/activate`, headers: auth })
    assert.deepEqual([again.statusCode, again.json().error], [404, 'no_pending_provider'])
    await app.inject({ method: 'PUT', url: pending, headers: auth, payload: { providerId: 'mock', config: {} } })
    assert.equal((await app.inject({ method: 'DELETE', url: pending, headers: auth })).statusCode, 204)
    assert.equal((await app.inject({ method: 'POST', url: `${pending}/activate`, headers: auth })).statusCode, 404)
  })

  it('runs a check end to end and never echoes the image', async (t) => {
    if (!db) return t.skip()
    const app = api()
    assert.equal((await app.inject({ method: 'PUT', url: '/tenants/t1/provider', headers: auth, payload: { providerId: 'mock', config: {} } })).statusCode, 200)
    assert.deepEqual((await app.inject({ method: 'POST', url: '/tenants/t1/provider/test', headers: auth })).json(), { status: 'ok', error: null })

    const payload = defaultCheck('t1')
    const created = await app.inject({ method: 'POST', url: '/checks', headers: auth, payload })
    assert.equal(created.statusCode, 201)
    assert.equal(created.body.includes(payload.referenceImage.slice(0, 40)), false)
    const { checkId } = created.json()

    const session = (await app.inject({ method: 'POST', url: `/checks/${checkId}/sessions`, headers: auth })).json()
    const done = await app.inject({ method: 'POST', url: `/sessions/${session.sessionId}/complete`, headers: auth, payload: { clientOutput: { live: true, face: 'same' } } })
    assert.equal(done.statusCode, 200)
    assert.equal(done.json().check.status, 'passed')

    const view = await app.inject({ url: `/checks/${checkId}`, headers: auth })
    assert.equal(view.json().sessions[0].result.matchScore, 99)
    assert.equal(view.body.includes(payload.referenceImage.slice(0, 40)), false)
  })

  it('maps service errors to statuses', async (t) => {
    if (!db) return t.skip()
    const app = api()
    const missing = await app.inject({ method: 'POST', url: '/checks', headers: auth, payload: defaultCheck('nobody') })
    assert.deepEqual([missing.statusCode, missing.json().error], [409, 'provider_not_configured'])
    const unknown = await app.inject({ method: 'POST', url: '/checks/00000000-0000-4000-8000-000000000000/sessions', headers: auth })
    assert.equal(unknown.statusCode, 404)
    const bad = await app.inject({ method: 'PUT', url: '/tenants/t1/provider', headers: auth, payload: { providerId: 'nope', config: {} } })
    assert.deepEqual([bad.statusCode, bad.json().error], [400, 'unknown_provider'])
  })
})
