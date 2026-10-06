/**
 * Aggregates for the console's dashboards (Phase 4 C8): `GET /v1/stats` for one tenant (console
 * principal only) and `GET /admin/stats` across tenants (operators). Everything is computed from
 * platform-api's own tables — the mirror tables, wallets, API keys and deliveries — and never
 * through agent-service (a catalogue call can exceed the client timeout, trap 44).
 *
 * The daily series counts exchanges *started* on a day (`created_at`); start and outcome dates are
 * never mixed. Days with nothing are present with zeros: the spine is the calendar, not the data.
 */
import { count, desc, eq, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { DELIVERY_STATUSES, tenants, webhookEndpoints } from '../../db/schema.ts'
import type { ReadinessReport } from '../app.ts'
import { type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { notFound } from '../errors.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

export type ExchangeKind = 'connections' | 'credentials' | 'proofs'
const KINDS: ExchangeKind[] = ['connections', 'credentials', 'proofs']

/** Once here an exchange never moves again; anything else older than the cutoff is "stuck" (trap 25). */
const TERMINAL_EXCHANGE_STATES = ['done', 'abandoned', 'declined']
const STUCK_AFTER = sql`interval '24 hours'`
const EXPIRING_WITHIN = sql`interval '30 days'`

export const DAYS_MIN = 7
export const DAYS_MAX = 90
const daysQuery = z.object({ days: z.coerce.number().int().min(DAYS_MIN).max(DAYS_MAX).default(30) })

const stateCounts = z.record(z.string(), z.number().int())
const activeRevoked = z.object({ active: z.number().int(), revoked: z.number().int() })
const kindTotals = z.object({ byState: stateCounts, total: z.number().int() })
const seriesPoint = z.object({ day: z.string(), connections: z.number().int(), credentials: z.number().int(), proofs: z.number().int() })
const errorBody = z.object({ error: z.string(), reason: z.string() })

export const tenantStatsView = z.object({
  tenant: z.object({ id: z.string(), name: z.string(), status: z.string(), did: z.string().nullable(), lastError: z.string().nullable() }),
  days: z.number().int(),
  totals: z.object({
    connections: kindTotals,
    credentials: kindTotals,
    proofs: kindTotals.extend({ verified: z.number().int(), failed: z.number().int() }),
    wallets: activeRevoked,
    apiKeys: activeRevoked,
  }),
  webhook: z.object({
    configured: z.boolean(),
    url: z.string().nullable(),
    deliveries: z.object(Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, z.number().int()])) as Record<(typeof DELIVERY_STATUSES)[number], z.ZodNumber>),
    lastDeliveredAt: z.iso.datetime().nullable(),
    lastFailureAt: z.iso.datetime().nullable(),
  }),
  attention: z.object({
    stuckCredentials: z.number().int(),
    stuckProofs: z.number().int(),
    deadDeliveries: z.number().int(),
    /** Issued credentials whose `expiresOn` date falls within the next 30 days. */
    expiringCredentials: z.number().int(),
    expiredCredentials: z.number().int(),
    walletsNeverConnected: z.number().int(),
  }),
  series: z.array(seriesPoint),
})

export const platformStatsView = z.object({
  days: z.number().int(),
  platform: z.object({
    tenants: z.object({ total: z.number().int(), ready: z.number().int(), provisioning: z.number().int(), failed: z.number().int() }),
    connections: z.number().int(),
    credentials: z.number().int(),
    proofs: z.number().int(),
    wallets: activeRevoked,
    apiKeys: activeRevoked,
  }),
  outcomes: z.object({ connections: stateCounts, credentials: stateCounts, proofs: stateCounts }),
  attention: z.object({
    failedTenants: z.array(z.object({ id: z.string(), name: z.string(), lastError: z.string().nullable() })),
    deadDeliveries: z.number().int(),
    stuckCredentials: z.number().int(),
    stuckProofs: z.number().int(),
    walletsNeverConnected: z.number().int(),
    tenantsWithoutWebhook: z.number().int(),
  }),
  series: z.array(seriesPoint),
  topTenants: z.array(z.object({ tenantId: z.string(), name: z.string(), exchanges: z.number().int() })),
  health: z.object({ ready: z.boolean(), draining: z.boolean(), checks: z.record(z.string(), z.boolean()) }),
})

// --- shared aggregates (also used by /admin/overview) -------------------------------------------

export interface ExchangeActivity {
  connections: Record<string, number>
  credentials: Record<string, number>
  proofs: Record<string, number>
  last: Date | null
}

const emptyActivity = (): ExchangeActivity => ({ connections: {}, credentials: {}, proofs: {}, last: null })

