import { queryOptions } from '@tanstack/react-query'

import type { DeliveryStatus } from '@/features/tenant-data/tenant-data.queries'

import { listAuditLog, listDeliveriesAcrossTenants } from './ops.functions'

export const deliveriesAcrossTenantsQuery = (status: DeliveryStatus = 'dead') =>
  queryOptions({
    queryKey: ['ops', 'deliveries', status],
    queryFn: () => listDeliveriesAcrossTenants({ data: { status } }),
  })

export const auditLogQuery = (filters: { tenantId?: string; actor?: string } = {}) =>
  queryOptions({
    queryKey: ['ops', 'audit', filters.tenantId ?? 'all', filters.actor ?? 'all'],
    queryFn: () => listAuditLog({ data: filters }),
  })
