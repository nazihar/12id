import { z } from 'zod'

const postgresUrl = z.url().refine((url) => url.startsWith('postgres://') || url.startsWith('postgresql://'), 'must be a postgres URL')
const secret = z.string().min(32, 'secrets must be at least 32 characters; generate them, never hand-type them')

const configSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3500),
  /** Public base URL, used in OpenAPI and documentation links. */
  PUBLIC_URL: z.url(),

  /** platform-api's own database. */
  DATABASE_URL: postgresUrl,

  /** agent-service internal API (Phase 2 D2), on the private Docker network. */
  AGENT_API_URL: z.url(),
  AGENT_API_TOKEN: secret,

  /** Mediator admin route (patched image, P1) and read-only access to its Drizzle database (P7). */
  MEDIATOR_ADMIN_URL: z.url(),
  MEDIATOR_ADMIN_TOKEN: secret,
  MEDIATOR_DRIZZLE_URL: postgresUrl,
  /** Secret path segment of the mediator webhook receiver; the mediator sends no other credential. */
  MEDIATOR_WEBHOOK_SECRET: secret,

  /** Break-glass operator token for /admin/* over an SSH tunnel; the console is the normal path. */
  PLATFORM_ADMIN_TOKEN: secret,
  /** Console scope (Phase 4): the console's server acts for a tenant or as an operator. Unset disables it. */
  CONSOLE_TOKEN: secret.optional(),

  // Ledger configuration served to SDKs by GET /v1/ledger (public data; the file itself lives on
  // the genesis host, versioned and minisign-signed since Phase 1).
  INDY_NAMESPACE: z.string().regex(/^[a-z][_a-z0-9-]*(:[a-z][_a-z0-9-]*)?$/, 'invalid did:indy namespace'),
  GENESIS_URL: z.url(),
  GENESIS_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
  GENESIS_SIGNATURE_URL: z.url(),
  GENESIS_SIGNING_PUBLIC_KEY: z.string().min(1),
  VDR_PROXY_URL: z.url().optional(),

  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1_000),
  OUTBOX_BATCH: z.coerce.number().int().min(1).max(500).default(200),
  WEBHOOK_POLL_MS: z.coerce.number().int().positive().default(1_000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(12),
  /** At most one wallet.sync_requested per wallet per window (the mediator webhooks per message). */
  WAKE_DEBOUNCE_MS: z.coerce.number().int().positive().default(30_000),
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(24 * 3600 * 1000),
  /** Graceful shutdown: stop taking work, finish in-flight deliveries, then close (< stop_grace_period). */
  DRAIN_DEADLINE_MS: z.coerce.number().int().positive().default(15_000),
})

export type PlatformConfig = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const result = configSchema.safeParse(env)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`invalid platform-api configuration:\n${problems.join('\n')}`)
  }
  return result.data
}
