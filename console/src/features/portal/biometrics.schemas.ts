/**
 * Client-safe schemas for the biometric gate (Phase 6): the tenant default policy, per credential
 * definition / template overrides, and the provider form. Mirrors platform-api's biometric/policy.ts.
 */
import { z } from 'zod'

const score = z.number({ error: 'Enter a number from 0 to 100.' }).min(0, 'At least 0.').max(100, 'At most 100.')
const attempts = z.number({ error: 'Enter a number from 1 to 5.' }).int().min(1, 'At least 1.').max(5, 'At most 5.')
const ttlMinutes = z.number({ error: 'Enter minutes (5–1440).' }).int().min(5, 'At least 5 minutes.').max(1440, 'At most a day.')

export const biometricDefaultPolicy = z.object({
  required: z.boolean(),
  minMatchScore: score,
  minLivenessScore: score,
  maxAttempts: attempts,
  ttlMinutes,
})
export type BiometricDefaultPolicy = z.infer<typeof biometricDefaultPolicy>

export const biometricSettingsInput = z.object({ enabled: z.boolean(), defaultPolicy: biometricDefaultPolicy })

export const BIOMETRIC_MODES = ['inherit', 'off', 'required'] as const
export type BiometricMode = (typeof BIOMETRIC_MODES)[number]

export const biometricOverride = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }),
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('required'), minMatchScore: score.optional(), minLivenessScore: score.optional(), maxAttempts: attempts.optional(), ttlMinutes: ttlMinutes.optional() }),
])
export type BiometricOverride = z.infer<typeof biometricOverride>

/** What the override form holds: every number present, used only when mode is `required`. */
export const biometricOverrideForm = z.object({ mode: z.enum(BIOMETRIC_MODES), minMatchScore: score, minLivenessScore: score, maxAttempts: attempts })
export type BiometricOverrideForm = z.input<typeof biometricOverrideForm>

export function toOverride(form: z.output<typeof biometricOverrideForm>): BiometricOverride {
  if (form.mode !== 'required') return { mode: form.mode }
  return { mode: 'required', minMatchScore: form.minMatchScore, minLivenessScore: form.minLivenessScore, maxAttempts: form.maxAttempts }
}

export function toOverrideForm(policy: BiometricOverride | undefined, defaults: { minMatchScore: number; minLivenessScore: number; maxAttempts: number }): BiometricOverrideForm {
  const numbers: { minMatchScore?: number; minLivenessScore?: number; maxAttempts?: number } = policy?.mode === 'required' ? policy : {}
  return {
    mode: policy?.mode ?? 'inherit',
    minMatchScore: numbers.minMatchScore ?? defaults.minMatchScore,
    minLivenessScore: numbers.minLivenessScore ?? defaults.minLivenessScore,
    maxAttempts: numbers.maxAttempts ?? defaults.maxAttempts,
  }
}

export const MODE_OPTIONS = [
  { value: 'inherit' as const, label: 'Organization default' },
  { value: 'required' as const, label: 'Always require a face check' },
  { value: 'off' as const, label: 'Never require a face check' },
]

/** Provider form: string fields generated from the provider's JSON Schema. */
export const biometricProviderInput = z.object({ providerId: z.string().min(1).max(100), config: z.record(z.string(), z.string().trim().min(1, 'Required.')) })
export type BiometricProviderInput = z.infer<typeof biometricProviderInput>

export const DEFAULT_POLICY: BiometricDefaultPolicy = { required: false, minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3, ttlMinutes: 30 }
