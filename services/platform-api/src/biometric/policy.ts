/**
 * Biometric gate policy (Phase 6 B3). A tenant has one default policy; a credential definition or
 * a proof template may override it. Thresholds are normalized 0–100 scores.
 *
 *   tenant default   { required, minMatchScore, minLivenessScore, maxAttempts, ttlMinutes }
 *   override         { mode: 'inherit' }                      → the default decides
 *                    { mode: 'off' }                          → never gated
 *                    { mode: 'required', ...partial numbers } → gated; missing numbers from the default
 *
 * A proof template has one more choice (conditional gate, 2026-10-11):
 *
 *   override         { mode: 'conditional', when: { match: 'any'|'all', conditions: [{ param, op, value }] }, ...partial numbers }
 *                    → gated when the rule holds for the numbers sent with the proof request
 *
 * The parameters are the organisation's own (an amount, a risk score, 1/0 for a yes/no fact); the
 * platform attaches no meaning to them. Every parameter the rule names must be sent, or the request
 * is refused: a backend that forgets one must not get an unchecked exchange.
 *
 * Nothing is gated unless the tenant has switched biometrics on.
 */
import { z } from 'zod'

import { PlatformError } from '../http/errors.ts'

const score = z.number().min(0).max(100)
const attempts = z.number().int().min(1).max(5)
const ttlMinutes = z.number().int().min(5).max(1440)

export const biometricDefaultPolicy = z.object({
  required: z.boolean(),
  minMatchScore: score,
  minLivenessScore: score,
  maxAttempts: attempts,
  ttlMinutes,
})
export type BiometricDefaultPolicy = z.infer<typeof biometricDefaultPolicy>

export const DEFAULT_POLICY: BiometricDefaultPolicy = { required: false, minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3, ttlMinutes: 30 }

export const biometricOverride = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }),
  z.object({ mode: z.literal('off') }),
  z.object({
    mode: z.literal('required'),
    minMatchScore: score.optional(),
    minLivenessScore: score.optional(),
    maxAttempts: attempts.optional(),
    ttlMinutes: ttlMinutes.optional(),
  }),
])
export type BiometricOverride = z.infer<typeof biometricOverride>

export const CONDITION_OPS = ['gte', 'gt', 'lte', 'lt'] as const
export const MAX_CONDITIONS = 5
export const conditionParam = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'a parameter name starts with a letter and has up to 40 letters, digits or underscores')
const condition = z.object({ param: conditionParam, op: z.enum(CONDITION_OPS), value: z.number() })
export const biometricWhen = z.object({
  match: z.enum(['any', 'all']).describe('`any`: the check applies when at least one condition holds; `all`: only when every condition holds.'),
  conditions: z.array(condition).min(1).max(MAX_CONDITIONS),
})
export type BiometricWhen = z.infer<typeof biometricWhen>

/** A proof template's override: the three modes above, or `conditional`. Credential definitions keep `biometricOverride`. */
export const templateBiometricOverride = z.discriminatedUnion('mode', [
  ...biometricOverride.options,
  z.object({
    mode: z.literal('conditional'),
    when: biometricWhen,
    minMatchScore: score.optional(),
    minLivenessScore: score.optional(),
    maxAttempts: attempts.optional(),
    ttlMinutes: ttlMinutes.optional(),
  }),
])
export type TemplateBiometricOverride = z.infer<typeof templateBiometricOverride>

/**
 * What a conditional rule decided for one proof request, kept with the exchange (`proofs.biometric_condition`):
 * the rule as it was then, the number sent for each condition, and the decision. `input` is null
 * once the exchange's personal data is erased.
 */
export const conditionOutcome = z.object({
  match: biometricWhen.shape.match,
  required: z.boolean(),
  conditions: z.array(condition.extend({ input: z.number().nullable(), met: z.boolean() })),
})
export type ConditionOutcome = z.infer<typeof conditionOutcome>

const COMPARE: Record<(typeof CONDITION_OPS)[number], (input: number, value: number) => boolean> = {
  gte: (input, value) => input >= value,
  gt: (input, value) => input > value,
  lte: (input, value) => input <= value,
  lt: (input, value) => input < value,
}

/** Applies a rule to the numbers of one request. 422 when a parameter the rule names was not sent. */
export function evaluateWhen(when: BiometricWhen, params: Record<string, number> | undefined): ConditionOutcome {
  const sent = params ?? {}
  const missing = [...new Set(when.conditions.map((c) => c.param).filter((param) => !Object.hasOwn(sent, param)))]
  if (missing.length > 0) {
    throw new PlatformError(422, 'biometric_param_required', `this template decides the biometric check from ${missing.join(', ')}: send ${missing.length === 1 ? 'it as a number' : 'them as numbers'} in biometric.params`)
  }
  const conditions = when.conditions.map((c) => ({ ...c, input: sent[c.param]!, met: COMPARE[c.op](sent[c.param]!, c.value) }))
  const required = when.match === 'any' ? conditions.some((c) => c.met) : conditions.every((c) => c.met)
  return { match: when.match, required, conditions }
}

export interface EffectivePolicy {
  minMatchScore: number
  minLivenessScore: number
  maxAttempts: number
  ttlMinutes: number
}

/** The policy that applies, or null when the exchange is not gated. */
export function resolvePolicy(settings: { enabled: boolean; defaultPolicy: unknown } | null | undefined, override: unknown): EffectivePolicy | null {
  if (!settings?.enabled) return null
  const base = biometricDefaultPolicy.catch(DEFAULT_POLICY).parse(settings.defaultPolicy)
  const parsed = override === null || override === undefined ? { mode: 'inherit' as const } : biometricOverride.parse(override)
  if (parsed.mode === 'off') return null
  if (parsed.mode === 'inherit' && !base.required) return null
  const pick = <K extends keyof EffectivePolicy>(key: K) => (parsed.mode === 'required' ? parsed[key] : undefined) ?? base[key]
  return { minMatchScore: pick('minMatchScore'), minLivenessScore: pick('minLivenessScore'), maxAttempts: pick('maxAttempts'), ttlMinutes: pick('ttlMinutes') }
}
