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

import type { ConditionOutcome } from '../biometric/policy.ts'

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
  /**
   * Days after an exchange finishes before its personal data is scrubbed (Phase 7 H1); null = RETENTION_DAYS,
   * 0 = keep until erased by request.
   */
  retentionDays: integer('retention_days'),
  /**
   * Days an audit row of this tenant is kept before it is deleted (implement/22 C15); null =
   * AUDIT_RETENTION_DAYS, 0 = keep everything. Longer than `retentionDays` on purpose: the audit outlasts
   * the data it describes.
   */
  auditRetentionDays: integer('audit_retention_days'),
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
  /** Who created it through the console (actor id), or 'admin-token'. Null for keys from before Phase 7 H1. */
  createdBy: text('created_by'),
  /** The console role at creation: an 'operator' key is flagged to the tenant, which was told by mail. */
  createdByRole: text('created_by_role'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [uniqueIndex('api_keys_hash_unique').on(table.keyHash), index('api_keys_prefix_idx').on(table.prefix), index('api_keys_tenant_created_idx').on(table.tenantId, table.createdAt.desc(), table.id.desc())])

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
  // Console lists (Phase 4 C9): newest first per tenant, external-id contains search (pg_trgm).
  index('wallets_tenant_created_idx').on(table.tenantId, table.createdAt.desc(), table.id.desc()),
  index('wallets_external_id_trgm_idx').using('gin', table.externalId.op('gin_trgm_ops')),
])

export const connections = pgTable('connections', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  recordId: text('record_id').notNull(),
  state: text('state').notNull(),
  invitationId: text('invitation_id'),
  theirLabel: text('their_label'),
  threadId: text('thread_id'),
  externalId: text('external_id'),
  /** Personal data scrubbed (Phase 7 H1): by request (`erased_by` names who) or by retention ('retention'). The row stays for history and dashboards. */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  erasedBy: text('erased_by'),
  lastOutboxId: bigint('last_outbox_id', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.recordId] }),
  index('connections_invitation_idx').on(table.tenantId, table.invitationId),
  // List sort and the dashboard's daily series / state counts (Phase 4 C8; review L3). The primary
  // key closes the index so the fixed list order (C9) is read straight from it, no sort.
  index('connections_tenant_created_idx').on(table.tenantId, table.createdAt.desc(), table.recordId.desc()),
  // State filter with the fixed list order; external-id contains search (Phase 4 C9).
  index('connections_tenant_state_created_idx').on(table.tenantId, table.state, table.createdAt.desc(), table.recordId.desc()),
  index('connections_external_id_trgm_idx').using('gin', table.externalId.op('gin_trgm_ops')),
  index('connections_their_label_trgm_idx').using('gin', table.theirLabel.op('gin_trgm_ops')),
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
  /**
   * When the credential stops being accepted, from its mandatory `expiresOn` date (Phase 7 H1; the end of that
   * UTC day): a validity date, not personal data,
   * kept after the attributes are scrubbed so the dashboard's expiry counts stay right.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  /** Personal data scrubbed (Phase 7 H1): by request (`erased_by` names who) or by retention ('retention'). The row stays for history and dashboards. */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  erasedBy: text('erased_by'),
  lastOutboxId: bigint('last_outbox_id', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.recordId] }),
  index('credentials_connection_idx').on(table.tenantId, table.connectionId),
  index('credentials_tenant_created_idx').on(table.tenantId, table.createdAt.desc(), table.recordId.desc()),
  // State filter with the fixed list order; external-id contains search (Phase 4 C9).
  index('credentials_tenant_state_created_idx').on(table.tenantId, table.state, table.createdAt.desc(), table.recordId.desc()),
  index('credentials_external_id_trgm_idx').using('gin', table.externalId.op('gin_trgm_ops')),
  index('credentials_tenant_expires_idx').on(table.tenantId, table.expiresAt).where(sql`${table.state} = 'done'`),
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
  /**
   * What the template's conditional face-check rule decided for this request (`ConditionOutcome`):
   * the rule as it was, the number sent for each condition, and whether a check was required. Null
   * when the template has no rule. The numbers sent are scrubbed with the exchange (Phase 7 H1).
   */
  biometricCondition: jsonb('biometric_condition').$type<ConditionOutcome>(),
  errorMessage: text('error_message'),
  /** Personal data scrubbed (Phase 7 H1): by request (`erased_by` names who) or by retention ('retention'). The row stays for history and dashboards. */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  erasedBy: text('erased_by'),
  lastOutboxId: bigint('last_outbox_id', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.recordId] }),
  index('proofs_connection_idx').on(table.tenantId, table.connectionId),
  index('proofs_tenant_created_idx').on(table.tenantId, table.createdAt.desc(), table.recordId.desc()),
  // State filter with the fixed list order; external-id contains search (Phase 4 C9).
  index('proofs_tenant_state_created_idx').on(table.tenantId, table.state, table.createdAt.desc(), table.recordId.desc()),
  index('proofs_external_id_trgm_idx').using('gin', table.externalId.op('gin_trgm_ops')),
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
}, (table) => [index('proof_templates_tenant_created_idx').on(table.tenantId, table.createdAt.desc(), table.id.desc())])

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
  /** The exchange the event is about (Phase 7 H1), so erasing a record can find its deliveries. */
  recordType: text('record_type'),
  recordId: text('record_id'),
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
  /** Personal data removed from `body` (Phase 7 H1); such a delivery is never sent again. */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
}, (table) => [
  index('webhook_deliveries_record_idx').on(table.tenantId, table.recordId),
  index('webhook_deliveries_due_idx').on(table.nextAttemptAt).where(sql`${table.status} in ('pending', 'sending')`),
  // Delivery lists, newest first (Phase 4 C9): per tenant, and the operator's cross-tenant dead letters.
  index('webhook_deliveries_tenant_created_idx').on(table.tenantId, table.createdAt.desc(), table.id.desc()),
  index('webhook_deliveries_dead_created_idx').on(table.createdAt.desc()).where(sql`${table.status} = 'dead'`),
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
 * Append-only: a trigger refuses UPDATE, DELETE and TRUNCATE (migration 0012; `erasures` likewise).
 */
export const consoleAudit = pgTable('console_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull(),
  /** The actor's email when it acted (implement/22 C13): the row stays readable after the account is deleted. */
  actorLabel: text('actor_label'),
  role: text('role').notNull(),
  tenantId: uuid('tenant_id'),
  /** The HTTP method, or `EVENT` for something the console reported (a sign-in, an account change, an export). */
  method: text('method').notNull(),
  /** Route pattern (`/v1/api-keys/:id`), never the concrete URL with its query string; for an event, its type (`auth.sign_in`). */
  route: text('route').notNull(),
  statusCode: integer('status_code').notNull(),
  requestId: text('request_id').notNull(),
  /** Why: required for an operator's erasure and for revealing personal data (Phase 7 H1). */
  reason: text('reason'),
  /**
   * What was changed (review L10): the route parameters and the request body of a mutating call,
   * with secrets and personal data replaced (`http/audit-changes.ts`). Null for reads and bodiless calls.
   */
  changes: jsonb('changes').$type<Record<string, unknown>>(),
}, (table) => [index('console_audit_at_idx').on(table.at), index('console_audit_tenant_idx').on(table.tenantId, table.at), index('console_audit_actor_idx').on(table.actor, table.at.desc())])

