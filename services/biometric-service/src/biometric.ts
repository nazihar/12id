/**
 * biometric-service core (15-phase-6-biometric.md B1): tenant provider configuration, checks,
 * sessions and the pass/fail decision. HTTP-agnostic; http/api.ts maps ServiceError to statuses.
 *
 * Invariants:
 * - An attempt is counted when its session starts, so abandoned sessions still use up attempts.
 * - A session completes at most once (started → completing claim).
 * - The reference image is wiped when the check is decided, expired or cancelled; the probe image
 *   is never stored (only its sha256).
 */
import { createHash, randomUUID } from 'node:crypto'

import type {
  CheckResponse,
  CompleteSessionResponse,
  CreateCheckBody,
  DecisionReason,
  TenantProviderResponse,
  Thresholds,
} from '@12id/credo-base/biometric-contract.ts'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { Logger } from 'pino'

import { KeyRing, aad, open, seal } from './crypto.ts'
import type { Database } from './db/client.ts'
import { checks, providerConfigs, providerConfigsPending, results, sessions, tenantKeys } from './db/schema.ts'
import { catalogueEntry } from './providers/registry.ts'
import { type BiometricProvider, type ProviderContext, ProviderError, type SessionOutcome } from './providers/types.ts'

export class ServiceError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, reason: string) {
    super(reason)
    this.status = status
    this.code = code
  }
}

const MAX_REFERENCE_BYTES = 5 * 1024 * 1024

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Strict base64 → JPEG/PNG bytes, or a 400. */
export function decodeReferenceImage(base64: string): Buffer {
  const cleaned = base64.replace(/^data:image\/(jpeg|png);base64,/, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) throw new ServiceError(400, 'invalid_reference_image', 'referenceImage must be base64')
  const bytes = Buffer.from(cleaned, 'base64')
  if (bytes.length > MAX_REFERENCE_BYTES) throw new ServiceError(400, 'invalid_reference_image', 'referenceImage is larger than 5 MB')
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!jpeg && !png) throw new ServiceError(400, 'invalid_reference_image', 'referenceImage must be a JPEG or PNG')
  return bytes
}

/** The decision for one attempt. Adapters only report scores. */
export function decide(thresholds: Thresholds, outcome: SessionOutcome, matchScore: number | null): { decision: 'passed' | 'failed'; reason: DecisionReason } {
  if (outcome.status === 'failed') return { decision: 'failed', reason: outcome.reason }
  if (outcome.status !== 'ready') throw new Error('decide() needs a finished outcome')
  if (outcome.livenessScore < thresholds.minLivenessScore) return { decision: 'failed', reason: 'liveness_below_threshold' }
  if (matchScore === null) return { decision: 'failed', reason: 'no_face' }
  if (matchScore < thresholds.minMatchScore) return { decision: 'failed', reason: 'match_below_threshold' }
  return { decision: 'passed', reason: 'passed' }
}

export interface BiometricServiceOptions {
  db: Database
  keyRing: KeyRing
  providers: Map<string, BiometricProvider>
  logger: Logger
}

