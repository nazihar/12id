/**
 * Biometric gate engine (Phase 6 B3, 15-phase-6-biometric.md "Gate engine").
 *
 * A gated exchange has two independent halves that can arrive in either order:
 *   - the exchange parks at its hold state (credential request-received / proof presentation-received);
 *   - the check is decided (passed, failed after the last attempt, expired, or cancelled).
 * `advance()` acts when both are known: issue/accept on a pass, abandon otherwise. It is
 * single-flight per gate in this process and compare-and-set in the database (trap 38), so the
 * agent is told the outcome at most once (`settled_at`).
 *
 * Every transition writes a row to the biometric log (`exchange_gate_events`). No image passes
 * through here: the reference goes straight to biometric-service, capture output is opaque.
 */
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'
import { z } from 'zod'

import { AgentError, type AgentClient } from '../agent-client.ts'
import { BiometricError, type BiometricClient, type ProviderCatalogueEntry } from '../biometric-client.ts'
import type { Database } from '../db/client.ts'
import { type GateEventType, exchangeGateEvents, exchangeGates, tenants, wallets } from '../db/schema.ts'
import { PlatformError } from '../http/errors.ts'
import { type EndpointLookup, enqueueEvent } from '../webhooks/events.ts'
import { conditionOutcome } from './policy.ts'

export type Gate = typeof exchangeGates.$inferSelect
export type RecordType = Gate['recordType']

const HOLD_STATE: Record<RecordType, string> = { credential: 'request-received', proof: 'presentation-received' }
const CLOSED_EXCHANGE_STATES = ['abandoned', 'declined']

export const biometricView = z
  .object({
    required: z.literal(true),
    status: z.enum(['pending', 'passed', 'failed', 'expired', 'cancelled']),
    attempts: z.number().int(),
    attemptsRemaining: z.number().int(),
    livenessScore: z.number().nullable(),
    matchScore: z.number().nullable(),
    reason: z.string().nullable(),
    expiresAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
  })
  .nullable()
export type BiometricView = z.infer<typeof biometricView>

export function toBiometricView(gate: Gate | undefined | null): BiometricView {
  if (!gate) return null
  return {
    required: true,
    status: gate.status,
    attempts: gate.attempts,
    attemptsRemaining: gate.status === 'pending' ? Math.max(0, gate.maxAttempts - gate.attempts) : 0,
    livenessScore: gate.livenessScore,
    matchScore: gate.matchScore,
    reason: gate.reason,
    expiresAt: gate.expiresAt.toISOString(),
    decidedAt: gate.decidedAt?.toISOString() ?? null,
  }
}

export const gateEventView = z.object({
  id: z.number().int(),
  at: z.iso.datetime(),
  type: z.string(),
  attempt: z.number().int().nullable(),
  providerId: z.string().nullable(),
  vendorSessionId: z.string().nullable(),
  livenessScore: z.number().nullable(),
  matchScore: z.number().nullable(),
  thresholds: z.object({ minLivenessScore: z.number(), minMatchScore: z.number() }).nullable(),
  decision: z.string().nullable(),
  reason: z.string().nullable(),
})

/** `condition`: what a proof template's conditional rule decided, with the numbers sent; null without a rule (and for credentials). */
export const biometricLogView = z.object({ biometric: biometricView, condition: conditionOutcome.nullable(), events: z.array(gateEventView) })

/** Gates for a page of mirror rows, keyed by record id. */
export async function gatesFor(db: Database, tenantId: string, recordType: RecordType, recordIds: string[]): Promise<Map<string, Gate>> {
  if (recordIds.length === 0) return new Map()
  const rows = await db.select().from(exchangeGates).where(and(eq(exchangeGates.tenantId, tenantId), eq(exchangeGates.recordType, recordType), inArray(exchangeGates.recordId, recordIds)))
  return new Map(rows.map((row) => [row.recordId, row]))
}

export interface GateDeps {
  db: Database
  agent: AgentClient
  biometric: BiometricClient
  endpoints: EndpointLookup
  logger: PinoLogger
}

export interface WalletPrincipal {
  id: string
  tenantId: string
}

