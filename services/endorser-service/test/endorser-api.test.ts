import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'

import { INTERNAL_TOKEN_HEADER } from '@12id/credo-base/endorsement-contract.ts'
import { pino } from 'pino'

import type { BindResult, TenantBindings } from '../src/db/bindings.ts'
import { type AuditEntry, buildEndorserApi } from '../src/http/endorser-api.ts'

const ENDORSER = 'N3YX7unyWS1iSNXeVc4seL'
const TENANT_NYM = 'EAHqZgP3xBtmKuCMe57eWu'
const OTHER_NYM = 'KaZDBincU3GEZYuNeMJH3M'
const TOKEN = 't'.repeat(40)

const silent = pino({ level: 'silent' }, new Writable({ write: (_c, _e, cb) => cb() }))

function memoryBindings(initial: Record<string, string> = {}): TenantBindings {
  const map = new Map(Object.entries(initial))
  return {
    nymForTenant: async (tenantId) => map.get(tenantId) ?? null,
    bind: async (tenantId, nym): Promise<BindResult> => {
      const existing = map.get(tenantId)
      if (existing === nym) return { result: 'already_bound', nym }
      if (existing) return { result: 'conflict', reason: 'tenant is already bound to a different nym' }
      if ([...map.values()].includes(nym)) return { result: 'conflict', reason: 'nym is bound to another tenant' }
      map.set(tenantId, nym)
      return { result: 'bound', nym }
    },
  }
}

function setup(overrides: { bindings?: TenantBindings; auditFails?: boolean } = {}) {
  const audit: AuditEntry[] = []
  const signed: string[] = []
  const api = buildEndorserApi({
    logger: silent,
    token: TOKEN,
    endorserNym: ENDORSER,
    bindings: overrides.bindings ?? memoryBindings({ 'tenant-a': TENANT_NYM }),
    sign: async (request) => {
      signed.push(request)
      return `${request}#signed`
    },
    audit: {
      record: async (entry) => {
        if (overrides.auditFails) throw new Error('audit database down')
        audit.push(entry)
      },
    },
  })
  return { api, audit, signed }
}

const auth = { [INTERNAL_TOKEN_HEADER]: TOKEN }
const schemaRequest = JSON.stringify({ identifier: TENANT_NYM, endorser: ENDORSER, signature: 'sig', operation: { type: '101' } })

describe('authentication', () => {
  it('health needs no token; everything else does', async () => {
    const { api } = setup()
    assert.equal((await api.inject({ method: 'GET', url: '/healthz' })).statusCode, 200)
    const missing = await api.inject({ method: 'POST', url: '/endorse', payload: {} })
    assert.equal(missing.statusCode, 401)
    const wrong = await api.inject({ method: 'POST', url: '/endorse', payload: {}, headers: { [INTERNAL_TOKEN_HEADER]: 'x'.repeat(40) } })
    assert.equal(wrong.statusCode, 401)
    await api.close()
  })

  it('refuses to start with a short token', () => {
    assert.throws(() =>
      buildEndorserApi({ logger: silent, token: 'short', endorserNym: ENDORSER, bindings: memoryBindings(), sign: async (r) => r, audit: { record: async () => undefined } })
    )
  })
})

describe('POST /tenants/bind', () => {
  it('binds once, then reports already_bound, and refuses a rebind', async () => {
    const { api } = setup({ bindings: memoryBindings() })
    const first = await api.inject({ method: 'POST', url: '/tenants/bind', headers: auth, payload: { tenantId: 'tenant-a', nym: TENANT_NYM } })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().result, 'bound')
    const again = await api.inject({ method: 'POST', url: '/tenants/bind', headers: auth, payload: { tenantId: 'tenant-a', nym: TENANT_NYM } })
    assert.equal(again.json().result, 'already_bound')
    const rebind = await api.inject({ method: 'POST', url: '/tenants/bind', headers: auth, payload: { tenantId: 'tenant-a', nym: OTHER_NYM } })
    assert.equal(rebind.statusCode, 409)
    await api.close()
  })

  it('validates the nym format', async () => {
    const { api } = setup()
    const response = await api.inject({ method: 'POST', url: '/tenants/bind', headers: auth, payload: { tenantId: 'tenant-a', nym: 'not-a-nym' } })
    assert.equal(response.statusCode, 400)
    await api.close()
  })
})

describe('error responses', () => {
  it('a database failure returns a generic 500 without the SQL text', async () => {
    const failing: TenantBindings = {
      nymForTenant: async () => null,
      bind: async () => {
        throw new Error('Failed query: insert into "tenant_bindings" ("tenant_id", "nym") values ($1, $2)\nparams: tenant-a,EAHqZgP3xBtmKuCMe57eWu')
      },
    }
    const { api } = setup({ bindings: failing })
    const response = await api.inject({ method: 'POST', url: '/tenants/bind', headers: auth, payload: { tenantId: 'tenant-a', nym: TENANT_NYM } })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), { error: 'internal', reason: 'internal error' })
    assert.doesNotMatch(response.body, /Failed query|tenant_bindings|params/)
    await api.close()
  })
})

describe('postgresErrorCode', () => {
  it('reads the SQLSTATE from pg errors and from drizzle-wrapped errors', async () => {
    const { postgresErrorCode } = await import('@12id/credo-base/fastify-errors.ts')
    assert.equal(postgresErrorCode({ code: '23505' }), '23505')
    assert.equal(postgresErrorCode(Object.assign(new Error('Failed query'), { cause: { code: '23505' } })), '23505')
    assert.equal(postgresErrorCode(new Error('plain')), undefined)
  })
})

describe('POST /endorse', () => {
  it('signs an allowed request and audits it', async () => {
    const { api, audit, signed } = setup()
    const response = await api.inject({ method: 'POST', url: '/endorse', headers: auth, payload: { tenantId: 'tenant-a', kind: 'schema', request: schemaRequest } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().endorsedRequest, `${schemaRequest}#signed`)
    assert.equal(signed.length, 1)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].allowed, true)
    assert.equal(audit[0].operationType, '101')
    assert.match(audit[0].requestSha256, /^[0-9a-f]{64}$/)
    await api.close()
  })

  it('refuses a disallowed request without signing, and audits the refusal', async () => {
    const { api, audit, signed } = setup()
    const nymWithRole = JSON.stringify({ identifier: ENDORSER, operation: { type: '1', dest: TENANT_NYM, role: '101' } })
    const response = await api.inject({ method: 'POST', url: '/endorse', headers: auth, payload: { tenantId: 'tenant-a', kind: 'nym', request: nymWithRole } })
    assert.equal(response.statusCode, 403)
    assert.match(response.json().reason, /role-less/)
    assert.equal(signed.length, 0)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].allowed, false)
    await api.close()
  })

  it('does not release a signature when the audit write fails', async () => {
    const { api } = setup({ auditFails: true })
    const response = await api.inject({ method: 'POST', url: '/endorse', headers: auth, payload: { tenantId: 'tenant-a', kind: 'schema', request: schemaRequest } })
    assert.equal(response.statusCode, 500)
    assert.doesNotMatch(response.body, /#signed/)
    await api.close()
  })

  it('rejects an unknown kind before any policy check', async () => {
    const { api, audit } = setup()
    const response = await api.inject({ method: 'POST', url: '/endorse', headers: auth, payload: { tenantId: 'tenant-a', kind: 'attrib', request: schemaRequest } })
    assert.equal(response.statusCode, 400)
    assert.equal(audit.length, 0)
    await api.close()
  })
})