/** One tenant, or the tenants of one page of `/admin/overview` (Phase 4 C9). */
type TenantScope = string | string[]
const tenantIn = (scope: TenantScope) =>
  typeof scope === 'string' ? sql`tenant_id = ${scope}` : sql`tenant_id in (${sql.join(scope.map((id) => sql`${id}::uuid`), sql`, `)})`

/** Exchange counts by kind and state per tenant, with the latest `updated_at` of any exchange. */
export async function exchangeActivityByTenant(db: Database, tenantId?: TenantScope): Promise<Map<string, ExchangeActivity>> {
  const scope = tenantId ? sql`where ${tenantIn(tenantId)}` : sql``
  const result = await db.execute<{ tenant_id: string; kind: ExchangeKind; state: string; n: number; last: Date | string | null }>(sql`
    select tenant_id, 'connections' as kind, state, count(*)::int as n, max(updated_at) as last from connections ${scope} group by tenant_id, state
    union all select tenant_id, 'credentials', state, count(*)::int, max(updated_at) from credentials ${scope} group by tenant_id, state
    union all select tenant_id, 'proofs', state, count(*)::int, max(updated_at) from proofs ${scope} group by tenant_id, state`)
  const activity = new Map<string, ExchangeActivity>()
  for (const row of result.rows) {
    const entry = activity.get(row.tenant_id) ?? emptyActivity()
    entry[row.kind][row.state] = Number(row.n)
    const last = row.last ? new Date(row.last) : null
    if (last && (!entry.last || last > entry.last)) entry.last = last
    activity.set(row.tenant_id, entry)
  }
  return activity
}

/** `active` / `revoked` per tenant for a table with `revoked_at` (wallets, api_keys). */
export async function activeRevokedByTenant(db: Database, table: 'wallets' | 'api_keys', tenantId?: TenantScope): Promise<Map<string, { active: number; revoked: number }>> {
  const scope = tenantId ? sql`where ${tenantIn(tenantId)}` : sql``
  const result = await db.execute<{ tenant_id: string; active: number; revoked: number }>(
    sql`select tenant_id, (count(*) filter (where revoked_at is null))::int as active, (count(*) filter (where revoked_at is not null))::int as revoked from ${sql.raw(table)} ${scope} group by tenant_id`
  )
  return new Map(result.rows.map((row) => [row.tenant_id, { active: Number(row.active), revoked: Number(row.revoked) }]))
}

export async function deadDeliveriesByTenant(db: Database, tenantId?: TenantScope): Promise<Map<string, number>> {
  const scope = tenantId ? sql`and ${tenantIn(tenantId)}` : sql``
  const result = await db.execute<{ tenant_id: string; n: number }>(sql`select tenant_id, count(*)::int as n from webhook_deliveries where status = 'dead' ${scope} group by tenant_id`)
  return new Map(result.rows.map((row) => [row.tenant_id, Number(row.n)]))
}

/** Exchanges started per UTC day over the last `days` days, oldest first, zeros included. */
export async function activitySeries(db: Database, days: number, tenantId?: string): Promise<z.infer<typeof seriesPoint>[]> {
  const scope = tenantId ? sql`and tenant_id = ${tenantId}` : sql``
  const since = sql`(now() at time zone 'utc')::date - ${days - 1}::int`
  const perDay = (table: ExchangeKind) => sql`select (created_at at time zone 'utc')::date as day, count(*)::int as n from ${sql.raw(table)} where created_at >= ${since} ${scope} group by 1`
  const result = await db.execute<{ day: string | Date; connections: number; credentials: number; proofs: number }>(sql`
    with days as (select generate_series(${since}, (now() at time zone 'utc')::date, interval '1 day')::date as day),
         c as (${perDay('connections')}), r as (${perDay('credentials')}), p as (${perDay('proofs')})
    select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(c.n, 0)::int as connections, coalesce(r.n, 0)::int as credentials, coalesce(p.n, 0)::int as proofs
    from days d left join c on c.day = d.day left join r on r.day = d.day left join p on p.day = d.day
    order by d.day`)
  return result.rows.map((row) => ({ day: String(row.day), connections: Number(row.connections), credentials: Number(row.credentials), proofs: Number(row.proofs) }))
}

async function scalar(db: Database, query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute<{ n: number }>(query)
  return Number(result.rows[0]?.n ?? 0)
}

const terminal = sql.join(TERMINAL_EXCHANGE_STATES.map((s) => sql`${s}`), sql`, `)

/** Non-terminal exchanges untouched for longer than the cutoff. */
const stuckCount = (db: Database, table: 'credentials' | 'proofs', tenantId?: string) =>
  scalar(db, sql`select count(*)::int as n from ${sql.raw(table)} where state not in (${terminal}) and updated_at < now() - ${STUCK_AFTER} ${tenantId ? sql`and tenant_id = ${tenantId}` : sql``}`)

