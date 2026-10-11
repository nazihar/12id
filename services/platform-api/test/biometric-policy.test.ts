import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type BiometricWhen, type CONDITION_OPS, DEFAULT_POLICY, biometricOverride, evaluateWhen, resolvePolicy, templateBiometricOverride } from '../src/biometric/policy.ts'
import type { PlatformError } from '../src/http/errors.ts'

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

describe('conditional biometric rule', () => {
  const when = (match: 'any' | 'all', ...conditions: Array<[string, (typeof CONDITION_OPS)[number], number]>): BiometricWhen => ({ match, conditions: conditions.map(([param, op, value]) => ({ param, op, value })) })
  const required = (rule: BiometricWhen, params: Record<string, number>) => evaluateWhen(rule, params).required

  it('compares at, below and above the value for each operator', () => {
    const at = (op: (typeof CONDITION_OPS)[number]) => [4999.99, 5000, 5000.01].map((amount) => required(when('any', ['amount', op, 5000]), { amount }))
    assert.deepEqual(at('gte'), [false, true, true])
    assert.deepEqual(at('gt'), [false, false, true])
    assert.deepEqual(at('lte'), [true, true, false])
    assert.deepEqual(at('lt'), [true, false, false])
  })

  it('any: one true condition is enough; all: every condition must hold', () => {
    const any = when('any', ['amount', 'gte', 5000], ['riskScore', 'gt', 70])
    assert.equal(required(any, { amount: 3000, riskScore: 20 }), false)
    assert.equal(required(any, { amount: 3000, riskScore: 85 }), true)
    assert.equal(required(any, { amount: 7200, riskScore: 20 }), true)

    const all = when('all', ['amount', 'gte', 5000], ['accountAgeDays', 'lt', 30])
    assert.equal(required(all, { amount: 7200, accountAgeDays: 400 }), false)
    assert.equal(required(all, { amount: 3000, accountAgeDays: 5 }), false)
    assert.equal(required(all, { amount: 7200, accountAgeDays: 5 }), true)
  })

  it('the same parameter twice makes a range; yes/no facts are sent as 1 or 0', () => {
    const range = when('all', ['amount', 'gte', 5000], ['amount', 'lt', 10000])
    assert.deepEqual([4000, 5000, 9999, 10000].map((amount) => required(range, { amount })), [false, true, true, false])
    assert.deepEqual([0, 1].map((newDevice) => required(when('any', ['newDevice', 'gte', 1]), { newDevice })), [false, true])
  })

  it('records the rule, each number sent and whether it was met', () => {
    assert.deepEqual(evaluateWhen(when('any', ['amount', 'gte', 5000], ['riskScore', 'gt', 70]), { amount: 7200, riskScore: 20, ignored: 1 }), {
      match: 'any',
      required: true,
      conditions: [
        { param: 'amount', op: 'gte', value: 5000, input: 7200, met: true },
        { param: 'riskScore', op: 'gt', value: 70, input: 20, met: false },
      ],
    })
  })

  it('refuses a request that lacks a parameter the rule names, even when another condition already holds', () => {
    const rule = when('any', ['amount', 'gte', 5000], ['riskScore', 'gt', 70])
    const refused = (params?: Record<string, number>) => {
      try {
        evaluateWhen(rule, params)
      } catch (error) {
        return error as PlatformError
      }
      return assert.fail('expected a refusal')
    }
    assert.deepEqual([refused({ amount: 9000 }).status, refused({ amount: 9000 }).code], [422, 'biometric_param_required'])
    assert.match(refused({ amount: 9000 }).message, /riskScore/)
    assert.match(refused(undefined).message, /amount, riskScore/)
    // An inherited property is not a parameter that was sent.
    assert.match(refused(Object.create({ amount: 1, riskScore: 1 }) as Record<string, number>).message, /amount, riskScore/)
  })

  it('accepts 1 to 5 conditions on proof templates only', () => {
    const policy = (conditions: unknown[]) => ({ mode: 'conditional', when: { match: 'any', conditions } })
    const one = { param: 'amount', op: 'gte', value: 5000 }
    assert.equal(templateBiometricOverride.safeParse(policy([one])).success, true)
    assert.equal(templateBiometricOverride.safeParse({ ...policy([one]), minMatchScore: 95, maxAttempts: 1 }).success, true)
    assert.equal(templateBiometricOverride.safeParse(policy(Array(5).fill(one))).success, true)
    assert.equal(templateBiometricOverride.safeParse(policy([])).success, false)
    assert.equal(templateBiometricOverride.safeParse(policy(Array(6).fill(one))).success, false)
    assert.equal(templateBiometricOverride.safeParse(policy([{ ...one, op: 'eq' }])).success, false)
    assert.equal(templateBiometricOverride.safeParse(policy([{ ...one, param: '2fast' }])).success, false)
    assert.equal(templateBiometricOverride.safeParse(policy([{ ...one, value: Number.POSITIVE_INFINITY }])).success, false)
    assert.equal(templateBiometricOverride.safeParse({ mode: 'conditional', when: { match: 'either', conditions: [one] } }).success, false)
    // The three earlier modes still parse; a credential definition cannot be conditional.
    assert.equal(templateBiometricOverride.safeParse({ mode: 'required', minMatchScore: 95 }).success, true)
    assert.equal(biometricOverride.safeParse(policy([one])).success, false)
  })
})
