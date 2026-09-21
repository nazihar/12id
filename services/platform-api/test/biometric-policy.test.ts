import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_POLICY, resolvePolicy } from '../src/biometric/policy.ts'

const on = (overrides: Partial<typeof DEFAULT_POLICY> = {}) => ({ enabled: true, defaultPolicy: { ...DEFAULT_POLICY, ...overrides } })

describe('biometric policy resolution', () => {
  it('never gates while the tenant has biometrics off', () => {
    assert.equal(resolvePolicy(null, { mode: 'required' }), null)
    assert.equal(resolvePolicy({ enabled: false, defaultPolicy: { ...DEFAULT_POLICY, required: true } }, { mode: 'required' }), null)
  })

  it('inherit follows the tenant default', () => {
    assert.equal(resolvePolicy(on({ required: false }), null), null)
    assert.equal(resolvePolicy(on({ required: false }), { mode: 'inherit' }), null)
    assert.deepEqual(resolvePolicy(on({ required: true }), undefined), { minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3, ttlMinutes: 30 })
  })

  it('off wins over a required default; required wins over an optional one', () => {
    assert.equal(resolvePolicy(on({ required: true }), { mode: 'off' }), null)
    assert.deepEqual(resolvePolicy(on({ required: false, minMatchScore: 80 }), { mode: 'required', maxAttempts: 1 }), { minMatchScore: 80, minLivenessScore: 90, maxAttempts: 1, ttlMinutes: 30 })
  })

  it('rejects out-of-range overrides', () => {
    assert.throws(() => resolvePolicy(on(), { mode: 'required', minMatchScore: 101 }))
    assert.throws(() => resolvePolicy(on(), { mode: 'sometimes' }))
  })
})
