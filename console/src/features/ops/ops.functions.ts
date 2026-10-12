/** Cross-tenant operator views (Phase 4 stage 4a): webhook deliveries and the console audit log. */
import { createServerFn } from '@tanstack/react-start'

import { deliveryQueryParams } from '@/features/tenant-data/list.params'
import { readAuditLog } from '@/server/audit-log.server'
import { operatorReadMiddleware } from '@/server/middleware'
import { platformFor, unwrap } from '@/server/platform.server'

import { auditSearch, opsDeliverySearch } from './ops.schemas'

export const listDeliveriesAcrossTenants = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(opsDeliverySearch)
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal).GET('/admin/webhook-deliveries', { params: { query: { ...deliveryQueryParams({ ...data, status: data.status ?? 'dead' }), tenantId: data.tenantId } } }))
  )

/** One page of the audit log; `readAuditLog` (shared with the export) explains how actors are named and searched. */
export const listAuditLog = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(auditSearch)
  .handler(async ({ context, data }) => readAuditLog(context.principal, data))
