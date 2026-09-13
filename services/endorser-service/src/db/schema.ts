/**
 * endorser-service tables. Its own database: the agent-service cannot write here, so a
 * compromised agent-service cannot rebind a tenant to a different DID.
 */
import { bigserial, boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** Tenant → DID nym. Written once, on the tenant's first bind; never updated. */
export const tenantBindings = pgTable('tenant_bindings', {
  tenantId: text('tenant_id').primaryKey(),
  nym: text('nym').notNull().unique(),
  boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Every decision, signed or refused. The endorser key is the most valuable secret (4-init §6). */
export const endorsementAudit = pgTable('endorsement_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: text('tenant_id').notNull(),
  kind: text('kind').notNull(),
  operationType: text('operation_type'),
  author: text('author'),
  allowed: boolean('allowed').notNull(),
  reason: text('reason'),
  /** sha256 of the request as received, to match against the ledger later. */
  requestSha256: text('request_sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('endorsement_audit_tenant_idx').on(table.tenantId, table.createdAt)])
