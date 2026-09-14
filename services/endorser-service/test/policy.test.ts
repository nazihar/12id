import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type EndorsementRequest, type TenantRegistry, checkEndorsement } from '../src/policy.ts'

// Nyms from the T2 run (implement/8-phase-2-findings.md).
const ENDORSER = 'N3YX7unyWS1iSNXeVc4seL'
const TENANT_NYM = 'EAHqZgP3xBtmKuCMe57eWu'
const OTHER_NYM = 'KaZDBincU3GEZYuNeMJH3M'

const tenants: TenantRegistry = {
  nymForTenant: async (tenantId) => (tenantId === 'tenant-a' ? TENANT_NYM : tenantId === 'tenant-b' ? OTHER_NYM : null),
}

const check = (input: Omit<EndorsementRequest, 'tenantId'> & { tenantId?: string }) =>
  checkEndorsement({ tenantId: 'tenant-a', ...input }, ENDORSER, tenants)

// Shapes as Credo builds them (T2 log).
const nymRequest = (overrides: Record<string, unknown> = {}, operation: Record<string, unknown> = {}) =>
  JSON.stringify({ identifier: ENDORSER, operation: { type: '1', dest: TENANT_NYM, verkey: 'x', ...operation }, ...overrides })
const authoredRequest = (type: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ identifier: TENANT_NYM, endorser: ENDORSER, signature: 'sig', operation: { type }, ...overrides })

describe('NYM endorsement', () => {
  it('allows the tenant-built, unsigned, role-less NYM', async () => {
    assert.deepEqual(await check({ kind: 'nym', request: nymRequest() }), {
      allowed: true,
      kind: 'nym',
      author: ENDORSER,
      operationType: '1',
    })
  })

  const refusals: Array<[string, string, RegExp]> = [
    ['a role', nymRequest({}, { role: '101' }), /role-less/],
    ['a trustee role', nymRequest({}, { role: '0' }), /role-less/],
    ['another DID', nymRequest({}, { dest: OTHER_NYM }), /not the DID registered/],
    ['a pre-signed request', nymRequest({ signature: 'x' }), /already signed/],
    ['a foreign author', nymRequest({ identifier: OTHER_NYM }), /endorser name/],
    ['an ATTRIB', nymRequest({}, { type: '100' }), /expected NYM/],
  ]
  for (const [label, request, reason] of refusals) {
    it(`refuses ${label}`, async () => {
      const decision = await check({ kind: 'nym', request })
      assert.equal(decision.allowed, false)
      assert.match((decision as { reason: string }).reason, reason)
    })
  }
})

describe('SCHEMA and CLAIM_DEF endorsement', () => {
  it('allows a schema authored by the tenant', async () => {
    assert.equal((await check({ kind: 'schema', request: authoredRequest('101') })).allowed, true)
  })

  it('allows a cred def authored by the tenant', async () => {
    assert.equal((await check({ kind: 'credentialDefinition', request: authoredRequest('102') })).allowed, true)
  })

  const refusals: Array<[string, EndorsementRequest['kind'], string, RegExp, string?]> = [
    ['a cred def sent as a schema', 'schema', authoredRequest('102'), /expected type 101/],
    ['another tenant as author', 'schema', authoredRequest('101', { identifier: OTHER_NYM }), /not the DID registered/],
    ['a request for a tenant it does not belong to', 'schema', authoredRequest('101'), /not the DID registered/, 'tenant-b'],
    ['a different endorser', 'schema', authoredRequest('101', { endorser: OTHER_NYM }), /our endorser/],
    ['a missing author signature', 'credentialDefinition', authoredRequest('102', { signature: undefined }), /signature missing/],
    ['an already multi-signed request', 'schema', authoredRequest('101', { signatures: { a: 'b' } }), /multi-signed/],
    ['an unknown tenant', 'schema', authoredRequest('101'), /no registered DID/, 'tenant-x'],
    ['non-JSON', 'schema', 'not json', /not a ledger request/],
  ]
  for (const [label, kind, request, reason, tenantId] of refusals) {
    it(`refuses ${label}`, async () => {
      // Spreading `tenantId: undefined` would override the default tenant, so only pass it when set.
      const decision = await check({ kind, request, ...(tenantId ? { tenantId } : {}) })
      assert.equal(decision.allowed, false)
      assert.match((decision as { reason: string }).reason, reason)
    })
  }
})
