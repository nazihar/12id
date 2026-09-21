/**
 * Biometric gate policy (Phase 6 B3). A tenant has one default policy; a credential definition or
 * a proof template may override it. Thresholds are normalized 0–100 scores.
 *
 *   tenant default   { required, minMatchScore, minLivenessScore, maxAttempts, ttlMinutes }
 *   override         { mode: 'inherit' }                      → the default decides
 *                    { mode: 'off' }                          → never gated
 *                    { mode: 'required', ...partial numbers } → gated; missing numbers from the default
 *
 * Nothing is gated unless the tenant has switched biometrics on.
 */
import { z } from 'zod'

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
