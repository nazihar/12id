import '@12id/credo-base/bindings.ts'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ExchangeInputError, buildOfferAttributes, buildProofRequest, isCalendarDate, utcDateNumber } from '../src/exchanges/builders.ts'

// 2026-09-10T00:26:40Z
const NOW = 1_789_000_000
const TODAY = 20260910
const SCHEMA = ['name', 'employeeNumber', 'department', 'expiresOn']
const CRED_DEF_V1 = 'UmRpa6MPX6XDMqmmxhiCwB:3:CL:59:default'
const CRED_DEF_V11 = 'UmRpa6MPX6XDMqmmxhiCwB:3:CL:62:default'

describe('buildOfferAttributes', () => {
  const values = { department: 'Engines', name: 'Ada', employeeNumber: '1815', expiresOn: '20301231' }

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

  it('refuses an expiry that is not a YYYYMMDD calendar date', () => {
    for (const bad of ['2030-12-31', '1789000000', '2030123', '20301301', '20300230', 'tomorrow']) {
      assert.throws(() => buildOfferAttributes(SCHEMA, { ...values, expiresOn: bad }, NOW), /YYYYMMDD/, bad)
    }
  })

  it('accepts today and later, refuses yesterday', () => {
    assert.equal(buildOfferAttributes(SCHEMA, { ...values, expiresOn: String(TODAY) }, NOW).at(-1)?.value, '20260910')
    assert.throws(() => buildOfferAttributes(SCHEMA, { ...values, expiresOn: '20260909' }, NOW), /in the past/)
  })

  it('accepts validity far past 2038, the old epoch-seconds limit', () => {
    assert.equal(buildOfferAttributes(SCHEMA, { ...values, expiresOn: '20991231' }, NOW).at(-1)?.value, '20991231')
    assert.equal(buildOfferAttributes(SCHEMA, { ...values, expiresOn: '99991231' }, NOW).at(-1)?.value, '99991231')
  })
})

describe('expiry dates', () => {
  it('uses the UTC day', () => {
    assert.equal(utcDateNumber(NOW), TODAY)
    assert.equal(utcDateNumber(Date.UTC(2026, 9, 6, 23, 59, 59) / 1000), 20261006)
    assert.equal(utcDateNumber(Date.UTC(2026, 9, 7, 0, 0, 0) / 1000), 20261007)
  })

  it('knows real calendar dates, leap years included', () => {
    assert.equal(isCalendarDate('20280229'), true)
    assert.equal(isCalendarDate('20270229'), false)
    assert.equal(isCalendarDate('20261131'), false)
    assert.equal(isCalendarDate('09991231'), false)
  })

  it('fits the 32-bit integers AnonCreds predicates compare', () => {
    assert.ok(Number('99991231') < 2_147_483_647)
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
      name: 'expiresOn',
      p_type: '>=',
      p_value: TODAY,
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
        buildProofRequest('x', [{ key: 'g', attributes: [], credentialDefinitionIds: [CRED_DEF_V1], predicates: [{ name: 'expiresOn', type: '>=', value: 0 }] }], NOW),
      ExchangeInputError
    )
  })

  it('refuses revealing an attribute that is also predicated (AnonCreds duplicate rule)', () => {
    assert.throws(
      () => buildProofRequest('x', [{ key: 'g', attributes: ['employeeNumber'], credentialDefinitionIds: [CRED_DEF_V1], predicates: [{ name: 'employeeNumber', type: '>', value: 1 }] }], NOW),
      /both revealed and used in a predicate: employeeNumber/
    )
    assert.throws(() => buildProofRequest('x', [{ key: 'g', attributes: ['expiresOn'], credentialDefinitionIds: [CRED_DEF_V1] }], NOW), /expiresOn/)
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
