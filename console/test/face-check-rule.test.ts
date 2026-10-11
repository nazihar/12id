/** The conditional face-check rule of a proof template: what the policy form accepts, what it saves, and how a rule reads. */
import { describe, expect, it } from 'vitest'

import { biometricOverride, templateBiometricOverride, templateOverrideForm, toTemplateOverride, toTemplateOverrideForm } from '../src/features/portal/biometrics.schemas'
import { describeRule } from '../src/lib/face-check-rule'

const NUMBERS = { minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3 }
const form = (extra: Record<string, unknown> = {}) => ({ mode: 'conditional', ...NUMBERS, match: 'any', conditions: [{ param: 'amount', op: 'gte', value: 5000 }], ...extra })
const paths = (value: unknown) => {
  const result = templateOverrideForm.safeParse(value)
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
}

describe('conditional face-check rule', () => {
  it('reads as words', () => {
    expect(describeRule({ match: 'any', conditions: [{ param: 'amount', op: 'gte', value: 5000 }, { param: 'riskScore', op: 'gt', value: 0.7 }] })).toBe('amount ≥ 5000 or riskScore > 0.7')
    expect(describeRule({ match: 'all', conditions: [{ param: 'amount', op: 'lte', value: 10 }, { param: 'accountAgeDays', op: 'lt', value: 30 }] })).toBe('amount ≤ 10 and accountAgeDays < 30')
  })

  it('places each problem on the line it concerns', () => {
    expect(paths(form())).toEqual([])
    expect(paths(form({ conditions: [] }))).toEqual(['conditions: Add at least one condition.'])
    expect(paths(form({ conditions: [{ param: '', op: 'gte', value: Number.NaN }, { param: '2fast', op: 'lt', value: 1 }] }))).toEqual([
      'conditions.0.param: Name the parameter.',
      'conditions.0.value: Enter a number.',
      'conditions.1.param: Start with a letter; then letters, digits or _ (up to 40 characters).',
    ])
    expect(paths(form({ conditions: Array(6).fill({ param: 'amount', op: 'gte', value: 1 }) }))).toEqual(['conditions: Use at most 5 conditions.'])
  })

  it('does not check a half-typed rule once another mode is chosen', () => {
    expect(paths(form({ mode: 'off', conditions: [{ param: '', op: 'gte', value: Number.NaN }] }))).toEqual([])
    expect(toTemplateOverride(templateOverrideForm.parse(form({ mode: 'off', conditions: [{ param: '', op: 'gte', value: Number.NaN }] })))).toEqual({ mode: 'off' })
  })

  it('saves what platform-api accepts and loads it back', () => {
    const saved = toTemplateOverride(templateOverrideForm.parse(form({ match: 'all', conditions: [{ param: ' amount ', op: 'gte', value: 5000.5 }, { param: 'newDevice', op: 'gte', value: 1 }] })))
    expect(saved).toEqual({ mode: 'conditional', when: { match: 'all', conditions: [{ param: 'amount', op: 'gte', value: 5000.5 }, { param: 'newDevice', op: 'gte', value: 1 }] }, ...NUMBERS })
    expect(templateBiometricOverride.safeParse(saved).success).toBe(true)
    expect(biometricOverride.safeParse(saved).success, 'a credential definition takes no rule').toBe(false)
    expect(toTemplateOverrideForm(templateBiometricOverride.parse(saved), NUMBERS)).toEqual({ mode: 'conditional', ...NUMBERS, match: 'all', conditions: saved.mode === 'conditional' ? saved.when.conditions : [] })
  })

  it('keeps the three earlier modes as they were', () => {
    expect(toTemplateOverrideForm({ mode: 'required', minMatchScore: 95 }, NUMBERS)).toEqual({ mode: 'required', ...NUMBERS, minMatchScore: 95, match: 'any', conditions: [] })
    expect(toTemplateOverrideForm(undefined, NUMBERS).mode).toBe('inherit')
    expect(toTemplateOverride(templateOverrideForm.parse({ mode: 'required', ...NUMBERS, match: 'any', conditions: [] }))).toEqual({ mode: 'required', ...NUMBERS })
  })
})
