/** Cross-tenant operator views (Phase 4 stage 4a): webhook deliveries, the console audit log and the system health. */
import { createServerFn } from '@tanstack/react-start'

import { deliveryQueryParams } from '@/features/tenant-data/list.params'
import { readAuditLog } from '@/server/audit-log.server'
import { OPERATOR_SESSION_MAX_AGE_MS, SESSION_MAX_AGE_MS } from '@/lib/permissions'
import { serverEnv } from '@/server/env.server'
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

const hours = (ms: number) => `${ms / 3_600_000} hours`

/**
 * System health (implement/22-console-feedback.md C16): platform-api's readiness checks, the alerts
 * monitoring pushed to it, and the non-secret settings it runs with. The console adds its own few:
 * who mail is sent as and how long a session lasts. Operators and auditors.
 */
export const getSystemHealth = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .handler(async ({ context }) => {
    const health = unwrap(await platformFor(context.principal).GET('/admin/health'))
    const env = serverEnv()
    const consoleSettings = [
      { group: 'Console', label: 'Mail is sent as', value: env.MAIL_FROM },
      { group: 'Console', label: 'Mail server', value: env.SMTP_URL ? 'configured' : 'not configured' },
      { group: 'Console', label: 'Operator and auditor session', value: hours(OPERATOR_SESSION_MAX_AGE_MS) },
      { group: 'Console', label: 'Member session', value: hours(SESSION_MAX_AGE_MS) },
    ]
    return { ...health, settings: [...health.settings, ...consoleSettings] }
  })
