/** Cross-tenant operator views (Phase 4 stage 4a): webhook deliveries and the console audit log. */
import { createServerFn } from '@tanstack/react-start'
import { inArray } from 'drizzle-orm'
import { z } from 'zod'

import { DELIVERY_STATUSES } from '@/features/tenant-data/types'
import { consoleDb } from '@/server/db.server'
import { user } from '@/server/db/auth-schema'
import { operatorMiddleware } from '@/server/middleware'
import { platformFor, unwrap } from '@/server/platform.server'

export const listDeliveriesAcrossTenants = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(z.object({ status: z.enum(DELIVERY_STATUSES).default('dead'), tenantId: z.uuid().optional() }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal).GET('/admin/webhook-deliveries', { params: { query: { status: data.status, tenantId: data.tenantId, limit: 200 } } }))
  )

/** platform-api records the Better Auth user id as actor; the console resolves it to the account for display. */
export const listAuditLog = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(z.object({ tenantId: z.uuid().optional(), actor: z.string().min(1).max(200).optional() }))
  .handler(async ({ context, data }) => {
    const entries = unwrap(await platformFor(context.principal).GET('/admin/audit', { params: { query: { tenantId: data.tenantId, actor: data.actor, limit: 200 } } }))
    const actorIds = [...new Set(entries.map((entry) => entry.actor))]
    const accounts = actorIds.length === 0 ? [] : await consoleDb().db.select({ id: user.id, email: user.email, name: user.name }).from(user).where(inArray(user.id, actorIds))
    const byId = new Map(accounts.map((account) => [account.id, account]))
    return entries.map((entry) => ({ ...entry, actorEmail: byId.get(entry.actor)?.email ?? null, actorName: byId.get(entry.actor)?.name ?? null }))
  })
