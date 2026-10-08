/**
 * Outbox consumer (P6): polls agent-service's outbox feed, mirrors every state transition into
 * the platform tables and enqueues the matching webhook event.
 *
 * Replay-safe (review M6): each mirror row remembers the highest outbox id applied
 * (`last_outbox_id`). An older row is a no-op; the *same* row applies again, because a failure
 * after the upsert (detail fetch, biometric gate, enqueue) leaves the cursor behind it and the
 * retry must finish the job. Every step is idempotent: the upsert writes the same values, the gate
 * transitions are compare-and-set, and the webhook event id is derived from the outbox row id, so
 * a second enqueue of it is dropped. The cursor advances per row, after the row is fully applied.
 */
import { eq, sql } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { AgentClient, OutboxRow } from './agent-client.ts'
import type { GateEngine } from './biometric/gate.ts'
import type { Database } from './db/client.ts'
import { connections, credentials, outboxCursor, proofs, tenants } from './db/schema.ts'
import { expiryOf, toConnectionView, toCredentialView, toProofView } from './views.ts'
import { type EndpointLookup, type EventType, enqueueEvent, outboxEventId } from './webhooks/events.ts'

const CURSOR_ID = 'agent'

export interface ConsumerDeps {
  db: Database
  agent: AgentClient
  logger: PinoLogger
  endpoints: EndpointLookup
  batch?: number
  /** Phase 6: told about every credential/proof transition so held exchanges are released or abandoned. */
  gates?: GateEngine
}

export type TenantResolver = (agentTenantId: string) => Promise<string | null>

export function tenantResolver(db: Database): TenantResolver {
  const cache = new Map<string, string>()
  return async (agentTenantId) => {
    const hit = cache.get(agentTenantId)
    if (hit) return hit
    const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.agentTenantId, agentTenantId))
    if (!row) return null
    cache.set(agentTenantId, row.id)
    return row.id
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * Applies one outbox row. Returns the event to emit, or null when the row is stale (an older outbox
 * id than the mirror already holds) or belongs to no platform tenant. Exported for tests (pure apart
 * from the db/agent deps).
 */
