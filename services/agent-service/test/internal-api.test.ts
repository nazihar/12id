import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'

import { pino } from 'pino'

import { type ReadinessReport, buildInternalApi } from '../src/http/internal-api.ts'

const silentLogger = pino(
  { level: 'silent' },
  new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
)

function apiWith(report: ReadinessReport & Record<string, unknown>) {
  return buildInternalApi({ logger: silentLogger, readiness: async () => report })
}

describe('internal API health', () => {
  it('liveness answers without consulting readiness', async () => {
    const api = buildInternalApi({
      logger: silentLogger,
      readiness: async () => {
        throw new Error('readiness must not be called by /healthz')
      },
    })
    const response = await api.inject({ method: 'GET', url: '/healthz' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: 'ok' })
    await api.close()
  })

  it('readiness is 200 when ready', async () => {
    const api = apiWith({ ready: true, draining: false, checks: { store: true, ledger: true } })
    const response = await api.inject({ method: 'GET', url: '/readyz' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ready: true, draining: false, checks: { store: true, ledger: true } })
    await api.close()
  })

  it('readiness is 503 while draining, so the edge stops routing', async () => {
    const api = apiWith({ ready: false, draining: true, checks: { store: true, ledger: true } })
    const response = await api.inject({ method: 'GET', url: '/readyz' })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().draining, true)
    await api.close()
  })

  it('an internal failure returns a generic 500 without the error message', async () => {
    const api = buildInternalApi({
      logger: silentLogger,
      readiness: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password authentication failed for user "postgres"')
      },
    })
    const response = await api.inject({ method: 'GET', url: '/readyz' })
    assert.equal(response.statusCode, 500)
    assert.doesNotMatch(response.body, /ECONNREFUSED|password|postgres/)
    await api.close()
  })

  it('the response schema strips fields a handler did not declare', async () => {
    const api = apiWith({ ready: true, draining: false, checks: {}, storeKey: 'must-not-leak' })
    const response = await api.inject({ method: 'GET', url: '/readyz' })
    assert.equal(response.statusCode, 200)
    assert.doesNotMatch(response.body, /must-not-leak|storeKey/)
    await api.close()
  })
})

describe('internal API token (Phase 3 P0)', () => {
  const token = 'x'.repeat(40)
  const report = { ready: true, draining: false, checks: {} }
  const api = buildInternalApi({
    logger: silentLogger,
    readiness: async () => report,
    token,
    commands: async (app) => {
      app.get('/tenants/t1', async () => ({ ok: true }))
    },
  })

  it('leaves health routes open', async () => {
    assert.equal((await api.inject({ method: 'GET', url: '/healthz' })).statusCode, 200)
    assert.equal((await api.inject({ method: 'GET', url: '/readyz' })).statusCode, 200)
  })

  it('refuses commands without the token', async () => {
    const response = await api.inject({ method: 'GET', url: '/tenants/t1' })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'unauthorized')
  })

  it('accepts commands with the token', async () => {
    const response = await api.inject({ method: 'GET', url: '/tenants/t1', headers: { 'x-internal-token': token } })
    assert.equal(response.statusCode, 200)
  })

  it('refuses a short token at build time', () => {
    assert.throws(() => buildInternalApi({ logger: silentLogger, readiness: async () => report, token: 'short' }), /32 characters/)
  })
})

describe('long handlers over a real socket (trap 44, review M5)', () => {
  it('answers a handler that stays silent longer than the old 10 s idle timeout', { timeout: 30_000 }, async () => {
    const api = buildInternalApi({
      logger: silentLogger,
      readiness: async () => ({ ready: true, draining: false, checks: {} }),
      commands: async (app) => {
        // Stands in for a credential-definition publication: nothing is written until the ledger answers.
        app.post('/slow', async () => {
          await new Promise((resolve) => setTimeout(resolve, 11_000))
          return { published: true }
        })
      },
    })
    const address = await api.listen({ host: '127.0.0.1', port: 0 })
    try {
      const response = await fetch(`${address}/slow`, { method: 'POST', signal: AbortSignal.timeout(25_000) })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { published: true })
    } finally {
      await api.close()
    }
  })
})

describe('command routes (Phase 3 P0)', () => {
  it('register the outbox feed and the tenant/connection detail routes', async () => {
    const { commandRoutes } = await import('../src/http/command-routes.ts')
    const api = buildInternalApi({
      logger: silentLogger,
      readiness: async () => ({ ready: true, draining: false, checks: {} }),
      commands: commandRoutes({ onboarding: {} as never, catalogue: {} as never, exchanges: {} as never, outbox: { db: {} as never } }),
    })
    await api.ready()
    const routes = api.printRoutes()
    for (const expected of ['outbox (GET', '/ack (POST)', ':tenantId (GET', 'onnections (GET']) assert.ok(routes.includes(expected), `${expected} missing from:\n${routes}`)
  })
})
