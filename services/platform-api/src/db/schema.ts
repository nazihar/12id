/**
 * platform-api's own tables (database `platform_api`, separate from agent-service's and from
 * every Askar store). Mirror tables (`connections`, `credentials`, `proofs`) are denormalised
 * copies of agent-service records fed by the outbox consumer; customer reads never hit the agent.
 *
 * `last_outbox_id` on mirror rows makes the consumer idempotent: a row is only advanced by an
 * outbox row with a higher id (at-least-once delivery, out-of-order safe).
 */
import { sql } from 'drizzle-orm'
import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const TENANT_STATUSES = ['provisioning', 'ready', 'failed'] as const

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** agent-service tenant id (Credo TenantRecord id). */
  agentTenantId: text('agent_tenant_id').notNull(),
  did: text('did'),
  status: text('status', { enum: TENANT_STATUSES }).notNull().default('provisioning'),
  lastError: text('last_error'),
  /** Operator override of the per-API-key request limit (review M4); null = RATE_LIMIT_API_KEY_PER_MIN. */
  rateLimitPerMin: integer('rate_limit_per_min'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('tenants_agent_tenant_unique').on(table.agentTenantId)])

/** API keys: `12id_sk_<random>`; only the sha256 is stored, the prefix indexes the lookup. */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull(),
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [uniqueIndex('api_keys_hash_unique').on(table.keyHash), index('api_keys_prefix_idx').on(table.prefix)])

/**
 * One wallet per SDK installation. The token (`12id_wt_<random>`) is handed to the host app by
 * the customer backend. `mediator_oob_id` is the single-use invitation minted for it; the
 * mediator's connection record carries the same id, which is how a mediator webhook
 * (`connectionId`) is mapped back here (P7).
 */
export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  externalId: text('external_id'),
  tokenHash: text('token_hash').notNull(),
  mediatorOobId: text('mediator_oob_id'),
  /** Cached after the first webhook lookup. */
  mediatorConnectionId: text('mediator_connection_id'),
  lastSyncRequestedAt: timestamp('last_sync_requested_at', { withTimezone: true }),
  /** Biometric capture add-ons the SDK reported (`provider@version`), for the console's adoption view (Phase 6). */
  captureModules: text('capture_modules').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * First time the platform saw a mediator connection for this wallet (the wake path, or the sweep's
   * check of the mediator's connections by out-of-band id; review M10). Null = never connected.
   */
  connectedAt: timestamp('connected_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** Why the wallet was revoked: null = by the customer (DELETE /v1/wallets/:id), 'never_connected' = the sweep. */
  revokedReason: text('revoked_reason'),
  /** When the sweep removed the revoked wallet's mediator connection, mediation and queue (review M10). */
  mediationRemovedAt: timestamp('mediation_removed_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('wallets_token_unique').on(table.tokenHash),
  uniqueIndex('wallets_oob_unique').on(table.mediatorOobId),
  uniqueIndex('wallets_mediator_connection_unique').on(table.mediatorConnectionId),
  index('wallets_tenant_idx').on(table.tenantId),
])

export const connections = pgTable('connections', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  recordId: text('record_id').notNull(),
  state: text('state').notNull(),
  invitationId: text('invitation_id'),
  theirLabel: text('their_label'),
  threadId: text('thread_id'),
  externalId: text('external_id'),
  lastOutboxId: bigint('last_outbox_id', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.recordId] }),
  index('connections_invitation_idx').on(table.tenantId, table.invitationId),
  // List sort and the dashboard's daily series / state counts (Phase 4 C8; review L3).
  index('connections_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('connections_tenant_state_idx').on(table.tenantId, table.state),
])

export const credentials = pgTable('credentials', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  recordId: text('record_id').notNull(),
  connectionId: text('connection_id'),
  state: text('state').notNull(),
  threadId: text('thread_id'),
  externalId: text('external_id'),
  /** Unqualified cred def id, as offered on the wire. */
  credentialDefinitionId: text('credential_definition_id'),
  attributes: jsonb('attributes').$type<Record<string, string>>(),
  errorMessage: text('error_message'),
  lastOutboxId: bigint('last_outbox_id', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.recordId] }),
  index('credentials_connection_idx').on(table.tenantId, table.connectionId),
  index('credentials_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('credentials_tenant_state_idx').on(table.tenantId, table.state),
])

export const proofs = pgTable('proofs', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  recordId: text('record_id').notNull(),
  connectionId: text('connection_id'),
  state: text('state').notNull(),
  threadId: text('thread_id'),
  externalId: text('external_id'),
  templateId: uuid('template_id'),
  verified: boolean('verified'),
  /** Revealed attributes by group, filled when the exchange reaches `done`. */
  disclosed: jsonb('disclosed').$type<Record<string, Record<string, string>>>(),
  errorMessage: text('error_message'),
  lastOutboxId: bigint('last_outbox_id', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.recordId] }),
  index('proofs_connection_idx').on(table.tenantId, table.connectionId),
  index('proofs_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  index('proofs_tenant_state_idx').on(table.tenantId, table.state),
])

export const proofTemplates = pgTable('proof_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  /** Validated shape: `templateDefinition` in proof-templates.ts. */
  definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
  /** Biometric gate override (Phase 6); outside `definition` so template expansion is untouched. */
  biometricPolicy: jsonb('biometric_policy').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('proof_templates_tenant_idx').on(table.tenantId)])

