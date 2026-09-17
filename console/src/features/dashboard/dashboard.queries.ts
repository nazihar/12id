import { queryOptions } from '@tanstack/react-query'

import { portalKey } from '@/features/portal/portal.queries'

import { getOperatorDashboard, getTenantDashboard, getTenantDashboardFor } from './dashboard.functions'
import type { DashboardRange } from './dashboard.schemas'

// Numbers, not records: a minute of staleness is fine and keeps range switches instant.
const STALE_MS = 60_000

export const operatorDashboardQuery = (days: DashboardRange) =>
  queryOptions({ queryKey: ['ops', 'dashboard', days], queryFn: () => getOperatorDashboard({ data: { days } }), staleTime: STALE_MS })

export const portalDashboardQuery = (slug: string, days: DashboardRange) =>
  queryOptions({ queryKey: portalKey(slug, 'dashboard', String(days)), queryFn: () => getTenantDashboard({ data: { days } }), staleTime: STALE_MS })

export const tenantDashboardQuery = (tenantId: string, days: DashboardRange) =>
  queryOptions({ queryKey: ['ops', 'tenant', tenantId, 'dashboard', days], queryFn: () => getTenantDashboardFor({ data: { tenantId, days } }), staleTime: STALE_MS })

export type TenantDashboard = Awaited<ReturnType<typeof getTenantDashboard>>
export type OperatorDashboard = Awaited<ReturnType<typeof getOperatorDashboard>>
