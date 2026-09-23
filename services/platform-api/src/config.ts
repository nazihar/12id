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

  /** biometric-service (Phase 6), private network. Both unset: no biometric routes and nothing is ever gated. */
  BIOMETRIC_SERVICE_URL: z.url().optional(),
  BIOMETRIC_SERVICE_TOKEN: secret.optional(),
  BIOMETRIC_EXPIRY_POLL_MS: z.coerce.number().int().positive().default(30_000),

  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1_000),
  OUTBOX_BATCH: z.coerce.number().int().min(1).max(500).default(200),
  WEBHOOK_POLL_MS: z.coerce.number().int().positive().default(1_000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(12),
  /** Deliveries in flight at once, shared fairly between tenants (review M2). */
  WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  /** Slots one tenant may hold while other tenants have deliveries waiting; alone, it may use them all. */
  WEBHOOK_PER_TENANT: z.coerce.number().int().min(1).max(64).default(2),
  /** At most one wallet.sync_requested per wallet per window (the mediator webhooks per message). */
  WAKE_DEBOUNCE_MS: z.coerce.number().int().positive().default(30_000),

  // Per-principal request limits (review M4), in-process fixed windows; 0 turns a limit off.
  /** Requests per minute per API key; a tenant's `rate_limit_per_min` overrides it. */
  RATE_LIMIT_API_KEY_PER_MIN: z.coerce.number().int().min(0).default(300),
  /** Requests per minute per wallet token (the SDK). */
  RATE_LIMIT_WALLET_PER_MIN: z.coerce.number().int().min(0).default(60),
  /** Mediator invitations per wallet per 10 minutes; each one creates a mediator record. */
  RATE_LIMIT_INVITATION_PER_10MIN: z.coerce.number().int().min(0).default(3),

  // Wallet and mediator housekeeping (review M10, M4); SWEEP_INTERVAL_MS 0 turns the sweep off.
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(60 * 60 * 1000),
  /** A wallet with no mediator connection this many days after creation is revoked. */
  WALLET_UNCONNECTED_REVOKE_DAYS: z.coerce.number().int().min(1).default(7),
  /** A revoked wallet's mediator connection, mediation and queue are removed this many days later. */
  WALLET_REVOKED_GRACE_DAYS: z.coerce.number().int().min(0).default(30),
  /** Unused per-wallet mediator invitations are deleted after this many hours. */
  MEDIATOR_INVITATION_TTL_HOURS: z.coerce.number().int().min(1).default(24),
  /** Messages queued at the mediator longer than this many days are deleted (their holder is gone). */
  MEDIATOR_QUEUE_TTL_DAYS: z.coerce.number().int().min(1).default(30),
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
