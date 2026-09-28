/**
 * biometric-service tables (15-phase-6-biometric.md B1). Database `biometric` on agent-postgres.
 * Every ciphertext column is sealed with the tenant's data key (crypto.ts). Reference images are
 * nulled at the decision or at expiry; results keep scores, decisions and hashes only.
 */
import { sql } from 'drizzle-orm'
import { customType, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/** One wrapped data key and our external id per tenant, created on first use. */
export const tenantKeys = pgTable('tenant_keys', {
  tenantId: text('tenant_id').primaryKey(),
  wrappedKey: bytea('wrapped_key').notNull(),
  /** Put by the tenant into its AWS role's trust policy (confused-deputy protection). Not a secret. */
  externalId: text('external_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** At most one active provider per tenant. */
export const providerConfigs = pgTable('provider_configs', {
  tenantId: text('tenant_id').primaryKey(),
  providerId: text('provider_id').notNull(),
  configCiphertext: bytea('config_ciphertext').notNull(),
  /** Non-secret fields shown back to the console (e.g. region, role ARN). */
  publicConfig: jsonb('public_config').$type<Record<string, unknown>>().notNull(),
  status: text('status', { enum: ['untested', 'ok', 'failed'] }).notNull().default('untested'),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const checks = pgTable('checks', {
  id: uuid('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  purpose: text('purpose', { enum: ['issue', 'proof'] }).notNull(),
  providerId: text('provider_id').notNull(),
  thresholds: jsonb('thresholds').$type<{ minLivenessScore: number; minMatchScore: number }>().notNull(),
  /** Null once decided or expired. */
  referenceCiphertext: bytea('reference_ciphertext'),
  /** Null once the check was erased (Phase 7 H1). */
  referenceSha256: text('reference_sha256'),
  status: text('status', { enum: ['pending', 'passed', 'failed', 'expired', 'cancelled'] }).notNull().default('pending'),
  /** Sessions started so far; an abandoned session still counts. */
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /** Scores, vendor values, hashes and vendor session ids removed (Phase 7 H1); the decision stays. */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('checks_pending_expiry_idx').on(table.expiresAt).where(sql`${table.status} = 'pending'`),
  index('checks_tenant_idx').on(table.tenantId, table.createdAt),
])

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  checkId: uuid('check_id').notNull().references(() => checks.id),
  tenantId: text('tenant_id').notNull(),
  attempt: integer('attempt').notNull(),
  /** Null once the check was erased (Phase 7 H1). */
  vendorSessionId: text('vendor_session_id'),
  /** started → completing (single-use claim) → completed. */
  status: text('status', { enum: ['started', 'completing', 'completed'] }).notNull().default('started'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [uniqueIndex('sessions_check_attempt_idx').on(table.checkId, table.attempt)])

export const results = pgTable('results', {
  sessionId: uuid('session_id').primaryKey().references(() => sessions.id),
  checkId: uuid('check_id').notNull().references(() => checks.id),
  decision: text('decision', { enum: ['passed', 'failed'] }).notNull(),
  reason: text('reason').notNull(),
  livenessScore: real('liveness_score'),
  matchScore: real('match_score'),
  /** Vendor values without image bytes. */
  raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
  probeSha256: text('probe_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('results_check_idx').on(table.checkId)])