/** One webhook endpoint per tenant in v1. The secret must stay in plaintext: it signs payloads. */
export const webhookEndpoints = pgTable('webhook_endpoints', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  /**
   * The secret a rotation replaced, still signed with for a while after `rotated_at` so receivers
   * can switch over without rejecting deliveries (review M9). Plaintext for the same reason.
   */
  previousSecret: text('previous_secret'),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  /** null = every event type. */
  events: text('events').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'dead'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  eventId: uuid('event_id').notNull().defaultRandom(),
  eventType: text('event_type').notNull(),
  /** The full signed body (envelope), serialised once so retries sign identical bytes. */
  body: text('body').notNull(),
  /** Where the last attempt went. Each attempt posts to the endpoint's current URL (review M8). */
  url: text('url').notNull(),
  status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastStatusCode: integer('last_status_code'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, (table) => [
  index('webhook_deliveries_due_idx').on(table.nextAttemptAt).where(sql`${table.status} in ('pending', 'sending')`),
  index('webhook_deliveries_tenant_idx').on(table.tenantId, table.createdAt),
  // Outbox events carry an id derived from the outbox row, so a replayed row enqueues nothing (review M6).
  uniqueIndex('webhook_deliveries_event_unique').on(table.eventId),
])

/** Single-row cursor into agent-service's outbox. */
export const outboxCursor = pgTable('outbox_cursor', {
  id: text('id').primaryKey(),
  lastId: bigint('last_id', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * `Idempotency-Key` records. Inserted when the request arrives (reserving the key); `completed_at`,
 * `status_code` and `response_body` are filled when the response is sent. A row without
 * `completed_at` is a request still in progress (or one that crashed; taken over after a minute).
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  statusCode: integer('status_code'),
  responseBody: text('response_body'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},(table) => [primaryKey({ columns: [table.tenantId, table.key] }), index('idempotency_created_idx').on(table.createdAt)])

/**
 * Who did what through the console scope or with the break-glass admin token (Phase 4 C1).
 * `tenant_id` has no foreign key: a refused request for an unknown tenant is still worth a row.
 */
export const consoleAudit = pgTable('console_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  role: text('role').notNull(),
  tenantId: uuid('tenant_id'),
  method: text('method').notNull(),
  /** Route pattern (`/v1/api-keys/:id`), never the concrete URL with its query string. */
  route: text('route').notNull(),
  statusCode: integer('status_code').notNull(),
  requestId: text('request_id').notNull(),
}, (table) => [index('console_audit_at_idx').on(table.at), index('console_audit_tenant_idx').on(table.tenantId, table.at)])

// --- Biometric gate (Phase 6, implement/15-phase-6-biometric.md B3) ------------------------
// Vendor configuration and images live in biometric-service; these tables hold policy, the gate
// state per exchange and the biometric log. No image bytes anywhere here.

/** Per-tenant switch and default policy (`BiometricDefaultPolicy` in biometric/policy.ts). */
export const biometricSettings = pgTable('biometric_settings', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  enabled: boolean('enabled').notNull().default(false),
  defaultPolicy: jsonb('default_policy').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Per credential definition override (`BiometricOverride`), keyed by the catalogue id. */
export const credentialDefinitionPolicies = pgTable('credential_definition_policies', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  credentialDefinitionId: text('credential_definition_id').notNull(),
  biometricPolicy: jsonb('biometric_policy').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.credentialDefinitionId] })])

export const GATE_STATUSES = ['pending', 'passed', 'failed', 'expired', 'cancelled'] as const
export type GateStatus = (typeof GATE_STATUSES)[number]

/**
 * One gate per gated exchange. `hold_reached_at` is set when the exchange parks at
 * request-received / presentation-received; `settled_at` when the platform has told the agent the
 * outcome (issue/accept or abandon). The gate acts when both halves are known (gate.ts).
 */
export const exchangeGates = pgTable('exchange_gates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  recordType: text('record_type', { enum: ['credential', 'proof'] }).notNull(),
  recordId: text('record_id').notNull(),
  threadId: text('thread_id').notNull(),
  checkId: uuid('check_id').notNull(),
  providerId: text('provider_id').notNull(),
  status: text('status', { enum: GATE_STATUSES }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull(),
  thresholds: jsonb('thresholds').$type<{ minLivenessScore: number; minMatchScore: number }>().notNull(),
  livenessScore: real('liveness_score'),
  matchScore: real('match_score'),
  reason: text('reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  holdReachedAt: timestamp('hold_reached_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('exchange_gates_record_unique').on(table.tenantId, table.recordType, table.recordId),
  index('exchange_gates_thread_idx').on(table.tenantId, table.threadId),
  index('exchange_gates_pending_expiry_idx').on(table.expiresAt).where(sql`${table.status} = 'pending'`),
])

export const GATE_EVENT_TYPES = ['gate_created', 'session_started', 'attempt_completed', 'hold_reached', 'issued', 'accepted', 'declined', 'expired', 'cancelled'] as const
export type GateEventType = (typeof GATE_EVENT_TYPES)[number]

/** The biometric log (append-only): what the console shows next to an exchange. Kept until Phase 7 H1 adds retention. */
export const exchangeGateEvents = pgTable('exchange_gate_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  gateId: uuid('gate_id').notNull().references(() => exchangeGates.id),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  type: text('type', { enum: GATE_EVENT_TYPES }).notNull(),
  attempt: integer('attempt'),
  /** biometric-service session id (for session_started / attempt_completed). */
  sessionId: uuid('session_id'),
  vendorSessionId: text('vendor_session_id'),
  providerId: text('provider_id'),
  livenessScore: real('liveness_score'),
  matchScore: real('match_score'),
  thresholds: jsonb('thresholds').$type<{ minLivenessScore: number; minMatchScore: number }>(),
  decision: text('decision'),
  reason: text('reason'),
}, (table) => [
  index('exchange_gate_events_gate_idx').on(table.gateId, table.id),
  uniqueIndex('exchange_gate_events_session_started_unique').on(table.sessionId).where(sql`${table.type} = 'session_started'`),
])