// --- Monitoring alerts (implement/22-console-feedback.md C16) --------------------------------
export const ALERT_STATUSES = ['firing', 'resolved'] as const

/**
 * What Alertmanager reported (`alerts.ts`), for the operators' system health page. One row per
 * occurrence of an alert; a repeated notification updates it. Not tenant data.
 */
export const platformAlerts = pgTable('platform_alerts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** Alertmanager's hash of the alert's labels: the same alert has the same fingerprint every time it fires. */
  fingerprint: text('fingerprint').notNull(),
  name: text('name').notNull(),
  severity: text('severity'),
  status: text('status', { enum: ALERT_STATUSES }).notNull(),
  summary: text('summary'),
  description: text('description'),
  labels: jsonb('labels').$type<Record<string, string>>().notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  firstReceivedAt: timestamp('first_received_at', { withTimezone: true }).notNull().defaultNow(),
  lastReceivedAt: timestamp('last_received_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('platform_alerts_occurrence_unique').on(table.fingerprint, table.startsAt), index('platform_alerts_status_idx').on(table.status, table.lastReceivedAt)])

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
  /** Scores and vendor session ids removed from the gate and its log (Phase 7 H1). */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('exchange_gates_record_unique').on(table.tenantId, table.recordType, table.recordId),
  index('exchange_gates_thread_idx').on(table.tenantId, table.threadId),
  // The face-checks list and the Verification page's daily series (implement/22 C10): newest first per
  // tenant, optionally by status, closed by the primary key so the fixed order needs no sort (as in C9).
  index('exchange_gates_tenant_created_idx').on(table.tenantId, table.createdAt.desc(), table.id.desc()),
  index('exchange_gates_tenant_status_created_idx').on(table.tenantId, table.status, table.createdAt.desc(), table.id.desc()),
  index('exchange_gates_pending_expiry_idx').on(table.expiresAt).where(sql`${table.status} = 'pending'`),
])

export const GATE_EVENT_TYPES = ['gate_created', 'session_started', 'attempt_completed', 'hold_reached', 'issued', 'accepted', 'declined', 'expired', 'cancelled'] as const
export type GateEventType = (typeof GATE_EVENT_TYPES)[number]

/** The biometric log (append-only): what the console shows next to an exchange. Scores and vendor ids are scrubbed with the exchange (Phase 7 H1). */
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
  // Attempts of a window, for the rejection reasons and score distributions (implement/22 C10).
  index('exchange_gate_events_attempts_idx').on(table.tenantId, table.at.desc()).where(sql`${table.type} = 'attempt_completed'`),
  uniqueIndex('exchange_gate_events_session_started_unique').on(table.sessionId).where(sql`${table.type} = 'session_started'`),
])

export const ERASURE_RECORD_TYPES = ['connection', 'credential', 'proof'] as const
export type ErasureRecordType = (typeof ERASURE_RECORD_TYPES)[number]

/**
 * Erasures made on request (Phase 7 H1): who, when, which record and why. Never the data itself.
 * Retention scrubs are marked on the row (`erased_by = 'retention'`) and are not listed here.
 */
export const erasures = pgTable('erasures', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  recordType: text('record_type', { enum: ERASURE_RECORD_TYPES }).notNull(),
  recordId: text('record_id').notNull(),
  /** 'api_key' or 'console'. */
  via: text('via').notNull(),
  /** The API key id, or the console user id. */
  actor: text('actor').notNull(),
  /** The console role (owner, admin, operator); null for an API key. */
  role: text('role'),
  reason: text('reason'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('erasures_tenant_at_idx').on(table.tenantId, table.at.desc())])
