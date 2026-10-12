import { keepPreviousData, queryOptions } from '@tanstack/react-query'

import type { DashboardRange } from '@/features/dashboard/dashboard.schemas'
import { portalKey } from '@/features/portal/portal.queries'

import {
  getPortalCustomer,
  getPortalVerification,
  getTenantCustomer,
  getTenantVerification,
  listPortalChecks,
  listPortalCustomerRecords,
  listTenantChecks,
  listTenantCustomerRecords,
} from './verification.functions'
import type { CheckSearch, CustomerSearch } from './verification.schemas'

// Numbers, not records: a minute of staleness is fine and keeps range switches instant (as the dashboards).
const STALE_MS = 60_000
const list = { placeholderData: keepPreviousData }
const tenantKey = (tenantId: string, ...rest: unknown[]) => ['ops', 'tenant', tenantId, ...rest]

export const portalVerificationQuery = (slug: string, days: DashboardRange) =>
  queryOptions({ queryKey: portalKey(slug, 'verification', String(days)), queryFn: () => getPortalVerification({ data: { days } }), staleTime: STALE_MS })
export const portalChecksQuery = (slug: string, search: CheckSearch = {}) => queryOptions({ queryKey: portalKey(slug, 'checks', search), queryFn: () => listPortalChecks({ data: search }), ...list })
export const portalCustomerQuery = (slug: string, connectionId: string) => queryOptions({ queryKey: portalKey(slug, 'customer', connectionId), queryFn: () => getPortalCustomer({ data: { connectionId } }) })
export const portalCustomerRecordsQuery = (slug: string, connectionId: string, search: CustomerSearch = {}) =>
  queryOptions({ queryKey: portalKey(slug, 'customer', connectionId, 'records', search), queryFn: () => listPortalCustomerRecords({ data: { connectionId, ...search } }), ...list })

export const tenantVerificationQuery = (tenantId: string, days: DashboardRange) =>
  queryOptions({ queryKey: tenantKey(tenantId, 'verification', days), queryFn: () => getTenantVerification({ data: { tenantId, days } }), staleTime: STALE_MS })
export const tenantChecksQuery = (tenantId: string, search: CheckSearch = {}) => queryOptions({ queryKey: tenantKey(tenantId, 'checks', search), queryFn: () => listTenantChecks({ data: { tenantId, ...search } }), ...list })
export const tenantCustomerQuery = (tenantId: string, connectionId: string) => queryOptions({ queryKey: tenantKey(tenantId, 'customer', connectionId), queryFn: () => getTenantCustomer({ data: { tenantId, connectionId } }) })
export const tenantCustomerRecordsQuery = (tenantId: string, connectionId: string, search: CustomerSearch = {}) =>
  queryOptions({ queryKey: tenantKey(tenantId, 'customer', connectionId, 'records', search), queryFn: () => listTenantCustomerRecords({ data: { tenantId, connectionId, ...search } }), ...list })

export type VerificationStats = Awaited<ReturnType<typeof getPortalVerification>>
export type ChecksPage = Awaited<ReturnType<typeof listPortalChecks>>
export type CheckRow = ChecksPage['items'][number]
export type CustomerActivity = Awaited<ReturnType<typeof getPortalCustomer>>
export type CustomerRecords = Awaited<ReturnType<typeof listPortalCustomerRecords>>