export async function applyRow(deps: ConsumerDeps, resolve: TenantResolver, row: OutboxRow): Promise<{ tenantId: string; type: EventType; data: Record<string, unknown> } | null> {
  const tenantId = await resolve(row.tenantId)
  if (!tenantId) {
    deps.logger.warn({ agentTenantId: row.tenantId, outboxId: row.id }, 'outbox row for an unknown platform tenant')
    return null
  }
  const now = new Date()
  const guard = (table: { lastOutboxId: unknown }) => sql`${table.lastOutboxId} <= excluded.last_outbox_id`

  if (row.recordType === 'connection') {
    const [updated] = await deps.db
      .insert(connections)
      .values({ tenantId, recordId: row.recordId, state: row.state, invitationId: str(row.payload.outOfBandId), threadId: row.threadId, externalId: row.correlationId, lastOutboxId: row.id, updatedAt: now })
      .onConflictDoUpdate({
        target: [connections.tenantId, connections.recordId],
        set: { state: row.state, invitationId: sql`coalesce(excluded.invitation_id, ${connections.invitationId})`, threadId: sql`coalesce(excluded.thread_id, ${connections.threadId})`, externalId: sql`coalesce(${connections.externalId}, excluded.external_id)`, lastOutboxId: row.id, updatedAt: now },
        setWhere: guard(connections),
      })
      .returning()
    if (!updated) return null
    // An erased connection (Phase 7 H1) never gets its label back.
    if (row.state === 'completed' && !updated.theirLabel && !updated.erasedAt) {
      const detail = await deps.agent.getConnection(row.tenantId, row.recordId).catch(() => null)
      if (detail?.theirLabel) {
        updated.theirLabel = detail.theirLabel
        await deps.db.update(connections).set({ theirLabel: detail.theirLabel }).where(sql`${connections.tenantId} = ${tenantId} and ${connections.recordId} = ${row.recordId}`)
      }
    }
    return { tenantId, type: 'connection.state_changed', data: { ...toConnectionView(updated), previousState: row.previousState } }
  }

  if (row.recordType === 'credential') {
    const [updated] = await deps.db
      .insert(credentials)
      .values({ tenantId, recordId: row.recordId, state: row.state, connectionId: str(row.payload.connectionId), threadId: row.threadId, externalId: row.correlationId, lastOutboxId: row.id, updatedAt: now })
      .onConflictDoUpdate({
        target: [credentials.tenantId, credentials.recordId],
        set: { state: row.state, connectionId: sql`coalesce(excluded.connection_id, ${credentials.connectionId})`, threadId: sql`coalesce(excluded.thread_id, ${credentials.threadId})`, externalId: sql`coalesce(${credentials.externalId}, excluded.external_id)`, lastOutboxId: row.id, updatedAt: now },
        setWhere: guard(credentials),
      })
      .returning()
    if (!updated) return null
    // Offered attributes come from the command path; a row first seen here (or an abandonment
    // reason) is completed from the agent's detail view.
    // Erased rows (Phase 7 H1) are never refilled; the agent no longer has the record anyway.
    if (!updated.erasedAt && (!updated.credentialDefinitionId || row.state === 'abandoned')) {
      const detail = await deps.agent.getCredential(row.tenantId, row.recordId).catch(() => null)
      if (detail) {
        // The agent deletes a finished exchange's stored messages once this consumer has acknowledged
        // it, and the id comes from the stored offer: a replayed row must not empty the mirror.
        updated.credentialDefinitionId = detail.credentialDefinitionId ?? updated.credentialDefinitionId
        updated.attributes = detail.attributes
        updated.errorMessage = detail.errorMessage
        updated.expiresAt = expiryOf(detail.attributes)
        await deps.db.update(credentials).set({ credentialDefinitionId: updated.credentialDefinitionId, attributes: detail.attributes, expiresAt: updated.expiresAt, errorMessage: detail.errorMessage }).where(sql`${credentials.tenantId} = ${tenantId} and ${credentials.recordId} = ${row.recordId}`)
      }
    }
    const gate = deps.gates ? await deps.gates.onExchangeState(tenantId, 'credential', row.recordId, row.state) : undefined
    return { tenantId, type: 'credential.state_changed', data: { ...toCredentialView(updated, gate), previousState: row.previousState } }
  }

  const [updated] = await deps.db
    .insert(proofs)
    .values({ tenantId, recordId: row.recordId, state: row.state, connectionId: str(row.payload.connectionId), threadId: row.threadId, externalId: row.correlationId, verified: typeof row.payload.isVerified === 'boolean' ? row.payload.isVerified : null, lastOutboxId: row.id, updatedAt: now })
    .onConflictDoUpdate({
      target: [proofs.tenantId, proofs.recordId],
      set: { state: row.state, connectionId: sql`coalesce(excluded.connection_id, ${proofs.connectionId})`, threadId: sql`coalesce(excluded.thread_id, ${proofs.threadId})`, externalId: sql`coalesce(${proofs.externalId}, excluded.external_id)`, verified: sql`coalesce(excluded.verified, ${proofs.verified})`, lastOutboxId: row.id, updatedAt: now },
      setWhere: guard(proofs),
    })
    .returning()
  if (!updated) return null
  if ((row.state === 'done' || row.state === 'abandoned') && !updated.erasedAt) {
    const detail = await deps.agent.getProof(row.tenantId, row.recordId).catch(() => null)
    if (detail) {
      updated.verified = detail.isVerified
      // As for credentials above: the disclosed values come from the stored presentation.
      const disclosed = updated.disclosed && Object.keys(detail.disclosed).length === 0 ? updated.disclosed : detail.disclosed
      updated.disclosed = row.state === 'done' ? disclosed : null
      updated.errorMessage = detail.errorMessage
      await deps.db.update(proofs).set({ verified: updated.verified, disclosed: updated.disclosed, errorMessage: updated.errorMessage }).where(sql`${proofs.tenantId} = ${tenantId} and ${proofs.recordId} = ${row.recordId}`)
    }
  }
  // A gated proof's verified/disclosed are withheld from the view until its gate has passed.
  const gate = deps.gates ? await deps.gates.onExchangeState(tenantId, 'proof', row.recordId, row.state) : undefined
  return { tenantId, type: 'proof.state_changed', data: { ...toProofView(updated, gate), previousState: row.previousState } }
}

export function createOutboxConsumer(deps: ConsumerDeps) {
  const log = deps.logger.child({ component: 'outbox-consumer' })
  const resolve = tenantResolver(deps.db)
  const batch = deps.batch ?? 200

  async function readCursor(): Promise<number> {
    const [row] = await deps.db.select({ lastId: outboxCursor.lastId }).from(outboxCursor).where(eq(outboxCursor.id, CURSOR_ID))
    return row?.lastId ?? 0
  }

  async function writeCursor(lastId: number) {
    await deps.db.insert(outboxCursor).values({ id: CURSOR_ID, lastId, updatedAt: new Date() }).onConflictDoUpdate({ target: outboxCursor.id, set: { lastId, updatedAt: new Date() } })
  }

  /** One poll: applies up to `batch` rows. Returns how many rows were read. */
  async function runOnce(): Promise<number> {
    const after = await readCursor()
    const { rows } = await deps.agent.readOutbox(after, batch)
    for (const row of rows) {
      const event = await applyRow(deps, resolve, row)
      if (event) {
        const deliveryId = await enqueueEvent(deps.db, deps.endpoints, event.tenantId, event.type, event.data, outboxEventId(row.id))
        log.debug({ outboxId: row.id, recordType: row.recordType, state: row.state, deliveryId }, 'outbox row applied')
      }
      // Advance per row so a failure mid-batch resumes exactly there.
      await writeCursor(row.id)
    }
    if (rows.length > 0) await deps.agent.ackOutbox(rows[rows.length - 1].id).catch(() => undefined)
    return rows.length
  }

  function start(pollMs: number) {
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    const tick = async () => {
      if (stopped) return
      try {
        const read = await runOnce()
        timer = setTimeout(tick, read >= batch ? 0 : pollMs)
      } catch (error) {
        log.error({ err: error }, 'outbox poll failed')
        timer = setTimeout(tick, pollMs)
      }
    }
    void tick()
    return async () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  return { runOnce, start, readCursor }
}
