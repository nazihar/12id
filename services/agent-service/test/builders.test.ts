import '@12id/credo-base/bindings.ts'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ExchangeInputError, buildOfferAttributes, buildProofRequest } from '../src/exchanges/builders.ts'

const NOW = 1_789_000_000
const SCHEMA = ['name', 'employeeNumber', 'department', 'expiresAt']
const CRED_DEF_V1 = 'UmRpa6MPX6XDMqmmxhiCwB:3:CL:59:default'
const CRED_DEF_V11 = 'UmRpa6MPX6XDMqmmxhiCwB:3:CL:62:default'

describe('buildOfferAttributes', () => {
  const values = { department: 'Engines', name: 'Ada', employeeNumber: '1815', expiresAt: String(NOW + 3600) }

  it('returns values in schema order', () => {
    assert.deepEqual(
      buildOfferAttributes(SCHEMA, values, NOW).map((a) => a.name),
      SCHEMA
    )
  })

  it('refuses missing and extra attributes', () => {
    const { department: _d, ...missing } = values
    assert.throws(() => buildOfferAttributes(SCHEMA, missing, NOW), /missing attributes: department/)
    assert.throws(() => buildOfferAttributes(SCHEMA, { ...values, salary: '1' }, NOW), /not in the schema: salary/)
  })

  it('refuses a non-integer or past expiry', () => {
    assert.throws(() => buildOfferAttributes(SCHEMA, { ...values, expiresAt: '2030-01-01' }, NOW), /epoch seconds/)
    assert.throws(() => buildOfferAttributes(SCHEMA, { ...values, expiresAt: String(NOW - 1) }, NOW), /not in the future/)
  })

  it('refuses an expiry past the 32-bit limit, which every proof would fail', () => {
    assert.throws(() => buildOfferAttributes(SCHEMA, { ...values, expiresAt: '2147483648' }, NOW), /at most 2147483647/)
    assert.equal(buildOfferAttributes(SCHEMA, { ...values, expiresAt: '2147483647' }, NOW).at(-1)?.value, '2147483647')
  })
})

describe('buildProofRequest', () => {
  it('restricts every group to unqualified cred defs and adds the expiry predicate', () => {
    const request = buildProofRequest(
      'employment',
      [{ key: 'employee', attributes: ['name'], credentialDefinitionIds: [CRED_DEF_V1, CRED_DEF_V11] }],
      NOW
    )
    assert.deepEqual(request.requested_attributes.employee.restrictions, [{ cred_def_id: CRED_DEF_V1 }, { cred_def_id: CRED_DEF_V11 }])
    assert.deepEqual(request.requested_predicates.employee_not_expired, {
      name: 'expiresAt',
      p_type: '>=',
      p_value: NOW,
      restrictions: [{ cred_def_id: CRED_DEF_V1 }, { cred_def_id: CRED_DEF_V11 }],
    })
  })

  it('rejects qualified cred def ids', () => {
    assert.throws(
      () =>
        buildProofRequest(
          'x',
          [{ key: 'g', attributes: ['name'], credentialDefinitionIds: ['did:indy:twelveid:staging:UmRpa6MPX6XDMqmmxhiCwB/anoncreds/v0/CLAIM_DEF/59/default'] }],
          NOW
        ),
      /qualified did:indy form is rejected/
    )
  })

  it('does not let a caller replace the expiry check', () => {
    assert.throws(
      () =>
        buildProofRequest('x', [{ key: 'g', attributes: [], credentialDefinitionIds: [CRED_DEF_V1], predicates: [{ name: 'expiresAt', type: '>=', value: 0 }] }], NOW),
      ExchangeInputError
    )
  })

  it('refuses revealing an attribute that is also predicated (AnonCreds duplicate rule)', () => {
    assert.throws(
      () => buildProofRequest('x', [{ key: 'g', attributes: ['employeeNumber'], credentialDefinitionIds: [CRED_DEF_V1], predicates: [{ name: 'employeeNumber', type: '>', value: 1 }] }], NOW),
      /both revealed and used in a predicate: employeeNumber/
    )
    assert.throws(() => buildProofRequest('x', [{ key: 'g', attributes: ['expiresAt'], credentialDefinitionIds: [CRED_DEF_V1] }], NOW), /expiresAt/)
  })

  it('adds caller predicates next to the expiry check', () => {
    const request = buildProofRequest(
      'x',
      [{ key: 'g', attributes: [], credentialDefinitionIds: [CRED_DEF_V1], predicates: [{ name: 'employeeNumber', type: '>', value: 1000 }] }],
      NOW
    )
    assert.deepEqual(Object.keys(request.requested_predicates).sort(), ['g_employeeNumber', 'g_not_expired'])
  })
})