export function createBiometricService({ db, keyRing, providers, logger }: BiometricServiceOptions) {
  async function tenantKey(tenantId: string): Promise<{ dataKey: Buffer; externalId: string }> {
    let [row] = await db.select().from(tenantKeys).where(eq(tenantKeys.tenantId, tenantId))
    if (!row) {
      const { wrapped } = keyRing.newWrappedDataKey(tenantId)
      await db.insert(tenantKeys).values({ tenantId, wrappedKey: wrapped, externalId: `12id-${randomUUID()}` }).onConflictDoNothing()
      ;[row] = await db.select().from(tenantKeys).where(eq(tenantKeys.tenantId, tenantId))
    }
    return { dataKey: keyRing.unwrap(tenantId, row!.wrappedKey), externalId: row!.externalId }
  }

  async function providerContext(tenantId: string): Promise<{ provider: BiometricProvider; ctx: ProviderContext }> {
    const [row] = await db.select().from(providerConfigs).where(eq(providerConfigs.tenantId, tenantId))
    if (!row) throw new ServiceError(409, 'provider_not_configured', 'the tenant has no biometric provider')
    const provider = providers.get(row.providerId)
    if (!provider) throw new ServiceError(409, 'provider_unavailable', `provider '${row.providerId}' is not offered by this deployment`)
    const { dataKey, externalId } = await tenantKey(tenantId)
    const config = JSON.parse(open(dataKey, row.configCiphertext, aad.providerConfig(tenantId)).toString('utf8')) as Record<string, unknown>
    return { provider, ctx: { tenantId, config, externalId } }
  }

  function providerFailure(error: unknown): never {
    if (error instanceof ProviderError) {
      throw new ServiceError(error.code === 'access_denied' ? 424 : 502, `provider_${error.code}`, error.message)
    }
    throw error
  }

  /** Validates a provider configuration and encrypts it with the tenant's key. */
  async function sealedConfig(tenantId: string, providerId: string, rawConfig: Record<string, unknown>) {
    const provider = providers.get(providerId)
    if (!provider) throw new ServiceError(400, 'unknown_provider', `provider '${providerId}' is not offered by this deployment`)
    const parsed = provider.configSchema.safeParse(rawConfig)
    if (!parsed.success) {
      throw new ServiceError(400, 'invalid_provider_config', parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; '))
    }
    const { dataKey } = await tenantKey(tenantId)
    return {
      providerId,
      configCiphertext: seal(dataKey, Buffer.from(JSON.stringify(parsed.data)), aad.providerConfig(tenantId)),
      publicConfig: provider.publicConfig(parsed.data),
    }
  }

  async function wipeReference(checkId: string) {
    await db.update(checks).set({ referenceCiphertext: null }).where(eq(checks.id, checkId))
  }

  return {
    catalogue() {
      return { providers: [...providers.values()].map(catalogueEntry) }
    },

    async getTenantProvider(tenantId: string): Promise<TenantProviderResponse> {
      const { externalId } = await tenantKey(tenantId)
      const [row] = await db.select().from(providerConfigs).where(eq(providerConfigs.tenantId, tenantId))
      return {
        tenantId,
        externalId,
        provider: row
          ? {
              id: row.providerId,
              publicConfig: row.publicConfig,
              status: row.status,
              lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
              lastError: row.lastError,
              updatedAt: row.updatedAt.toISOString(),
            }
          : null,
      }
    },

    async putTenantProvider(tenantId: string, providerId: string, rawConfig: Record<string, unknown>) {
      const sealed = await sealedConfig(tenantId, providerId, rawConfig)
      const values = { ...sealed, status: 'untested' as const, lastTestedAt: null, lastError: null, updatedAt: new Date() }
      await db.insert(providerConfigs).values({ tenantId, ...values }).onConflictDoUpdate({ target: providerConfigs.tenantId, set: values })
      return this.getTenantProvider(tenantId)
    },

    /**
     * A configuration that waits for a second person (platform-api holds the request). Validated and
     * encrypted now, exactly as an active one; nothing uses it until it is activated.
     */
    async putPendingProvider(tenantId: string, providerId: string, rawConfig: Record<string, unknown>) {
      const sealed = await sealedConfig(tenantId, providerId, rawConfig)
      const values = { ...sealed, createdAt: new Date() }
      await db.insert(providerConfigsPending).values({ tenantId, ...values }).onConflictDoUpdate({ target: providerConfigsPending.tenantId, set: values })
      return { providerId: sealed.providerId, publicConfig: sealed.publicConfig }
    },

    /** The waiting configuration becomes the active one (untested, like any new configuration). */
    async activatePendingProvider(tenantId: string) {
      await db.transaction(async (tx) => {
        const [pending] = await tx.delete(providerConfigsPending).where(eq(providerConfigsPending.tenantId, tenantId)).returning()
        if (!pending) throw new ServiceError(404, 'no_pending_provider', 'no provider configuration is waiting for this tenant')
        const values = { providerId: pending.providerId, configCiphertext: pending.configCiphertext, publicConfig: pending.publicConfig, status: 'untested' as const, lastTestedAt: null, lastError: null, updatedAt: new Date() }
        await tx.insert(providerConfigs).values({ tenantId, ...values }).onConflictDoUpdate({ target: providerConfigs.tenantId, set: values })
      })
      return this.getTenantProvider(tenantId)
    },

    async deletePendingProvider(tenantId: string) {
      await db.delete(providerConfigsPending).where(eq(providerConfigsPending.tenantId, tenantId))
    },

    async deleteTenantProvider(tenantId: string) {
      await db.delete(providerConfigs).where(eq(providerConfigs.tenantId, tenantId))
    },

    async testTenantProvider(tenantId: string) {
      const { provider, ctx } = await providerContext(tenantId)
      let status: 'ok' | 'failed' = 'ok'
      let error: string | null = null
      try {
        await provider.testConnection(ctx)
      } catch (e) {
        status = 'failed'
        error = e instanceof Error ? e.message.slice(0, 500) : String(e)
      }
      await db.update(providerConfigs).set({ status, lastError: error, lastTestedAt: new Date() }).where(eq(providerConfigs.tenantId, tenantId))
      return { status, error }
    },

    async createCheck(body: CreateCheckBody) {
      const image = decodeReferenceImage(body.referenceImage)
      const [config] = await db.select().from(providerConfigs).where(eq(providerConfigs.tenantId, body.tenantId))
      if (!config) throw new ServiceError(409, 'provider_not_configured', 'the tenant has no biometric provider')
      if (config.status !== 'ok') throw new ServiceError(409, 'provider_not_tested', 'the tenant provider has not passed a connection test')
      const { dataKey } = await tenantKey(body.tenantId)
      const id = randomUUID()
      const expiresAt = new Date(Date.now() + body.ttlSeconds * 1000)
      await db.insert(checks).values({
        id,
        tenantId: body.tenantId,
        purpose: body.purpose,
        providerId: config.providerId,
        thresholds: body.thresholds,
        referenceCiphertext: seal(dataKey, image, aad.referenceImage(body.tenantId, id)),
        referenceSha256: sha256(image),
        maxAttempts: body.maxAttempts,
        expiresAt,
      })
      logger.info({ checkId: id, tenantId: body.tenantId, purpose: body.purpose, providerId: config.providerId }, 'check created')
      return { checkId: id, providerId: config.providerId, expiresAt: expiresAt.toISOString() }
    },

    async startSession(checkId: string) {
      // An overdue check is expired outside the transaction: throwing inside it would roll the expiry back.
      const [due] = await db
        .update(checks)
        .set({ status: 'expired', decidedAt: new Date(), referenceCiphertext: null })
        .where(and(eq(checks.id, checkId), eq(checks.status, 'pending'), lte(checks.expiresAt, new Date())))
        .returning({ id: checks.id })
      if (due) throw new ServiceError(409, 'check_expired', 'the check has expired')

      return db.transaction(async (tx) => {
        const [check] = await tx.select().from(checks).where(eq(checks.id, checkId)).for('update')
        if (!check) throw new ServiceError(404, 'check_not_found', 'no such check')
        if (check.status === 'pending' && check.expiresAt.getTime() <= Date.now()) throw new ServiceError(409, 'check_expired', 'the check has expired')
        if (check.status !== 'pending') throw new ServiceError(409, `check_${check.status}`, `the check is ${check.status}`)
        if (check.attempts >= check.maxAttempts) throw new ServiceError(409, 'attempts_exhausted', 'no attempts left')

        const { provider, ctx } = await providerContext(check.tenantId)
        if (provider.id !== check.providerId) throw new ServiceError(409, 'provider_changed', 'the tenant provider changed after the check was created')
        const attempt = check.attempts + 1
        const created = await provider.createSession(ctx, { checkId, attempt }).catch(providerFailure)
        const sessionId = randomUUID()
        await tx.update(checks).set({ attempts: attempt }).where(eq(checks.id, checkId))
        await tx.insert(sessions).values({ id: sessionId, checkId, tenantId: check.tenantId, attempt, vendorSessionId: created.vendorSessionId })
        logger.info({ checkId, sessionId, attempt, vendorSessionId: created.vendorSessionId }, 'session started')
        return {
          sessionId,
          vendorSessionId: created.vendorSessionId,
          providerId: provider.id,
          captureModule: provider.captureModule,
          clientConfig: created.clientConfig,
          attempt,
          attemptsRemaining: check.maxAttempts - attempt,
        }
      })
    },

    async completeSession(sessionId: string, clientOutput: unknown): Promise<CompleteSessionResponse> {
      const [claimed] = await db
        .update(sessions)
        .set({ status: 'completing' })
        .where(and(eq(sessions.id, sessionId), eq(sessions.status, 'started')))
        .returning()
      if (!claimed) {
        const [existing] = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, sessionId))
        if (!existing) throw new ServiceError(404, 'session_not_found', 'no such session')
        throw new ServiceError(409, 'session_already_completed', 'the session was already completed')
      }
      const release = () => db.update(sessions).set({ status: 'started' }).where(eq(sessions.id, sessionId))

      const [check] = await db.select().from(checks).where(eq(checks.id, claimed.checkId))
      if (!check || check.status !== 'pending') {
        await db.update(sessions).set({ status: 'completed', completedAt: new Date() }).where(eq(sessions.id, sessionId))
        throw new ServiceError(409, `check_${check?.status ?? 'missing'}`, `the check is ${check?.status ?? 'missing'}`)
      }

      let outcome: SessionOutcome
      let matchScore: number | null = null
      let matchRaw: Record<string, unknown> = {}
      try {
        const { provider, ctx } = await providerContext(check.tenantId)
        // Only an erased check has no vendor session id, and an erased check is never pending.
        if (!claimed.vendorSessionId) throw new ServiceError(409, 'check_erased', 'the check was erased')
        outcome = await provider.completeSession(ctx, { vendorSessionId: claimed.vendorSessionId, clientOutput })
        if (outcome.status === 'pending') throw new ServiceError(409, 'result_not_ready', 'the vendor has no result for this session yet')
        if (outcome.status === 'ready') {
          if (outcome.matchScore !== undefined) {
            matchScore = outcome.matchScore
          } else {
            if (!check.referenceCiphertext) throw new ServiceError(409, 'reference_missing', 'the reference image is no longer available')
            const { dataKey } = await tenantKey(check.tenantId)
            const reference = open(dataKey, check.referenceCiphertext, aad.referenceImage(check.tenantId, check.id))
            const matched = await provider.matchFaces(ctx, reference, outcome.probeImage)
            reference.fill(0)
            matchScore = matched.matchScore
            matchRaw = matched.raw
          }
        }
      } catch (error) {
        await release()
        if (error instanceof ServiceError) throw error
        providerFailure(error)
      }

      const { decision, reason } = decide(check.thresholds, outcome, matchScore)
      const livenessScore = outcome.status === 'ready' ? outcome.livenessScore : null
      const probeSha256 = outcome.status === 'ready' ? sha256(outcome.probeImage) : null
      if (outcome.status === 'ready') outcome.probeImage.fill(0)
      const exhausted = check.attempts >= check.maxAttempts
      const nextStatus = decision === 'passed' ? 'passed' : exhausted ? 'failed' : 'pending'

      const updated = await db.transaction(async (tx) => {
        await tx.insert(results).values({
          sessionId,
          checkId: check.id,
          decision,
          reason,
          livenessScore,
          matchScore,
          raw: { ...outcome.raw, match: matchRaw },
          probeSha256,
        })
        await tx.update(sessions).set({ status: 'completed', completedAt: new Date() }).where(eq(sessions.id, sessionId))
        if (nextStatus === 'pending') return check
        const [row] = await tx
          .update(checks)
          .set({ status: nextStatus, decidedAt: new Date(), referenceCiphertext: null })
          .where(and(eq(checks.id, check.id), eq(checks.status, 'pending')))
          .returning()
        return row ?? check
      })

      logger.info({ checkId: check.id, sessionId, attempt: claimed.attempt, decision, reason, livenessScore, matchScore, checkStatus: updated.status }, 'attempt decided')
      return {
        sessionId,
        vendorSessionId: claimed.vendorSessionId,
        attempt: claimed.attempt,
        result: { decision, reason, livenessScore, matchScore },
        check: { status: updated.status, attemptsRemaining: updated.status === 'pending' ? updated.maxAttempts - updated.attempts : 0 },
      }
    },

    async getCheck(checkId: string): Promise<CheckResponse> {
      const [check] = await db.select().from(checks).where(eq(checks.id, checkId))
      if (!check) throw new ServiceError(404, 'check_not_found', 'no such check')
      const rows = await db.select().from(sessions).where(eq(sessions.checkId, checkId)).orderBy(asc(sessions.attempt))
      const resultRows = rows.length ? await db.select().from(results).where(inArray(results.sessionId, rows.map((r) => r.id))) : []
      const byId = new Map(resultRows.map((r) => [r.sessionId, r]))
      return {
        checkId: check.id,
        tenantId: check.tenantId,
        purpose: check.purpose,
        providerId: check.providerId,
        status: check.status,
        thresholds: check.thresholds,
        attempts: check.attempts,
        maxAttempts: check.maxAttempts,
        expiresAt: check.expiresAt.toISOString(),
        decidedAt: check.decidedAt?.toISOString() ?? null,
        sessions: rows.map((s) => {
          const r = byId.get(s.id)
          return {
            sessionId: s.id,
            attempt: s.attempt,
            vendorSessionId: s.vendorSessionId,
            status: s.status,
            startedAt: s.startedAt.toISOString(),
            completedAt: s.completedAt?.toISOString() ?? null,
            result: r ? { decision: r.decision, reason: r.reason as DecisionReason, livenessScore: r.livenessScore, matchScore: r.matchScore } : null,
          }
        }),
      }
    },

    async cancelCheck(checkId: string) {
      const [row] = await db
        .update(checks)
        .set({ status: 'cancelled', decidedAt: new Date(), referenceCiphertext: null })
        .where(and(eq(checks.id, checkId), eq(checks.status, 'pending')))
        .returning({ id: checks.id })
      if (!row) await wipeReference(checkId)
    },

    /**
     * Erasure (Phase 7 H1): keeps the check's decision and attempt count, removes everything that
     * came from the person: the reference image and its hash, scores, vendor values, the probe hash
     * and vendor session ids. A pending check is cancelled first. Idempotent; unknown ids are a no-op.
     */
    async eraseCheck(checkId: string): Promise<{ erased: boolean }> {
      const [check] = await db.select({ id: checks.id, status: checks.status, erasedAt: checks.erasedAt }).from(checks).where(eq(checks.id, checkId))
      if (!check) return { erased: false }
      if (check.erasedAt) return { erased: true }
      await db.transaction(async (tx) => {
        const now = new Date()
        await tx
          .update(checks)
          .set({ status: sql`case when ${checks.status} = 'pending' then 'cancelled' else ${checks.status} end`, decidedAt: sql`coalesce(${checks.decidedAt}, ${now})`, referenceCiphertext: null, referenceSha256: null, erasedAt: now })
          .where(eq(checks.id, checkId))
        await tx.update(sessions).set({ vendorSessionId: null }).where(eq(sessions.checkId, checkId))
        await tx.update(results).set({ livenessScore: null, matchScore: null, raw: {}, probeSha256: null }).where(eq(results.checkId, checkId))
      })
      logger.info({ checkId }, 'check erased')
      return { erased: true }
    },

    /** Expires overdue pending checks and wipes their images. Returns the expired ids. */
    async expireDue(): Promise<string[]> {
      const rows = await db
        .update(checks)
        .set({ status: 'expired', decidedAt: new Date(), referenceCiphertext: null })
        .where(and(eq(checks.status, 'pending'), lte(checks.expiresAt, new Date())))
        .returning({ id: checks.id })
      if (rows.length) logger.info({ count: rows.length }, 'checks expired')
      return rows.map((r) => r.id)
    },
  }
}

export type BiometricService = ReturnType<typeof createBiometricService>
