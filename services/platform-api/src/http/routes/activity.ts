/**
 * One customer's activity for the console (implement/22-console-feedback.md C11). A "customer" here
 * is one connection: credential and proof exchanges carry its id, and a face check belongs to one of
 * those exchanges. The page lists them with the existing list routes (`connectionId` filter); this
 * route gives the numbers above those lists.
 *
 * Wallets have no link to a connection (the mediator keeps them apart by design), so the wallets
 * returned are the ones registered with the same external id: the tenant's own reference, not a
 * fact the platform established.
 *
 * Console principal only, and from platform-api's tables only.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { connections, wallets } from '../../db/schema.ts'
import { connectionView, toConnectionView, toWalletView, walletView } from '../../views.ts'
import { type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { notFound } from '../errors.ts'
import { newestFirst } from '../list.ts'
import { maskConnection, masked } from '../personal-data.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

const WALLET_LIMIT = 20
const int = z.number().int()
const counts = z.record(z.string(), int)
const errorBody = z.object({ error: z.string(), reason: z.string() })

export const connectionActivityView = z.object({
  connection: connectionView,
  credentials: z.object({ total: int, byState: counts }),
  proofs: z.object({ total: int, byState: counts, verified: int, failed: int }),
  faceChecks: z.object({ total: int, byStatus: counts }),
  /** The latest update of the connection or of any exchange on it. */
  lastActivityAt: z.iso.datetime(),
  /** Wallets registered with the connection's external id, newest first, at most 20. Empty when the connection has none. */
  wallets: z.array(walletView),
})

const total = (byKey: Record<string, number>) => Object.values(byKey).reduce((sum, n) => sum + n, 0)

export const activityRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  app.get(
    '/v1/connections/:id/activity',
    {
      schema: {
        tags: ['connections', CONSOLE_ONLY_TAG],
        summary: 'Activity of one connection',
        description: 'Counts of the credential exchanges, proof exchanges and face checks of one connection, its latest activity, and the wallets registered with the same external id. The exchanges themselves are listed with `connectionId` on the list routes.',
        params: z.object({ id: z.string().min(1).max(100) }),
        response: { 200: connectionActivityView, 403: errorBody, 404: errorBody },
      },
    },
    async (request) => {
      const t = requireConsolePrincipal(request.tenant as TenantContext, 'customer activity is served to the console only')
      const id = request.params.id
      const [connection] = await deps.db.select().from(connections).where(and(eq(connections.tenantId, t.id), eq(connections.recordId, id)))
      if (!connection) throw notFound('connection')

      const onConnection = sql`tenant_id = ${t.id} and connection_id = ${id}`
      const [credentialRows, proofRows, gateRows, sameReference] = await Promise.all([
        deps.db.execute<{ state: string; n: number; last: Date | string | null }>(sql`select state, count(*)::int as n, max(updated_at) as last from credentials where ${onConnection} group by state`),
        deps.db.execute<{ state: string; n: number; verified: number; failed: number; last: Date | string | null }>(sql`
          select state, count(*)::int as n, (count(*) filter (where state = 'done' and verified is true))::int as verified,
                 (count(*) filter (where state = 'done' and verified is false))::int as failed, max(updated_at) as last
          from proofs where ${onConnection} group by state`),
        deps.db.execute<{ status: string; n: number }>(sql`
          select g.status, count(*)::int as n from exchange_gates g
          where g.tenant_id = ${t.id} and (
            (g.record_type = 'credential' and exists (select 1 from credentials c where c.tenant_id = g.tenant_id and c.record_id = g.record_id and c.connection_id = ${id}))
            or (g.record_type = 'proof' and exists (select 1 from proofs p where p.tenant_id = g.tenant_id and p.record_id = g.record_id and p.connection_id = ${id})))
          group by g.status`),
        connection.externalId
          ? deps.db.select().from(wallets).where(and(eq(wallets.tenantId, t.id), isNotNull(wallets.externalId), eq(wallets.externalId, connection.externalId))).orderBy(...newestFirst(wallets.createdAt, wallets.id)).limit(WALLET_LIMIT)
          : Promise.resolve([]),
      ])

      let last = connection.updatedAt
      const later = (value: Date | string | null) => {
        if (value && new Date(value) > last) last = new Date(value)
      }
      const credentialStates: Record<string, number> = {}
      for (const row of credentialRows.rows) {
        credentialStates[row.state] = Number(row.n)
        later(row.last)
      }
      const proofStates: Record<string, number> = {}
      let verified = 0
      let failed = 0
      for (const row of proofRows.rows) {
        proofStates[row.state] = Number(row.n)
        verified += Number(row.verified)
        failed += Number(row.failed)
        later(row.last)
      }
      const checkStatuses = Object.fromEntries(gateRows.rows.map((row) => [row.status, Number(row.n)]))

      const view = toConnectionView(connection)
      return {
        connection: masked(request) ? maskConnection(view) : view,
        credentials: { total: total(credentialStates), byState: credentialStates },
        proofs: { total: total(proofStates), byState: proofStates, verified, failed },
        faceChecks: { total: total(checkStatuses), byStatus: checkStatuses },
        lastActivityAt: last.toISOString(),
        wallets: sameReference.map(toWalletView),
      }
    }
  )
}
