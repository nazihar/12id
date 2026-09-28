/**
 * Personal-data erasure (Phase 7 H1). Scrubs, never deletes: the exchange row stays with its ids,
 * state, external id and timestamps, so lists, dashboards, the audit log and the biometric log keep
 * adding up. What goes, everywhere the platform holds it:
 *   - the mirror row's personal data: credential `attributes`, proof `disclosed`, connection `their_label`
 *     (the credential's `expires_at` stays: it is a validity date the dashboard counts);
 *   - the same values inside webhook delivery bodies (pending ones are never sent afterwards);
 *   - the biometric gate's scores and vendor session ids, and biometric-service's copy of the check;
 *   - agent-service's Credo records: the exchange record with its stored DIDComm messages, and for a
 *     connection the connection record.
 *
 * Only finished exchanges are erased (409 otherwise): a running protocol still needs its record.
 * Erasing a connection erases every exchange on it first ("erase this person" for one tenant).
 * Every step is idempotent, so a failure part-way is finished by a retry; the agent and
 * biometric-service are called before the platform marks the row, so a row marked erased is erased
 * everywhere.
 *
 * It does not touch the credential in the holder's wallet: without revocation (§12.3) it stays
 * usable until its expiry attribute passes.
 */
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { AgentClient } from './agent-client.ts'
import type { BiometricClient } from './biometric-client.ts'
import type { Database } from './db/client.ts'
import { type ErasureRecordType, connections, credentials, erasures, exchangeGateEvents, exchangeGates, proofs, webhookDeliveries } from './db/schema.ts'
import { PlatformError } from './http/errors.ts'
import { type EndpointLookup, enqueueEvent } from './webhooks/events.ts'

/** Exchange states after which nothing more happens; only these can be erased. */
export const FINISHED_EXCHANGE_STATES = ['done', 'abandoned', 'declined'] as const

/** Fields that hold personal data wherever they appear in a webhook body. */
const PERSONAL_FIELDS = new Set(['attributes', 'disclosed', 'theirLabel', 'livenessScore', 'matchScore', 'vendorSessionId'])

export interface ErasureDeps {
  db: Database
  agent: Pick<AgentClient, 'eraseCredential' | 'eraseProof' | 'eraseConnection'>
  biometric?: Pick<BiometricClient, 'eraseCheck'>
  endpoints: EndpointLookup
  logger: PinoLogger
}

/** Who asked. `reason` is required from operators (checked by the route), optional otherwise. */
export type Requester = { via: 'api_key'; actor: string } | { via: 'console'; actor: string; role: string; reason?: string }

export interface ErasureTenant {
  id: string
  agentTenantId: string
}

type ExchangeKind = 'credential' | 'proof'
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

const requesterLabel = (who: Requester) => (who.via === 'api_key' ? `api_key:${who.actor}` : `console:${who.role}:${who.actor}`)

/** Replaces personal fields in a webhook envelope with null (for storage) or `mask` (for an operator's view). */
export function redactBody(body: string, mask: string | null = null): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
        if (!PERSONAL_FIELDS.has(key) || inner === null) return [key, walk(inner)]
        return [key, mask === null ? null : maskValue(inner, mask)]
      })
    )
  }
  return JSON.stringify(walk(parsed))
}

/** Keeps the shape (keys of a record, nesting) and hides every value. */
export function maskValue(value: unknown, mask: string): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, maskValue(inner, mask)]))
  return typeof value === 'number' ? null : mask
}

/** Scrubs the stored bodies of these deliveries; pending ones become dead so they are never sent. */
async function scrubDeliveries(db: Database | Tx, tenantId: string, recordIds: string[], now: Date) {
  if (recordIds.length === 0) return 0
  const rows = await db
    .select({ id: webhookDeliveries.id, body: webhookDeliveries.body, status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.tenantId, tenantId), inArray(webhookDeliveries.recordId, recordIds), isNull(webhookDeliveries.erasedAt)))
  for (const row of rows) {
    const pending = row.status === 'pending'
    await db
      .update(webhookDeliveries)
      .set({ body: redactBody(row.body), erasedAt: now, ...(pending ? { status: 'dead' as const, lastError: 'personal data erased before delivery' } : {}) })
      .where(eq(webhookDeliveries.id, row.id))
  }
  return rows.length
}

