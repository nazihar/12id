/** Cross-tenant operator views (Phase 4 stage 4a): webhook deliveries and the console audit log. */
import { createServerFn } from '@tanstack/react-start'
import { ilike, inArray, or } from 'drizzle-orm'

import { deliveryQueryParams } from '@/features/tenant-data/list.params'
import { createdParams, likeContains, pageParams } from '@/lib/list-search'
import { consoleDb } from '@/server/db.server'
import { user } from '@/server/db/auth-schema'
import { operatorMiddleware } from '@/server/middleware'
import { platformFor, unwrap } from '@/server/platform.server'

import { auditSearch, opsDeliverySearch } from './ops.schemas'

export const listDeliveriesAcrossTenants = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(opsDeliverySearch)
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal).GET('/admin/webhook-deliveries', { params: { query: { ...deliveryQueryParams({ ...data, status: data.status ?? 'dead' }), tenantId: data.tenantId } } }))
  )

/**
 * platform-api records the Better Auth user id as actor; the console resolves it to the account for
 * display. The one search box also covers names and emails: the console looks up the matching
 * accounts and passes their ids as `qActor`, which platform-api ORs with its route and actor-id match
 * (so the break-glass actor `admin-token` is found by its id).
 */
export const listAuditLog = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(auditSearch)
  .handler(async ({ context, data }) => {
    const { db } = consoleDb()
    const pattern = data.q ? likeContains(data.q) : undefined
    const qActor = pattern ? (await db.select({ id: user.id }).from(user).where(or(ilike(user.email, pattern), ilike(user.name, pattern))).limit(50)).map((m) => m.id) : []
    const entries = unwrap(
      await platformFor(context.principal).GET('/admin/audit', { params: { query: { ...pageParams(data), ...createdParams(data), tenantId: data.tenantId, qActor: qActor.length ? qActor : undefined } } })
    )
    const actorIds = [...new Set(entries.items.map((entry) => entry.actor))]
    const accounts = actorIds.length === 0 ? [] : await db.select({ id: user.id, email: user.email, name: user.name }).from(user).where(inArray(user.id, actorIds))
    const byId = new Map(accounts.map((account) => [account.id, account]))
    return { ...entries, items: entries.items.map((entry) => ({ ...entry, actorEmail: byId.get(entry.actor)?.email ?? null, actorName: byId.get(entry.actor)?.name ?? null })) }
  })
