/**
 * Dashboard data (Phase 4 C8). Reads only: the operator dashboard from `/admin/stats`, the tenant
 * dashboard from `/v1/stats` for the member's active organization, and the same tenant dashboard for
 * an operator looking at one tenant. Membership is enough for the tenant dashboard (no statement).
 */
import { createServerFn } from '@tanstack/react-start'

import { tenantInput } from '@/features/tenants/tenants.schemas'
import { operatorReadMiddleware, tenantMiddleware } from '@/server/middleware'
import { platformFor, unwrap } from '@/server/platform.server'

import { dashboardRangeInput } from './dashboard.schemas'

export const getOperatorDashboard = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(dashboardRangeInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/admin/stats', { params: { query: { days: data.days } } })))

export const getTenantDashboard = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(dashboardRangeInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/stats', { params: { query: { days: data.days } } })))

export const getTenantDashboardFor = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(tenantInput.extend(dashboardRangeInput.shape))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/stats', { params: { query: { days: data.days } } })))