/**
 * The erasure steps for finished exchanges, shared by requests and the retention job. Returns the
 * record ids actually scrubbed. Callers have already checked the states.
 */
export async function scrubExchanges(deps: ErasureDeps, tenant: ErasureTenant, kind: ExchangeKind, recordIds: string[], erasedBy: string, now = new Date()): Promise<string[]> {
  if (recordIds.length === 0) return []
  const table = kind === 'credential' ? credentials : proofs
  const gates = await deps.db
    .select({ id: exchangeGates.id, checkId: exchangeGates.checkId, recordId: exchangeGates.recordId })
    .from(exchangeGates)
    .where(and(eq(exchangeGates.tenantId, tenant.id), eq(exchangeGates.recordType, kind), inArray(exchangeGates.recordId, recordIds), isNull(exchangeGates.erasedAt)))

  // Outside systems first: a failure leaves the platform row unmarked, so the next attempt redoes it.
  for (const recordId of recordIds) {
    if (kind === 'credential') await deps.agent.eraseCredential(tenant.agentTenantId, recordId)
    else await deps.agent.eraseProof(tenant.agentTenantId, recordId)
  }
  if (gates.length > 0 && !deps.biometric) throw new PlatformError(503, 'biometric_unavailable', 'biometric-service is not configured; the gate data cannot be erased')
  for (const gate of gates) await deps.biometric!.eraseCheck(gate.checkId)

  await deps.db.transaction(async (tx) => {
    const personal = kind === 'credential' ? { attributes: null } : { disclosed: null }
    await tx.update(table).set({ ...personal, erasedAt: now, erasedBy }).where(and(eq(table.tenantId, tenant.id), inArray(table.recordId, recordIds), isNull(table.erasedAt)))
    if (gates.length > 0) {
      const gateIds = gates.map((g) => g.id)
      await tx.update(exchangeGates).set({ livenessScore: null, matchScore: null, erasedAt: now }).where(inArray(exchangeGates.id, gateIds))
      await tx.update(exchangeGateEvents).set({ livenessScore: null, matchScore: null, vendorSessionId: null }).where(inArray(exchangeGateEvents.gateId, gateIds))
    }
    await scrubDeliveries(tx, tenant.id, recordIds, now)
  })
  return recordIds
}

async function record(deps: ErasureDeps, tenant: ErasureTenant, recordType: ErasureRecordType, recordId: string, who: Requester, now: Date) {
  await deps.db.insert(erasures).values({ tenantId: tenant.id, recordType, recordId, via: who.via, actor: who.actor, role: who.via === 'console' ? who.role : null, reason: who.via === 'console' ? (who.reason ?? null) : null, at: now })
  const initiator = who.via === 'api_key' ? 'api_key' : who.role === 'operator' ? 'operator' : 'tenant_member'
  await enqueueEvent(deps.db, deps.endpoints, tenant.id, 'record.erased', { recordType, recordId, erasedAt: now.toISOString(), initiator })
}

/** Erases one credential or proof exchange on request. 404 unknown, 409 still running; a repeat is a no-op. */
export async function eraseExchange(deps: ErasureDeps, tenant: ErasureTenant, kind: ExchangeKind, recordId: string, who: Requester, now = new Date()) {
  const table = kind === 'credential' ? credentials : proofs
  const [row] = await deps.db.select({ state: table.state, erasedAt: table.erasedAt }).from(table).where(and(eq(table.tenantId, tenant.id), eq(table.recordId, recordId)))
  if (!row) throw new PlatformError(404, 'not_found', `${kind} exchange not found`)
  if (row.erasedAt) return
  if (!(FINISHED_EXCHANGE_STATES as readonly string[]).includes(row.state)) throw new PlatformError(409, 'exchange_in_progress', `the ${kind} exchange is ${row.state}; abandon it or wait until it finishes`)
  await scrubExchanges(deps, tenant, kind, [recordId], requesterLabel(who), now)
  await record(deps, tenant, kind, recordId, who, now)
  deps.logger.info({ component: 'erasure', tenantId: tenant.id, kind, recordId, via: who.via }, 'exchange erased on request')
}