/**
 * Wallets with no mediator connection a day after creation. `connected_at` is set by the wake path and
 * by the sweep's check of the mediator's connections (review M10); `mediator_connection_id` alone was
 * only a cache of the first webhook, reset on every new invitation.
 */
const walletsNeverConnectedCount = (db: Database, tenantId?: string) =>
  scalar(db, sql`select count(*)::int as n from wallets where connected_at is null and revoked_at is null and created_at < now() - ${STUCK_AFTER} ${tenantId ? sql`and tenant_id = ${tenantId}` : sql``}`)

/**
 * Issued credentials by their `expiresOn` attribute, read from `expires_at` (the end of that day, set when
 * it is a valid date, §5.2), which survives the erasure of the attributes (Phase 7 H1).
 */
const expiryCounts = async (db: Database, tenantId: string) => {
  const result = await db.execute<{ expiring: number; expired: number }>(sql`
    with issued as (
      select expires_at from credentials
      where tenant_id = ${tenantId} and state = 'done' and expires_at is not null)
    select (count(*) filter (where expires_at >= now() and expires_at < now() + ${EXPIRING_WITHIN}))::int as expiring,
           (count(*) filter (where expires_at < now()))::int as expired
    from issued`)
  return { expiring: Number(result.rows[0]?.expiring ?? 0), expired: Number(result.rows[0]?.expired ?? 0) }
}

const sumCounts = (counts: Record<string, number>) => Object.values(counts).reduce((total, n) => total + n, 0)
const totals = (counts: Record<string, number>) => ({ byState: counts, total: sumCounts(counts) })

// --- routes -------------------------------------------------------------------------------------

export const tenantStatsRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => requireConsolePrincipal(request.tenant as TenantContext, 'stats are served to the console only')

  app.get(
    '/v1/stats',
    {
      schema: {
        tags: ['stats', CONSOLE_ONLY_TAG],
        summary: 'Dashboard aggregates for one tenant',
        description: 'Counters by state, webhook health, what needs attention, and exchanges started per day over the window. Computed from platform-api tables only.',
        querystring: daysQuery,
        response: { 200: tenantStatsView, 403: errorBody },
      },
    },
    async (request) => {
      const t = tenant(request)
      const { days } = request.query
      const [tenantRow, activity, wallets, keys, dead, endpoint, deliveries, stuckCredentials, stuckProofs, walletsNeverConnected, expiry, series] = await Promise.all([
        deps.db.select().from(tenants).where(eq(tenants.id, t.id)).then((rows) => rows[0]),
        exchangeActivityByTenant(deps.db, t.id),
        activeRevokedByTenant(deps.db, 'wallets', t.id),
        activeRevokedByTenant(deps.db, 'api_keys', t.id),
        deadDeliveriesByTenant(deps.db, t.id),
        deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, t.id)).then((rows) => rows[0] ?? null),
        deps.db.execute<{ status: string; n: number; delivered: Date | string | null; failed: Date | string | null }>(sql`
          select status, count(*)::int as n, max(delivered_at) as delivered, max(created_at) filter (where status = 'dead') as failed
          from webhook_deliveries where tenant_id = ${t.id} group by status`),
        stuckCount(deps.db, 'credentials', t.id),
        stuckCount(deps.db, 'proofs', t.id),
        walletsNeverConnectedCount(deps.db, t.id),
        expiryCounts(deps.db, t.id),
        activitySeries(deps.db, days, t.id),
      ])
      if (!tenantRow) throw notFound('tenant')
      const exchanges = activity.get(t.id) ?? emptyActivity()
      const proofOutcome = await deps.db.execute<{ verified: number; failed: number }>(
        sql`select (count(*) filter (where verified = true))::int as verified, (count(*) filter (where verified = false))::int as failed from proofs where tenant_id = ${t.id}`
      )
      const byStatus = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0])) as Record<(typeof DELIVERY_STATUSES)[number], number>
      let lastDeliveredAt: Date | null = null
      let lastFailureAt: Date | null = null
      for (const row of deliveries.rows) {
        if (row.status in byStatus) byStatus[row.status as (typeof DELIVERY_STATUSES)[number]] = Number(row.n)
        if (row.delivered && (!lastDeliveredAt || new Date(row.delivered) > lastDeliveredAt)) lastDeliveredAt = new Date(row.delivered)
        if (row.failed && (!lastFailureAt || new Date(row.failed) > lastFailureAt)) lastFailureAt = new Date(row.failed)
      }
      return {
        tenant: { id: tenantRow.id, name: tenantRow.name, status: tenantRow.status, did: tenantRow.did, lastError: tenantRow.lastError },
        days,
        totals: {
          connections: totals(exchanges.connections),
          credentials: totals(exchanges.credentials),
          proofs: { ...totals(exchanges.proofs), verified: Number(proofOutcome.rows[0]?.verified ?? 0), failed: Number(proofOutcome.rows[0]?.failed ?? 0) },
          wallets: wallets.get(t.id) ?? { active: 0, revoked: 0 },
          apiKeys: keys.get(t.id) ?? { active: 0, revoked: 0 },
        },
        webhook: { configured: endpoint !== null, url: endpoint?.url ?? null, deliveries: byStatus, lastDeliveredAt: lastDeliveredAt?.toISOString() ?? null, lastFailureAt: lastFailureAt?.toISOString() ?? null },
        attention: { stuckCredentials, stuckProofs, deadDeliveries: dead.get(t.id) ?? 0, expiringCredentials: expiry.expiring, expiredCredentials: expiry.expired, walletsNeverConnected },
        series,
      }
    }
  )
}

