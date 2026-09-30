import { z } from 'zod'

import { resolveFileEnv } from '@12id/credo-base/file-env.ts'

const configSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  // Must match the endorser DID's namespace; tenant DIDs inherit it (T2).
  INDY_NAMESPACE: z.string().regex(/^[a-z][_a-z0-9-]*(:[a-z][_a-z0-9-]*)?$/, 'invalid did:indy namespace'),
  GENESIS_URL: z.url(),
  GENESIS_SHA256: z.string().regex(/^[0-9a-f]{64}$/, 'GENESIS_SHA256 must be 64 lowercase hex characters'),
  /** Credo's `isProduction` flag for the Indy network (review I1); true on a production ledger. */
  INDY_NETWORK_PRODUCTION: z.stringbool().default(false),

  /** The platform endorser, created by infra/ledger bootstrap-endorser. */
  ENDORSER_DID: z.string().regex(/^did:indy:[a-z][_a-z0-9-]*(:[a-z][_a-z0-9-]*)?:[1-9A-HJ-NP-Za-km-z]{21,22}$/, 'ENDORSER_DID must be a did:indy DID'),

  // The existing endorser Askar store. Opened, never created (see provision.ts).
  ASKAR_STORE_ID: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  ASKAR_STORE_KEY: z.string().min(32),
  POSTGRES_HOST: z.string().regex(/^[^:]+:\d+$/, 'POSTGRES_HOST must be host:port'),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),

  /** endorser-service's own tables (bindings, audit), separate from the Askar store. */
  DATABASE_URL: z.url().refine((url) => url.startsWith('postgres://') || url.startsWith('postgresql://'), 'must be a postgres URL'),

  /**
   * Most schemas + credential definitions one tenant may have endorsed in any 24 h (review M3).
   * 0 turns the ceiling off (for example a self-hosted install on its own ledger).
   */
  ENDORSER_DAILY_CEILING: z.coerce.number().int().min(0).default(50),

  /** Shared secret agent-service presents. */
  INTERNAL_TOKEN: z.string().min(32),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3420),
}).refine((config) => config.ENDORSER_DID.startsWith(`did:indy:${config.INDY_NAMESPACE}:`), {
  message: 'ENDORSER_DID is not in INDY_NAMESPACE',
  path: ['ENDORSER_DID'],
})

export type EndorserServiceConfig = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EndorserServiceConfig {
  // Secrets arrive as NAME_FILE (Phase 9 M11), resolved before validation.
  const result = configSchema.safeParse(resolveFileEnv(env))
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`invalid endorser-service configuration:\n${problems.join('\n')}`)
  }
  return result.data
}