/**
 * Erases a connection and every exchange on it. 409 while any of those exchanges is still running.
 * Returns the ids of the exchanges erased along with it.
 */
export async function eraseConnection(deps: ErasureDeps, tenant: ErasureTenant, connectionId: string, who: Requester, now = new Date()) {
  const [row] = await deps.db.select({ erasedAt: connections.erasedAt }).from(connections).where(and(eq(connections.tenantId, tenant.id), eq(connections.recordId, connectionId)))
  if (!row) throw new PlatformError(404, 'not_found', 'connection not found')

  const onConnection = (table: typeof credentials | typeof proofs) =>
    deps.db.select({ recordId: table.recordId, state: table.state }).from(table).where(and(eq(table.tenantId, tenant.id), eq(table.connectionId, connectionId), isNull(table.erasedAt)))
  const [creds, prfs] = await Promise.all([onConnection(credentials), onConnection(proofs)])
  const finished = (s: string) => (FINISHED_EXCHANGE_STATES as readonly string[]).includes(s)
  const running = [...creds, ...prfs].filter((r) => !finished(r.state))
  if (running.length > 0) throw new PlatformError(409, 'exchange_in_progress', `${running.length} exchange(s) on this connection are still running; abandon them or wait until they finish`)

  const by = requesterLabel(who)
  const erasedCredentials = await scrubExchanges(deps, tenant, 'credential', creds.map((r) => r.recordId), by, now)
  const erasedProofs = await scrubExchanges(deps, tenant, 'proof', prfs.map((r) => r.recordId), by, now)
  for (const id of erasedCredentials) await record(deps, tenant, 'credential', id, who, now)
  for (const id of erasedProofs) await record(deps, tenant, 'proof', id, who, now)

  if (!row.erasedAt) {
    await deps.agent.eraseConnection(tenant.agentTenantId, connectionId)
    await deps.db.transaction(async (tx) => {
      await tx.update(connections).set({ theirLabel: null, erasedAt: now, erasedBy: by }).where(and(eq(connections.tenantId, tenant.id), eq(connections.recordId, connectionId)))
      await scrubDeliveries(tx, tenant.id, [connectionId], now)
    })
    await record(deps, tenant, 'connection', connectionId, who, now)
  }
  deps.logger.info({ component: 'erasure', tenantId: tenant.id, connectionId, credentials: erasedCredentials.length, proofs: erasedProofs.length, via: who.via }, 'connection erased on request')
  return { credentials: erasedCredentials, proofs: erasedProofs }
}

/** Finished, not yet erased exchanges of one tenant last updated before `before`, oldest first. */
export async function dueForRetention(db: Database, tenantId: string, kind: ExchangeKind, before: Date, limit: number) {
  const table = kind === 'credential' ? credentials : proofs
  const rows = await db
    .select({ recordId: table.recordId })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), isNull(table.erasedAt), inArray(table.state, [...FINISHED_EXCHANGE_STATES]), lt(table.updatedAt, before)))
    .orderBy(table.updatedAt)
    .limit(limit)
  return rows.map((r) => r.recordId)
}

/** Deliveries older than `before` that are finished (delivered or dead) and still hold a body with personal data. */
export async function scrubOldDeliveries(db: Database, tenantId: string, before: Date, limit: number, now = new Date()) {
  const rows = await db
    .select({ id: webhookDeliveries.id, body: webhookDeliveries.body })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.tenantId, tenantId), isNull(webhookDeliveries.erasedAt), lt(webhookDeliveries.createdAt, before), or(eq(webhookDeliveries.status, 'delivered'), eq(webhookDeliveries.status, 'dead'))))
    .limit(limit)
  for (const row of rows) await db.update(webhookDeliveries).set({ body: redactBody(row.body), erasedAt: now }).where(eq(webhookDeliveries.id, row.id))
  return rows.length
}

