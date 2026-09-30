import { z } from 'zod'

import { resolveFileEnv } from '@12id/credo-base/file-env.ts'

const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value))

const configSchema = z
  .object({
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

    /** biometric-service's own database (`biometric` on agent-postgres, 15-phase-6-biometric.md). */
    DATABASE_URL: z.url().refine((url) => url.startsWith('postgres://') || url.startsWith('postgresql://'), 'must be a postgres URL'),

    /** 32 random bytes, base64. Wraps the per-tenant data keys. Losing it makes every stored config and image unreadable. */
    BIOMETRIC_MASTER_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, 'BIOMETRIC_MASTER_KEY must be 32 bytes, base64'),

    /** Token platform-api presents. Distinct from the agent token (review H2). */
    INTERNAL_TOKEN: z.string().min(32),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3430),

    /** The mock provider is for tests, smokes and staging only. Never enable it in production. */
    BIOMETRIC_ENABLE_MOCK: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),

    /** 12id's own AWS principal, which assumes each tenant's role. Without it the aws-rekognition provider is not offered. */
    BIOMETRIC_AWS_ACCESS_KEY_ID: optionalSecret,
    BIOMETRIC_AWS_SECRET_ACCESS_KEY: optionalSecret,
    /** Region of our STS endpoint; each tenant's Rekognition region comes from its own configuration. */
    BIOMETRIC_AWS_REGION: z.string().default('ap-south-1'),

    EXPIRY_SWEEP_MS: z.coerce.number().int().min(1000).default(60_000),
  })
  .refine((config) => !!config.BIOMETRIC_AWS_ACCESS_KEY_ID === !!config.BIOMETRIC_AWS_SECRET_ACCESS_KEY, {
    message: 'set both BIOMETRIC_AWS_ACCESS_KEY_ID and BIOMETRIC_AWS_SECRET_ACCESS_KEY, or neither',
    path: ['BIOMETRIC_AWS_SECRET_ACCESS_KEY'],
  })

export type BiometricServiceConfig = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BiometricServiceConfig {
  // Secrets arrive as NAME_FILE (Phase 9 M11), resolved before validation.
  const result = configSchema.safeParse(resolveFileEnv(env))
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`invalid biometric-service configuration:\n${problems.join('\n')}`)
  }
  return result.data
}
