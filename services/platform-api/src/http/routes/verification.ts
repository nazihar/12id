/**
 * The console's Verification page (implement/22-console-feedback.md C10): how proof requests ended
 * and how face checks went, over a window, plus the list of face checks behind those numbers.
 *
 *   GET /v1/stats/verification   one tenant's aggregates (console principal only)
 *   GET /v1/biometrics/checks    one tenant's face checks, paged (console principal only)
 *   verificationTotals()         the four headline numbers, for /v1/stats and /admin/stats
 *
 * Everything comes from platform-api's own tables (`proofs`, `exchange_gates`,
 * `exchange_gate_events`), never from agent-service or biometric-service, so the routes exist
 * whether or not biometric-service is configured: without it there are simply no checks.
 *
 * Two clocks, never mixed in one figure: an exchange or a check is counted on the day it *started*,
 * by its outcome today (the rule of the dashboards, C8); an attempt (its rejection reason, its
 * scores) is counted on the day it was made. Scores removed by erasure or retention (Phase 7 H1) are
 * null and drop out of the score distributions; the decisions and reasons stay.
 */
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { biometricView, toBiometricView } from '../../biometric/gate.ts'
import { DEFAULT_POLICY, biometricDefaultPolicy } from '../../biometric/policy.ts'
import type { Database } from '../../db/client.ts'
import { GATE_STATUSES, type GateStatus, biometricSettings, credentials, exchangeGates, proofs } from '../../db/schema.ts'
import { type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { containsI, createdBetween, createdRange, listPage, many, newestFirst, oneOrMany, pageOf, pageQuery, searchQuery } from '../list.ts'
import { daysQuery } from '../stats-window.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

const SCORE_BUCKETS = 10
const TOP_TEMPLATES = 10
const errorBody = z.object({ error: z.string(), reason: z.string() })
const int = z.number().int()

const proofOutcomes = { verified: int, failed: int, abandoned: int, inFlight: int }
const statusCounts = z.object(Object.fromEntries(GATE_STATUSES.map((status) => [status, int])) as Record<GateStatus, z.ZodNumber>)

export const verificationTotalsView = z.object({ proofsRequested: int, proofsVerified: int, proofsFailed: int, faceChecks: int, faceChecksPassed: int, faceChecksFailed: int })
export type VerificationTotals = z.infer<typeof verificationTotalsView>

export const verificationStatsView = z.object({
  days: int,
  proofs: z.object({
    requested: int,
    ...proofOutcomes,
    /** Proof requests started per UTC day, by their outcome today; every day of the window is present. */
    series: z.array(z.object({ day: z.string(), ...proofOutcomes })),
    /** The busiest templates of the window. `templateId` is null for requests made without a template. */
    templates: z.array(z.object({ templateId: z.string().nullable(), name: z.string().nullable(), requested: int, verified: int, failed: int })),
    /** Requests from templates with a conditional face-check rule: how often the rule asked for a check. */
    conditional: z.object({ required: int, notRequired: int }),
  }),
  faceChecks: z.object({
    /** The tenant's biometric switch, and the thresholds of its default policy (templates and credential definitions may override them). */
    enabled: z.boolean(),
    thresholds: z.object({ minLivenessScore: z.number(), minMatchScore: z.number() }),
    total: int,
    byStatus: statusCounts,
    /** The same, split by what the check guarded. */
    issuance: statusCounts,
    proofs: statusCounts,
    /** Checks started per UTC day, by their outcome today; `open` is still pending, `cancelled` had its exchange closed first. */
    series: z.array(z.object({ day: z.string(), passed: int, failed: int, expired: int, open: int, cancelled: int })),
    /** Attempts made in the window, and why the unsuccessful ones were turned down, most frequent first. */
    attempts: z.object({ total: int, passed: int, rejected: int }),
    reasons: z.array(z.object({ reason: z.string(), attempts: int })),
    /** For the checks that passed: how many attempts it took. */
    attemptsToPass: z.array(z.object({ attempts: int, checks: int })),
    /** Attempt scores in ten buckets of ten points (0–9 … 90–100). Erased scores are not counted. */
    scores: z.object({ liveness: z.array(int).length(SCORE_BUCKETS), match: z.array(int).length(SCORE_BUCKETS) }),
  }),
})

const checkView = z.object({
  id: z.string(),
  recordType: z.enum(['credential', 'proof']),
  /** The credential or proof exchange the check guards. */
  recordId: z.string(),
  externalId: z.string().nullable(),
  connectionId: z.string().nullable(),
  providerId: z.string(),
  thresholds: z.object({ minLivenessScore: z.number(), minMatchScore: z.number() }),
  createdAt: z.iso.datetime(),
  biometric: biometricView.unwrap(),
})

const since = (days: number) => sql`(now() at time zone 'utc')::date - ${days - 1}::int`
const zeroStatuses = () => Object.fromEntries(GATE_STATUSES.map((status) => [status, 0])) as Record<GateStatus, number>

/** The headline numbers of a window, for one tenant or the whole platform. A failed check is one that failed or ran out of time. */
export async function verificationTotals(db: Database, days: number, tenantId?: string): Promise<VerificationTotals> {
  const scope = tenantId ? sql`and tenant_id = ${tenantId}` : sql``
  const result = await db.execute<Record<keyof VerificationTotals, number>>(sql`
    select
      (select count(*)::int from proofs where created_at >= ${since(days)} ${scope}) as "proofsRequested",
      (select count(*)::int from proofs where created_at >= ${since(days)} and state = 'done' and verified is true ${scope}) as "proofsVerified",
      (select count(*)::int from proofs where created_at >= ${since(days)} and state = 'done' and verified is false ${scope}) as "proofsFailed",
      (select count(*)::int from exchange_gates where created_at >= ${since(days)} ${scope}) as "faceChecks",
      (select count(*)::int from exchange_gates where created_at >= ${since(days)} and status = 'passed' ${scope}) as "faceChecksPassed",
      (select count(*)::int from exchange_gates where created_at >= ${since(days)} and status in ('failed', 'expired') ${scope}) as "faceChecksFailed"`)
  const row = result.rows[0]
  return {
    proofsRequested: Number(row?.proofsRequested ?? 0),
    proofsVerified: Number(row?.proofsVerified ?? 0),
    proofsFailed: Number(row?.proofsFailed ?? 0),
    faceChecks: Number(row?.faceChecks ?? 0),
    faceChecksPassed: Number(row?.faceChecksPassed ?? 0),
    faceChecksFailed: Number(row?.faceChecksFailed ?? 0),
  }
}

export const verificationRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => requireConsolePrincipal(request.tenant as TenantContext, 'verification statistics are served to the console only')

  app.get(
    '/v1/stats/verification',
    {
      schema: {
        tags: ['stats', CONSOLE_ONLY_TAG],
        summary: 'Proof and face-check outcomes for one tenant',
        description:
          'How proof requests ended and how face checks went over the window: totals, a daily series, the busiest templates, rejection reasons, attempts needed and score distributions. A request or a check counts on the day it started, by its outcome today; an attempt counts on the day it was made. Computed from platform-api tables only.',
        querystring: daysQuery,
        response: { 200: verificationStatsView, 403: errorBody },
      },
    },
    async (request) => {
      const t = tenant(request)
      const { days } = request.query
      const from = since(days)
      const attempt = sql`tenant_id = ${t.id} and type = 'attempt_completed' and at >= ${from}`
      const [proofDays, templates, conditional, gates, attempts, reasons, attemptsToPass, scores, settings] = await Promise.all([
        deps.db.execute<{ day: string; requested: number; verified: number; failed: number; abandoned: number }>(sql`
          with days as (select generate_series(${from}, (now() at time zone 'utc')::date, interval '1 day')::date as day),
               p as (
                 select (created_at at time zone 'utc')::date as day, count(*)::int as requested,
                        (count(*) filter (where state = 'done' and verified is true))::int as verified,
                        (count(*) filter (where state = 'done' and verified is false))::int as failed,
                        (count(*) filter (where state in ('abandoned', 'declined')))::int as abandoned
                 from proofs where tenant_id = ${t.id} and created_at >= ${from} group by 1)
          select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(p.requested, 0)::int as requested, coalesce(p.verified, 0)::int as verified,
                 coalesce(p.failed, 0)::int as failed, coalesce(p.abandoned, 0)::int as abandoned
          from days d left join p on p.day = d.day order by d.day`),
        deps.db.execute<{ template_id: string | null; name: string | null; requested: number; verified: number; failed: number }>(sql`
          select p.template_id, t.name, count(*)::int as requested,
                 (count(*) filter (where p.state = 'done' and p.verified is true))::int as verified,
                 (count(*) filter (where p.state = 'done' and p.verified is false))::int as failed
          from proofs p left join proof_templates t on t.id = p.template_id
          where p.tenant_id = ${t.id} and p.created_at >= ${from}
          group by p.template_id, t.name order by requested desc, t.name nulls last limit ${TOP_TEMPLATES}`),
        deps.db.execute<{ required: number; not_required: number }>(sql`
          select (count(*) filter (where biometric_condition->>'required' = 'true'))::int as required,
                 (count(*) filter (where biometric_condition->>'required' = 'false'))::int as not_required
          from proofs where tenant_id = ${t.id} and created_at >= ${from} and biometric_condition is not null`),
        deps.db.execute<{ day: string; record_type: 'credential' | 'proof'; status: GateStatus; n: number }>(sql`
          select to_char((created_at at time zone 'utc')::date, 'YYYY-MM-DD') as day, record_type, status, count(*)::int as n
          from exchange_gates where tenant_id = ${t.id} and created_at >= ${from} group by 1, 2, 3`),
        deps.db.execute<{ total: number; passed: number }>(sql`select count(*)::int as total, (count(*) filter (where decision = 'passed'))::int as passed from exchange_gate_events where ${attempt}`),
        deps.db.execute<{ reason: string; n: number }>(sql`
          select coalesce(reason, 'unknown') as reason, count(*)::int as n from exchange_gate_events
          where ${attempt} and decision is distinct from 'passed' group by 1 order by n desc, reason`),
        deps.db.execute<{ attempts: number; n: number }>(sql`
          select attempts, count(*)::int as n from exchange_gates
          where tenant_id = ${t.id} and created_at >= ${from} and status = 'passed' and attempts > 0 group by attempts order by attempts`),
        deps.db.execute<{ kind: 'liveness' | 'match'; bucket: number; n: number }>(sql`
          select 'liveness' as kind, greatest(0, least(${SCORE_BUCKETS - 1}, floor(liveness_score / 10)))::int as bucket, count(*)::int as n
          from exchange_gate_events where ${attempt} and liveness_score is not null group by 2
          union all
          select 'match', greatest(0, least(${SCORE_BUCKETS - 1}, floor(match_score / 10)))::int, count(*)::int
          from exchange_gate_events where ${attempt} and match_score is not null group by 2`),
        deps.db.select().from(biometricSettings).where(eq(biometricSettings.tenantId, t.id)).then((rows) => rows[0]),
      ])

      const proofSeries = proofDays.rows.map((row) => {
        const requested = Number(row.requested)
        const verified = Number(row.verified)
        const failed = Number(row.failed)
        const abandoned = Number(row.abandoned)
        return { day: String(row.day), requested, verified, failed, abandoned, inFlight: requested - verified - failed - abandoned }
      })
      const sum = (key: 'requested' | 'verified' | 'failed' | 'abandoned' | 'inFlight') => proofSeries.reduce((total, point) => total + point[key], 0)

      const byStatus = zeroStatuses()
      const issuance = zeroStatuses()
      const gatedProofs = zeroStatuses()
      const perDay = new Map<string, Record<GateStatus, number>>()
      for (const row of gates.rows) {
        const n = Number(row.n)
        byStatus[row.status] += n
        ;(row.record_type === 'credential' ? issuance : gatedProofs)[row.status] += n
        const day = perDay.get(String(row.day)) ?? zeroStatuses()
        day[row.status] += n
        perDay.set(String(row.day), day)
      }
      const histogram = (kind: 'liveness' | 'match') => {
        const buckets = Array.from({ length: SCORE_BUCKETS }, () => 0)
        for (const row of scores.rows) if (row.kind === kind) buckets[Number(row.bucket)] = Number(row.n)
        return buckets
      }
      const policy = biometricDefaultPolicy.catch(DEFAULT_POLICY).parse(settings?.defaultPolicy ?? DEFAULT_POLICY)
      const attemptTotal = Number(attempts.rows[0]?.total ?? 0)
      const attemptPassed = Number(attempts.rows[0]?.passed ?? 0)

      return {
        days,
        proofs: {
          requested: sum('requested'),
          verified: sum('verified'),
          failed: sum('failed'),
          abandoned: sum('abandoned'),
          inFlight: sum('inFlight'),
          series: proofSeries.map(({ requested: _requested, ...point }) => point),
          templates: templates.rows.map((row) => ({ templateId: row.template_id, name: row.name, requested: Number(row.requested), verified: Number(row.verified), failed: Number(row.failed) })),
          conditional: { required: Number(conditional.rows[0]?.required ?? 0), notRequired: Number(conditional.rows[0]?.not_required ?? 0) },
        },
        faceChecks: {
          enabled: settings?.enabled ?? false,
          thresholds: { minLivenessScore: policy.minLivenessScore, minMatchScore: policy.minMatchScore },
          total: GATE_STATUSES.reduce((total, status) => total + byStatus[status], 0),
          byStatus,
          issuance,
          proofs: gatedProofs,
          // The proof series already holds every day of the window; the checks follow the same spine.
          series: proofSeries.map(({ day }) => {
            const counts = perDay.get(day) ?? zeroStatuses()
            return { day, passed: counts.passed, failed: counts.failed, expired: counts.expired, open: counts.pending, cancelled: counts.cancelled }
          }),
          attempts: { total: attemptTotal, passed: attemptPassed, rejected: attemptTotal - attemptPassed },
          reasons: reasons.rows.map((row) => ({ reason: row.reason, attempts: Number(row.n) })),
          attemptsToPass: attemptsToPass.rows.map((row) => ({ attempts: Number(row.attempts), checks: Number(row.n) })),
          scores: { liveness: histogram('liveness'), match: histogram('match') },
        },
      }
    }
  )

  const checkListQuery = pageQuery.extend(createdRange.shape).extend(searchQuery.shape).extend({
    status: oneOrMany(z.string().min(1).max(20)).describe(`One or more of ${GATE_STATUSES.join(', ')}; repeat the parameter for several.`),
    recordType: z.enum(['credential', 'proof']).optional(),
    reason: z.string().min(1).max(100).optional().describe('Checks with at least one unsuccessful attempt turned down for this reason, e.g. `match_below_threshold`.'),
    connectionId: z.string().min(1).max(100).optional().describe('Checks on the exchanges of one connection.'),
  })

  /** A condition on the exchange a check guards, whichever of the two tables holds it. */
  const onExchange = (condition: (table: typeof credentials | typeof proofs) => SQL) => sql`(
    (${exchangeGates.recordType} = 'credential' and exists (select 1 from ${credentials} where ${credentials.tenantId} = ${exchangeGates.tenantId} and ${credentials.recordId} = ${exchangeGates.recordId} and ${condition(credentials)}))
    or (${exchangeGates.recordType} = 'proof' and exists (select 1 from ${proofs} where ${proofs.tenantId} = ${exchangeGates.tenantId} and ${proofs.recordId} = ${exchangeGates.recordId} and ${condition(proofs)})))`

  app.get(
    '/v1/biometrics/checks',
    {
      schema: {
        tags: ['stats', CONSOLE_ONLY_TAG],
        summary: 'List face checks',
        description: 'One row per gated exchange, newest first, paged. `q` is a case-insensitive contains match on the external id of the exchange. No images, as everywhere; the full log of one check is on its exchange.',
        querystring: checkListQuery,
        response: { 200: pageOf(checkView), 403: errorBody },
      },
    },
    async (request) => {
      const t = tenant(request)
      const { q, recordType, reason, connectionId } = request.query
      const filters: SQL[] = [eq(exchangeGates.tenantId, t.id), ...createdBetween(exchangeGates.createdAt, request.query)]
      const statuses = many(request.query.status)
      if (statuses.length) filters.push(inArray(exchangeGates.status, statuses as GateStatus[]))
      if (recordType) filters.push(eq(exchangeGates.recordType, recordType))
      if (reason) {
        filters.push(sql`exists (select 1 from exchange_gate_events e where e.gate_id = ${exchangeGates.id} and e.type = 'attempt_completed' and e.decision is distinct from 'passed' and e.reason = ${reason})`)
      }
      if (connectionId) filters.push(onExchange((table) => sql`${table.connectionId} = ${connectionId}`))
      if (q) filters.push(onExchange((table) => containsI(table.externalId, q)))

      const page = await listPage(deps.db, { table: exchangeGates, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db
          .select({
            gate: exchangeGates,
            externalId: sql<string | null>`coalesce(${credentials.externalId}, ${proofs.externalId})`,
            connectionId: sql<string | null>`coalesce(${credentials.connectionId}, ${proofs.connectionId})`,
          })
          .from(exchangeGates)
          .leftJoin(credentials, and(eq(exchangeGates.recordType, 'credential'), eq(credentials.tenantId, exchangeGates.tenantId), eq(credentials.recordId, exchangeGates.recordId)))
          .leftJoin(proofs, and(eq(exchangeGates.recordType, 'proof'), eq(proofs.tenantId, exchangeGates.tenantId), eq(proofs.recordId, exchangeGates.recordId)))
          .where(where)
          .orderBy(...newestFirst(exchangeGates.createdAt, exchangeGates.id))
          .limit(limit)
          .offset(offset)
      )
      return {
        ...page,
        items: page.items.map(({ gate, externalId, connectionId: connection }) => ({
          id: gate.id,
          recordType: gate.recordType,
          recordId: gate.recordId,
          externalId,
          connectionId: connection,
          providerId: gate.providerId,
          thresholds: gate.thresholds,
          createdAt: gate.createdAt.toISOString(),
          biometric: toBiometricView(gate)!,
        })),
      }
    }
  )
}
