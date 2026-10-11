/**
 * Client-safe schemas for the biometric gate (Phase 6): the tenant default policy, per credential
 * definition / template overrides, and the provider form. Mirrors platform-api's biometric/policy.ts.
 */
import { z } from 'zod'

import { CONDITION_MATCHES, CONDITION_OPS, CONDITION_OP_SYMBOLS } from '@/lib/face-check-rule'

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

// --- conditional rule (proof templates only) -------------------------------------------------
// A face check only when a rule holds for numbers the organisation's backend sends with the proof
// request (`biometric.params`), e.g. amount >= 5000. Mirrors `templateBiometricOverride` in platform-api.

export const MAX_CONDITIONS = 5
const PARAM_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const PARAM_MESSAGE = 'Start with a letter; then letters, digits or _ (up to 40 characters).'

const condition = z.object({ param: z.string().regex(PARAM_PATTERN, PARAM_MESSAGE), op: z.enum(CONDITION_OPS), value: z.number() })
export const biometricWhen = z.object({ match: z.enum(CONDITION_MATCHES), conditions: z.array(condition).min(1).max(MAX_CONDITIONS) })
export type BiometricWhen = z.infer<typeof biometricWhen>

export const templateBiometricOverride = z.discriminatedUnion('mode', [
  ...biometricOverride.options,
  z.object({ mode: z.literal('conditional'), when: biometricWhen, minMatchScore: score.optional(), minLivenessScore: score.optional(), maxAttempts: attempts.optional(), ttlMinutes: ttlMinutes.optional() }),
])
export type TemplateBiometricOverride = z.infer<typeof templateBiometricOverride>

export const TEMPLATE_BIOMETRIC_MODES = [...BIOMETRIC_MODES, 'conditional'] as const

/**
 * What the template policy form holds. The rule's rows stay in the form while another mode is
 * chosen, so they are checked only for `conditional`: a half-typed row must not block saving "never".
 */
export const templateOverrideForm = biometricOverrideForm
  .extend({
    mode: z.enum(TEMPLATE_BIOMETRIC_MODES),
    match: z.enum(CONDITION_MATCHES),
    conditions: z.array(z.object({ param: z.string(), op: z.enum(CONDITION_OPS), value: z.number().or(z.nan()) })),
  })
  .superRefine((form, ctx) => {
    if (form.mode !== 'conditional') return
    if (form.conditions.length === 0) ctx.addIssue({ code: 'custom', path: ['conditions'], message: 'Add at least one condition.' })
    if (form.conditions.length > MAX_CONDITIONS) ctx.addIssue({ code: 'custom', path: ['conditions'], message: `Use at most ${MAX_CONDITIONS} conditions.` })
    form.conditions.forEach((row, index) => {
      if (!PARAM_PATTERN.test(row.param.trim())) ctx.addIssue({ code: 'custom', path: ['conditions', index, 'param'], message: row.param.trim() ? PARAM_MESSAGE : 'Name the parameter.' })
      if (!Number.isFinite(row.value)) ctx.addIssue({ code: 'custom', path: ['conditions', index, 'value'], message: 'Enter a number.' })
    })
  })
export type TemplateOverrideForm = z.input<typeof templateOverrideForm>

export function toTemplateOverride(form: z.output<typeof templateOverrideForm>): TemplateBiometricOverride {
  if (form.mode !== 'conditional') return toOverride({ ...form, mode: form.mode })
  return {
    mode: 'conditional',
    when: { match: form.match, conditions: form.conditions.map((row) => ({ param: row.param.trim(), op: row.op, value: row.value })) },
    minMatchScore: form.minMatchScore,
    minLivenessScore: form.minLivenessScore,
    maxAttempts: form.maxAttempts,
  }
}

export function toTemplateOverrideForm(policy: TemplateBiometricOverride | undefined, defaults: { minMatchScore: number; minLivenessScore: number; maxAttempts: number }): TemplateOverrideForm {
  if (policy?.mode !== 'conditional') return { ...toOverrideForm(policy, defaults), match: 'any', conditions: [] }
  return {
    mode: 'conditional',
    minMatchScore: policy.minMatchScore ?? defaults.minMatchScore,
    minLivenessScore: policy.minLivenessScore ?? defaults.minLivenessScore,
    maxAttempts: policy.maxAttempts ?? defaults.maxAttempts,
    match: policy.when.match,
    conditions: policy.when.conditions.map((row) => ({ ...row })),
  }
}

export const TEMPLATE_MODE_OPTIONS = [
  ...MODE_OPTIONS,
  { value: 'conditional' as const, label: 'Require a face check when…', description: 'decided per request from numbers your backend sends' },
]

export const CONDITION_OP_OPTIONS = CONDITION_OPS.map((op) => ({ value: op, label: CONDITION_OP_SYMBOLS[op] }))
export const CONDITION_MATCH_OPTIONS = [
  { value: 'any' as const, label: 'any of these is true' },
  { value: 'all' as const, label: 'all of these are true' },
]

/** Provider form: string fields generated from the provider's JSON Schema. */
export const biometricProviderInput = z.object({ providerId: z.string().min(1).max(100), config: z.record(z.string(), z.string().trim().min(1, 'Required.')) })
export type BiometricProviderInput = z.infer<typeof biometricProviderInput>

export const DEFAULT_POLICY: BiometricDefaultPolicy = { required: false, minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3, ttlMinutes: 30 }
