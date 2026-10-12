import { keepPreviousData, queryOptions } from '@tanstack/react-query'

import { getSystemHealth, listAuditLog, listDeliveriesAcrossTenants } from './ops.functions'
import type { AuditSearch, OpsDeliverySearch } from './ops.schemas'

export const deliveriesAcrossTenantsQuery = (search: OpsDeliverySearch = {}) =>
  queryOptions({
    queryKey: ['ops', 'deliveries', search],
    queryFn: () => listDeliveriesAcrossTenants({ data: search }),
    placeholderData: keepPreviousData,
  })

export const auditLogQuery = (search: AuditSearch = {}) =>
  queryOptions({
    queryKey: ['ops', 'audit', search],
    queryFn: () => listAuditLog({ data: search }),
    placeholderData: keepPreviousData,
  })

export type SystemHealth = Awaited<ReturnType<typeof getSystemHealth>>

export const systemHealthQuery = () => queryOptions({ queryKey: ['ops', 'health'], queryFn: () => getSystemHealth() })