export function createGateEngine(deps: GateDeps) {
  const log = deps.logger.child({ component: 'biometric-gate' })
  const inflight = new Map<string, Promise<void>>()
  let catalogue: Map<string, ProviderCatalogueEntry> | undefined

  async function captureModuleFor(providerId: string) {
    if (!catalogue?.has(providerId)) {
      const { providers } = await deps.biometric.providers()
      catalogue = new Map(providers.map((p) => [p.id, p]))
    }
    const entry = catalogue.get(providerId)
    if (!entry) throw new PlatformError(409, 'provider_unavailable', `biometric provider ${providerId} is not offered`)
    return entry.captureModule
  }

  async function event(gate: Gate, type: GateEventType, extra: Partial<typeof exchangeGateEvents.$inferInsert> = {}) {
    await deps.db.insert(exchangeGateEvents).values({ gateId: gate.id, tenantId: gate.tenantId, type, providerId: gate.providerId, ...extra })
  }

  async function load(gateId: string) {
    const [gate] = await deps.db.select().from(exchangeGates).where(eq(exchangeGates.id, gateId))
    return gate
  }

  async function agentTenantId(tenantId: string) {
    const [row] = await deps.db.select({ agentTenantId: tenants.agentTenantId }).from(tenants).where(eq(tenants.id, tenantId))
    if (!row) throw new Error(`unknown tenant ${tenantId}`)
    return row.agentTenantId
  }

  async function notify(gate: Gate, attempt?: { attempt: number; decision: string; reason: string; livenessScore: number | null; matchScore: number | null }) {
    await enqueueEvent(deps.db, deps.endpoints, gate.tenantId, 'biometric.check_completed', {
      recordType: gate.recordType,
      recordId: gate.recordId,
      threadId: gate.threadId,
      attempt: attempt ?? null,
      biometric: toBiometricView(gate),
    })
  }

  /** Marks the gate settled (compare-and-set). Returns false when someone else already did. */
  async function settle(gate: Gate): Promise<boolean> {
    const rows = await deps.db.update(exchangeGates).set({ settledAt: new Date(), updatedAt: new Date() }).where(and(eq(exchangeGates.id, gate.id), isNull(exchangeGates.settledAt))).returning({ id: exchangeGates.id })
    return rows.length === 1
  }

  async function run(gateId: string) {
    const gate = await load(gateId)
    if (!gate || gate.settledAt) return
    const tenant = await agentTenantId(gate.tenantId)

    if (gate.status === 'passed') {
      if (!gate.holdReachedAt) return
      try {
        if (gate.recordType === 'credential') await deps.agent.issueCredential(tenant, gate.recordId)
        else await deps.agent.acceptPresentation(tenant, gate.recordId)
      } catch (error) {
        // 409: the exchange left its hold state (e.g. reconciled); nothing to release.
        // Settle anyway, so the retry loop does not try again forever.
        if (error instanceof AgentError && error.status === 409) {
          log.warn({ gateId, recordId: gate.recordId, reason: error.message }, 'gate passed but the exchange is no longer held')
          if (await settle(gate)) await event(gate, 'cancelled', { reason: `exchange no longer held: ${error.message}`.slice(0, 500) })
          return
        }
        throw error
      }
      if (await settle(gate)) await event(gate, gate.recordType === 'credential' ? 'issued' : 'accepted')
      return
    }

    if (gate.status === 'failed' || gate.status === 'expired') {
      const reason = gate.status === 'expired' ? 'biometric check expired' : 'biometric check failed'
      try {
        if (gate.recordType === 'credential') await deps.agent.abandonCredential(tenant, gate.recordId, reason)
        else await deps.agent.abandonProof(tenant, gate.recordId, reason)
      } catch (error) {
        if (!(error instanceof AgentError && error.status === 404)) throw error
      }
      if (await settle(gate)) await event(gate, 'declined', { reason })
    }
  }

  /** Single-flight per gate within this process. */
  function advance(gateId: string): Promise<void> {
    const previous = inflight.get(gateId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => run(gateId))
    const tracked = next.finally(() => {
      if (inflight.get(gateId) === tracked) inflight.delete(gateId)
    })
    inflight.set(gateId, tracked)
    return tracked
  }

  async function gateForThread(wallet: WalletPrincipal, threadId: string) {
    const [gate] = await deps.db.select().from(exchangeGates).where(and(eq(exchangeGates.tenantId, wallet.tenantId), eq(exchangeGates.threadId, threadId)))
    return gate
  }

  return {
    advance,

    /** Called by the outbox consumer for every credential/proof transition. */
    async onExchangeState(tenantId: string, recordType: RecordType, recordId: string, state: string): Promise<Gate | undefined> {
      let [gate] = await deps.db.select().from(exchangeGates).where(and(eq(exchangeGates.tenantId, tenantId), eq(exchangeGates.recordType, recordType), eq(exchangeGates.recordId, recordId)))
      if (!gate) return undefined

      if (state === HOLD_STATE[recordType] && !gate.holdReachedAt) {
        const [held] = await deps.db.update(exchangeGates).set({ holdReachedAt: new Date(), updatedAt: new Date() }).where(and(eq(exchangeGates.id, gate.id), isNull(exchangeGates.holdReachedAt))).returning()
        if (held) {
          gate = held
          await event(gate, 'hold_reached')
          await advance(gate.id).catch((error: unknown) => log.error({ err: error, gateId: gate!.id }, 'gate advance failed'))
        }
      } else if (CLOSED_EXCHANGE_STATES.includes(state) && gate.status === 'pending') {
        // The holder declined or the exchange was reconciled away: nothing left to guard.
        const [closed] = await deps.db
          .update(exchangeGates)
          .set({ status: 'cancelled', reason: 'exchange closed', decidedAt: new Date(), settledAt: new Date(), updatedAt: new Date() })
          .where(and(eq(exchangeGates.id, gate.id), eq(exchangeGates.status, 'pending')))
          .returning()
        if (closed) {
          gate = closed
          await event(gate, 'cancelled', { reason: `exchange ${state}` })
          await deps.biometric.cancelCheck(gate.checkId).catch((error: unknown) => log.warn({ err: error, gateId: gate!.id }, 'check cancel failed'))
        }
      }
      return (await load(gate.id)) ?? gate
    },

    /** What the SDK sees for the exchanges it holds. Other tenants' threads are omitted. */
    async requirements(wallet: WalletPrincipal, threadIds: string[]) {
      if (threadIds.length === 0) return []
      const rows = await deps.db.select().from(exchangeGates).where(and(eq(exchangeGates.tenantId, wallet.tenantId), inArray(exchangeGates.threadId, threadIds)))
      return Promise.all(rows.map(async (gate) => ({
        threadId: gate.threadId,
        recordType: gate.recordType,
        status: gate.status,
        attemptsRemaining: toBiometricView(gate)!.attemptsRemaining,
        captureProvider: (await captureModuleFor(gate.providerId).catch(() => null))?.provider ?? gate.providerId,
        expiresAt: gate.expiresAt.toISOString(),
      })))
    },

    async startSession(wallet: WalletPrincipal, threadId: string, captureModules: Array<{ provider: string; version: number }>) {
      const gate = await gateForThread(wallet, threadId)
      if (!gate) throw new PlatformError(404, 'not_found', 'no biometric check for this exchange')
      if (gate.status !== 'pending') throw new PlatformError(409, `check_${gate.status}`, `the biometric check is ${gate.status}`)
      if (gate.expiresAt.getTime() <= Date.now()) throw new PlatformError(409, 'check_expired', 'the biometric check has expired')

      const needed = await captureModuleFor(gate.providerId)
      await deps.db.update(wallets).set({ captureModules: captureModules.map((m) => `${m.provider}@${m.version}`) }).where(eq(wallets.id, wallet.id))
      if (!captureModules.some((m) => m.provider === needed.provider && m.version >= needed.minVersion)) {
        throw new PlatformError(409, 'capture_module_missing', `this app has no capture add-on for ${needed.provider} (version ${needed.minVersion} or later)`)
      }

      let started
      try {
        started = await deps.biometric.startSession(gate.checkId)
      } catch (error) {
        if (error instanceof BiometricError && error.status < 500) throw new PlatformError(409, error.code, error.message)
        throw error
      }
      await deps.db.update(exchangeGates).set({ attempts: started.attempt, updatedAt: new Date() }).where(eq(exchangeGates.id, gate.id))
      await event(gate, 'session_started', { attempt: started.attempt, sessionId: started.sessionId, vendorSessionId: started.vendorSessionId })
      return { sessionId: started.sessionId, provider: started.captureModule.provider, clientConfig: started.clientConfig, attempt: started.attempt, attemptsRemaining: started.attemptsRemaining }
    },

    async completeSession(wallet: WalletPrincipal, sessionId: string, clientOutput: unknown) {
      const [started] = await deps.db
        .select({ gateId: exchangeGateEvents.gateId })
        .from(exchangeGateEvents)
        .where(and(eq(exchangeGateEvents.sessionId, sessionId), eq(exchangeGateEvents.type, 'session_started'), eq(exchangeGateEvents.tenantId, wallet.tenantId)))
      if (!started) throw new PlatformError(404, 'not_found', 'no such biometric session')
      const gate = await load(started.gateId)
      if (!gate) throw new PlatformError(404, 'not_found', 'no such biometric session')

      let done
      try {
        done = await deps.biometric.completeSession(sessionId, clientOutput)
      } catch (error) {
        if (error instanceof BiometricError && error.status < 500) throw new PlatformError(409, error.code, error.message)
        throw error
      }

      const status = done.check.status === 'pending' ? 'pending' : done.check.status
      const decided = status !== 'pending'
      const [updated] = await deps.db
        .update(exchangeGates)
        .set({
          status,
          attempts: done.attempt,
          livenessScore: done.result.livenessScore,
          matchScore: done.result.matchScore,
          reason: done.result.reason,
          ...(decided ? { decidedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(exchangeGates.id, gate.id), eq(exchangeGates.status, 'pending')))
        .returning()
      const current = updated ?? (await load(gate.id))!
      await event(current, 'attempt_completed', {
        attempt: done.attempt,
        sessionId,
        vendorSessionId: done.vendorSessionId,
        livenessScore: done.result.livenessScore,
        matchScore: done.result.matchScore,
        thresholds: gate.thresholds,
        decision: done.result.decision,
        reason: done.result.reason,
      })
      await notify(current, { attempt: done.attempt, ...done.result })
      if (decided) await advance(current.id).catch((error: unknown) => log.error({ err: error, gateId: current.id }, 'gate advance failed'))

      const outcome = done.result.decision === 'passed' ? 'passed' : done.check.status === 'pending' ? 'failed' : 'locked'
      return { outcome, attemptsRemaining: done.check.attemptsRemaining } as const
    },

    /** Expires overdue pending gates and abandons their exchanges. */
    async expireDue(now = new Date()) {
      const due = await deps.db
        .update(exchangeGates)
        .set({ status: 'expired', reason: 'expired', decidedAt: now, updatedAt: now })
        .where(and(eq(exchangeGates.status, 'pending'), lte(exchangeGates.expiresAt, now)))
        .returning()
      for (const gate of due) {
        await event(gate, 'expired', { reason: 'expired' })
        await notify(gate)
        await advance(gate.id).catch((error: unknown) => log.error({ err: error, gateId: gate.id }, 'gate advance failed'))
      }
      // Retry gates decided earlier whose agent call failed (settled_at still null).
      const unsettled = await deps.db
        .select({ id: exchangeGates.id })
        .from(exchangeGates)
        .where(and(isNull(exchangeGates.settledAt), sql`(${exchangeGates.status} in ('failed', 'expired') or (${exchangeGates.status} = 'passed' and ${exchangeGates.holdReachedAt} is not null))`))
        .limit(50)
      for (const { id } of unsettled) await advance(id).catch((error: unknown) => log.error({ err: error, gateId: id }, 'gate retry failed'))
      return due.length
    },

    log: (tenantId: string, recordType: RecordType, recordId: string) => gateLog(deps.db, tenantId, recordType, recordId),
  }
}

/**
 * The biometric log of one exchange: its gate and every step, oldest first. A read of platform-api's
 * own tables, so it needs no gate engine: the log of a past check stays readable on a deployment
 * that runs without biometric-service (implement/22 C10).
 */
export async function gateLog(db: Database, tenantId: string, recordType: RecordType, recordId: string) {
  const [gate] = await db.select().from(exchangeGates).where(and(eq(exchangeGates.tenantId, tenantId), eq(exchangeGates.recordType, recordType), eq(exchangeGates.recordId, recordId)))
  if (!gate) return { biometric: null, events: [] }
  const rows = await db.select().from(exchangeGateEvents).where(eq(exchangeGateEvents.gateId, gate.id)).orderBy(asc(exchangeGateEvents.id))
  return {
    biometric: toBiometricView(gate),
    events: rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      type: row.type,
      attempt: row.attempt,
      providerId: row.providerId,
      vendorSessionId: row.vendorSessionId,
      livenessScore: row.livenessScore,
      matchScore: row.matchScore,
      thresholds: row.thresholds,
      decision: row.decision,
      reason: row.reason,
    })),
  }
}

export type GateEngine = ReturnType<typeof createGateEngine>
