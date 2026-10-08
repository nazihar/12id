/**
 * agent-service's own tables (Postgres database separate from the Askar store).
 *
 * Every ledger step is resumable without regenerating keys (8-phase-2-findings T2):
 *   - Credo saves the tenant DID record and the cred def private key at the *action* step, before
 *     endorsement, so the request and the action-state credential definition are persisted here
 *     and reused on retry;
 *   - a DID record in the wallet does not prove the NYM exists, so `nym_written` is set only
 *     after GET_NYM confirms it.
 */
import { sql } from 'drizzle-orm'
import { type AnyPgColumn, bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const TENANT_STATUSES = ['pending', 'did_created', 'nym_endorsed', 'nym_written', 'ready', 'failed'] as const
export type TenantStatus = (typeof TENANT_STATUSES)[number]

export const tenants = pgTable('tenants', {
  /** Credo TenantRecord id. */
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  status: text('status', { enum: TENANT_STATUSES }).notNull().default('pending'),
  /** did:indy:<namespace>:<nym>, set when the key exists in the tenant wallet. */
  did: text('did'),
  nym: text('nym'),
  /** Unsigned NYM request built by the tenant (resume point before endorsement). */
  nymRequest: text('nym_request'),
  /** Endorser-signed NYM request (resume point before submission). */
  endorsedNymRequest: text('endorsed_nym_request'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('tenants_nym_unique').on(table.nym)])

export const LEDGER_OBJECT_KINDS = ['schema', 'credential_definition'] as const
export const LEDGER_OBJECT_STATUSES = ['pending', 'awaiting_endorsement', 'endorsed', 'published', 'deprecated', 'failed'] as const
export type LedgerObjectStatus = (typeof LEDGER_OBJECT_STATUSES)[number]

export const ledgerObjects = pgTable('ledger_objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  kind: text('kind', { enum: LEDGER_OBJECT_KINDS }).notNull(),
  /** Schema name, or the schema's name for a cred def (catalogue lookup). */
  name: text('name').notNull(),
  version: text('version').notNull(),
  /** Cred def tag; '' for schemas so the unique index covers both kinds. */
  tag: text('tag').notNull().default(''),
  /** For a cred def: the published schema it belongs to. */
  schemaObjectId: uuid('schema_object_id'),
  attributes: jsonb('attributes').$type<string[]>(),
  status: text('status', { enum: LEDGER_OBJECT_STATUSES }).notNull().default('pending'),
  /** Author-signed request awaiting the endorser. */
  request: text('request'),
  endorsedRequest: text('endorsed_request'),
  /** Cred defs only: the full credential definition from the action state. Resubmit with THIS. */
  actionState: jsonb('action_state'),
  qualifiedId: text('qualified_id'),
  /** The only form allowed on the wire (v1 offers and proof restrictions). */
  unqualifiedId: text('unqualified_id'),
  ledgerSeqNo: integer('ledger_seq_no'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('ledger_objects_identity_unique').on(table.tenantId, table.kind, table.name, table.version, table.tag),
  uniqueIndex('ledger_objects_qualified_unique').on(table.qualifiedId),
  uniqueIndex('ledger_objects_unqualified_unique').on(table.unqualifiedId),
  // The console's paged catalogue lists (Phase 4 C9).
  index('ledger_objects_tenant_kind_created_idx').on(table.tenantId, table.kind, table.createdAt.desc()),
])

export const OUTBOX_RECORD_TYPES = ['connection', 'credential', 'proof'] as const

/** Credo's final credential and proof exchange states, as the outbox stores them. */
export const OUTBOX_FINAL_STATES = ['done', 'abandoned', 'declined'] as const

/**
 * Rows whose stored DIDComm messages are due for deletion (exchanges/message-purge.ts): a finished
 * exchange, read by the platform, not purged yet. Literals, not parameters: the query has to match
 * the partial index's predicate.
 */
export const outboxPurgeDue = (table: { recordType: AnyPgColumn; state: AnyPgColumn; deliveredAt: AnyPgColumn; messagesPurgedAt: AnyPgColumn }) =>
  sql`${table.deliveredAt} is not null and ${table.messagesPurgedAt} is null and ${table.recordType} in ('credential', 'proof') and ${table.state} in (${sql.raw(OUTBOX_FINAL_STATES.map((state) => `'${state}'`).join(', '))})`

/**
 * Transactional outbox of Credo state transitions (A6), consumed by the Phase 3 platform API.
 * One row per transition; `threadId` is the cross-hop key (clocks differ across hosts).
 */
export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: text('tenant_id').notNull(),
  recordType: text('record_type', { enum: OUTBOX_RECORD_TYPES }).notNull(),
  recordId: text('record_id').notNull(),
  threadId: text('thread_id'),
  state: text('state').notNull(),
  previousState: text('previous_state'),
  correlationId: text('correlation_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  /** Set when the finished exchange's stored DIDComm messages were deleted from the tenant wallet. */
  messagesPurgedAt: timestamp('messages_purged_at', { withTimezone: true }),
}, (table) => [
  index('outbox_undelivered_idx').on(table.id).where(sql`${table.deliveredAt} is null`),
  index('outbox_record_idx').on(table.tenantId, table.recordType, table.recordId),
  index('outbox_purge_due_idx').on(table.id).where(outboxPurgeDue(table)),
])