export const platformStatsRoutes = (deps: { db: Database; readiness: () => Promise<ReadinessReport> }): FastifyPluginAsyncZod => async (app) => {
  app.get(
    '/admin/stats',
    {
      schema: {
        tags: ['admin', CONSOLE_ONLY_TAG],
        summary: 'Dashboard aggregates across tenants',
        description: 'Platform totals, outcomes by state, what needs attention, exchanges started per day, the busiest tenants over the window, and the readiness checks.',
        querystring: daysQuery,
        response: { 200: platformStatsView },
      },
    },
    async (request) => {
      const { days } = request.query
      const [tenantRows, activity, wallets, keys, dead, stuckCredentials, stuckProofs, walletsNeverConnected, withWebhook, series, health] = await Promise.all([
        deps.db.select().from(tenants).orderBy(desc(tenants.createdAt)),
        exchangeActivityByTenant(deps.db),
        activeRevokedByTenant(deps.db, 'wallets'),
        activeRevokedByTenant(deps.db, 'api_keys'),
        deadDeliveriesByTenant(deps.db),
        stuckCount(deps.db, 'credentials'),
        stuckCount(deps.db, 'proofs'),
        walletsNeverConnectedCount(deps.db),
        deps.db.select({ n: count() }).from(webhookEndpoints).then((rows) => Number(rows[0]?.n ?? 0)),
        activitySeries(deps.db, days),
        deps.readiness().catch(() => ({ ready: false, draining: false, checks: {} })),
      ])
      const windowCounts = await deps.db.execute<{ tenant_id: string; n: number }>(sql`
        select tenant_id, count(*)::int as n from (
          select tenant_id, created_at from connections union all select tenant_id, created_at from credentials union all select tenant_id, created_at from proofs) x
        where created_at >= (now() at time zone 'utc')::date - ${days - 1}::int group by tenant_id order by n desc limit 5`)
      const names = new Map(tenantRows.map((row) => [row.id, row.name]))

      const outcomes = { connections: {} as Record<string, number>, credentials: {} as Record<string, number>, proofs: {} as Record<string, number> }
      for (const entry of activity.values()) {
        for (const kind of KINDS) for (const [state, n] of Object.entries(entry[kind])) outcomes[kind][state] = (outcomes[kind][state] ?? 0) + n
      }
      const sumMap = (map: Map<string, { active: number; revoked: number }>) => {
        const out = { active: 0, revoked: 0 }
        for (const value of map.values()) {
          out.active += value.active
          out.revoked += value.revoked
        }
        return out
      }
      const byStatus = (status: string) => tenantRows.filter((row) => row.status === status).length
      return {
        days,
        platform: {
          tenants: { total: tenantRows.length, ready: byStatus('ready'), provisioning: byStatus('provisioning'), failed: byStatus('failed') },
          connections: sumCounts(outcomes.connections),
          credentials: sumCounts(outcomes.credentials),
          proofs: sumCounts(outcomes.proofs),
          wallets: sumMap(wallets),
          apiKeys: sumMap(keys),
        },
        outcomes,
        attention: {
          failedTenants: tenantRows.filter((row) => row.status === 'failed').map((row) => ({ id: row.id, name: row.name, lastError: row.lastError })),
          deadDeliveries: [...dead.values()].reduce((total, n) => total + n, 0),
          stuckCredentials,
          stuckProofs,
          walletsNeverConnected,
          tenantsWithoutWebhook: Math.max(0, tenantRows.length - withWebhook),
        },
        series,
        topTenants: windowCounts.rows.map((row) => ({ tenantId: row.tenant_id, name: names.get(row.tenant_id) ?? row.tenant_id, exchanges: Number(row.n) })),
        health,
      }
    }
  )
}
