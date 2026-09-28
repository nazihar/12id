import { z } from 'zod'

// did:indy namespaces must match Credo's didIndyRegex: lowercase start, at most one sub-namespace
// (6-phase-1-findings W3: "12id" is rejected; staging uses "twelveid:staging").
const indyNamespace = z.string().regex(/^[a-z][_a-z0-9-]*(:[a-z][_a-z0-9-]*)?$/, 'invalid did:indy namespace')

const roles = z
  .string()
  .transform((value) => value.split(',').map((role) => role.trim()).filter(Boolean))
  .pipe(z.array(z.enum(['issuer', 'verifier'])).min(1))

const configSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  AGENT_ROLES: roles.default(['issuer', 'verifier']),

  // Ledger: genesis is fetched at start and refused unless the sha256 matches.
  INDY_NAMESPACE: indyNamespace,
  GENESIS_URL: z.url(),
  GENESIS_SHA256: z.string().regex(/^[0-9a-f]{64}$/, 'GENESIS_SHA256 must be 64 lowercase hex characters'),

  // DIDComm: the public endpoint phones and the mediator reach (through Caddy), and the local port.
  DIDCOMM_ENDPOINT: z.url(),
  DIDCOMM_PORT: z.coerce.number().int().min(1).max(65535),

  // Private internal API (D2). Bind to the container's private network address, never 0.0.0.0 on a host.
  INTERNAL_API_HOST: z.string().min(1).default('127.0.0.1'),
  INTERNAL_API_PORT: z.coerce.number().int().min(1).max(65535).default(3410),
  /** Shared secret the platform API presents on the internal API (Phase 3). Optional locally. */
  INTERNAL_API_TOKEN: z.string().min(32).optional(),

  // Root Askar store on Postgres; tenants are profiles inside it (T1).
  ASKAR_STORE_ID: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'store id doubles as the Postgres database name'),
  ASKAR_STORE_KEY: z.string().min(32, 'store key looks too short; generate it, never hand-type it'),
  POSTGRES_HOST: z.string().regex(/^[^:]+:\d+$/, 'POSTGRES_HOST must be host:port'),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  /**
   * Account Askar uses only if the root store's database is missing (CREATE DATABASE). Set on the
   * provision job alone; the service runs with its own non-superuser role (Phase 7 H3).
   */
  POSTGRES_ADMIN_USER: z.string().min(1).optional(),
  POSTGRES_ADMIN_PASSWORD: z.string().min(1).optional(),

  // agent-service's own tables (tenants, catalogue, outbox). A database separate from the Askar store.
  DATABASE_URL: z.url().refine((url) => url.startsWith('postgres://') || url.startsWith('postgresql://'), 'must be a postgres URL'),

  // Platform endorser (D3, D5): tenant DIDs take their namespace from this DID.
  ENDORSER_DID: z.string().regex(/^did:indy:[a-z][_a-z0-9-]*(:[a-z][_a-z0-9-]*)?:[1-9A-HJ-NP-Za-km-z]{21,22}$/, 'ENDORSER_DID must be a did:indy DID'),
  ENDORSER_SERVICE_URL: z.url(),
  ENDORSER_SERVICE_TOKEN: z.string().min(32),

  TENANT_SESSION_LIMIT: z.coerce.number().int().positive().default(100),
  TENANT_SESSION_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // Off by default, as in Credo: all tenants' inbound messages are processed one at a time (T1
  // trap 4). Turn on only after the Phase 7 load test shows it is safe.
  PROCESS_MESSAGES_CONCURRENTLY: z.stringbool().default(false),

  // Stuck-exchange reconciliation (T3a): waiting records older than the TTL are abandoned.
  RECONCILE_TTL_MS: z.coerce.number().int().positive().default(24 * 3600 * 1000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),

  // Outbox retention (Phase 7 H1): acknowledged rows are deleted this many days after the platform
  // read them; 0 keeps them forever.
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  OUTBOX_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),

  // Graceful shutdown (T3b): must be shorter than the container's stop grace period.
  DRAIN_DEADLINE_MS: z.coerce.number().int().positive().default(15_000),
})

export type AgentServiceConfig = z.infer<typeof configSchema>

/** Parses and validates the environment. Throws one error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentServiceConfig {
  const result = configSchema.safeParse(env)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`invalid agent-service configuration:\n${problems.join('\n')}`)
  }
  return result.data
}
