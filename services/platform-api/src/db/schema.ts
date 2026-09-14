/**
 * platform-api's own tables (database `platform_api`, separate from agent-service's and from
 * every Askar store). Mirror tables (`connections`, `credentials`, `proofs`) are denormalised
 * copies of agent-service records fed by the outbox consumer; customer reads never hit the agent.
 *
 * `last_outbox_id` on mirror rows makes the consumer idempotent: a row is only advanced by an
 * outbox row with a higher id (at-least-once delivery, out-of-order safe).
 */
import { sql } from 'drizzle-orm'
import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const TENANT_STATUSES = ['provisioning', 'ready', 'failed'] as const

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** agent-service tenant id (Credo TenantRecord id). */
  agentTenantId: text('agent_tenant_id').notNull(),
  did: text('did'),
  status: text('status', { enum: TENANT_STATUSES }).notNull().default('provisioning'),
  lastError: text('last_error'),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
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
}, (table) => [primaryKey({ columns: [table.tenantId, table.recordId] }), index('connections_invitation_idx').on(table.tenantId, table.invitationId)])

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
}, (table) => [primaryKey({ columns: [table.tenantId, table.recordId] }), index('credentials_connection_idx').on(table.tenantId, table.connectionId)])

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
}, (table) => [primaryKey({ columns: [table.tenantId, table.recordId] }), index('proofs_connection_idx').on(table.tenantId, table.connectionId)])

export const proofTemplates = pgTable('proof_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  /** Validated shape: `templateDefinition` in proof-templates.ts. */
  definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('proof_templates_tenant_idx').on(table.tenantId)])

/** One webhook endpoint per tenant in v1. The secret must stay in plaintext: it signs payloads. */
export const webhookEndpoints = pgTable('webhook_endpoints', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
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
])

/** Single-row cursor into agent-service's outbox. */
export const outboxCursor = pgTable('outbox_cursor', {
  id: text('id').primaryKey(),
  lastId: bigint('last_id', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const idempotencyKeys = pgTable('idempotency_keys', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  statusCode: integer('status_code').notNull(),
  responseBody: text('response_body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.key] }), index('idempotency_created_idx').on(table.createdAt)])
