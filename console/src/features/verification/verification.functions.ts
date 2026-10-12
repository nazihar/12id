/**
 * Data of the Verification page and the customer page (implement/22-console-feedback.md C10, C11).
 * Reads only. Each exists twice, like the dashboards: for a tenant member (the tenant comes from the
 * active organization) and for an operator or auditor looking at one tenant (named per call).
 * Membership is enough to read them; platform-api serves these routes to the console only.
 */
import { createServerFn } from '@tanstack/react-start'

import { dashboardRangeInput } from '@/features/dashboard/dashboard.schemas'
import { tenantInput } from '@/features/tenants/tenants.schemas'
import { createdParams, pageParams } from '@/lib/list-search'
import { type Principal, operatorReadMiddleware, tenantMiddleware } from '@/server/middleware'
import { platformFor, unwrap } from '@/server/platform.server'

import { type CustomerSearch, checkQueryParams, checkSearch, connectionInput, customerSearch } from './verification.schemas'

type Platform = ReturnType<typeof platformFor>

const verification = async (platform: Platform, days: 7 | 30 | 90) => unwrap(await platform.GET('/v1/stats/verification', { params: { query: { days } } }))

/** One page of what the customer page's tab shows, always for the one connection. */
async function customerRecords(platform: Platform, connectionId: string, search: CustomerSearch) {
  if (search.tab === 'checks') {
    const query = { ...pageParams(search), ...createdParams(search), status: search.state, connectionId }
    return { tab: 'checks' as const, page: unwrap(await platform.GET('/v1/biometrics/checks', { params: { query } })) }
  }
  const query = { ...pageParams(search), ...createdParams(search), state: search.state, connectionId }
  if (search.tab === 'proofs') return { tab: 'proofs' as const, page: unwrap(await platform.GET('/v1/proofs', { params: { query } })) }
  return { tab: 'credentials' as const, page: unwrap(await platform.GET('/v1/credentials', { params: { query } })) }
}

const forTenant = (principal: Principal, tenantId: string) => platformFor(principal, { tenantId })

// --- tenant portal ----------------------------------------------------------------------------

export const getPortalVerification = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(dashboardRangeInput)
  .handler(async ({ context, data }) => verification(platformFor(context.principal), data.days))

export const listPortalChecks = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(checkSearch)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/biometrics/checks', { params: { query: checkQueryParams(data) } })))

export const getPortalCustomer = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(connectionInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/connections/{id}/activity', { params: { path: { id: data.connectionId } } })))

export const listPortalCustomerRecords = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(connectionInput.extend(customerSearch.shape))
  .handler(async ({ context, data }) => customerRecords(platformFor(context.principal), data.connectionId, data))

// --- operator area (operators and auditors) ---------------------------------------------------

export const getTenantVerification = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(tenantInput.extend(dashboardRangeInput.shape))
  .handler(async ({ context, data }) => verification(forTenant(context.principal, data.tenantId), data.days))

export const listTenantChecks = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(tenantInput.extend(checkSearch.shape))
  .handler(async ({ context, data }) => unwrap(await forTenant(context.principal, data.tenantId).GET('/v1/biometrics/checks', { params: { query: checkQueryParams(data) } })))

export const getTenantCustomer = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(tenantInput.extend(connectionInput.shape))
  .handler(async ({ context, data }) => unwrap(await forTenant(context.principal, data.tenantId).GET('/v1/connections/{id}/activity', { params: { path: { id: data.connectionId } } })))

export const listTenantCustomerRecords = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(tenantInput.extend(connectionInput.shape).extend(customerSearch.shape))
  .handler(async ({ context, data }) => customerRecords(forTenant(context.principal, data.tenantId), data.connectionId, data))
