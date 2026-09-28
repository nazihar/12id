/**
 * Retention (Phase 7 H1). Finished exchanges keep their personal data for a period, then it is
 * scrubbed exactly as an erasure request would (erasure.ts), marked `erased_by = 'retention'`. The
 * rows stay, so dashboards and history are unchanged. Webhook delivery bodies older than the period
 * are scrubbed too, whatever their event.
 *
 * The period is per tenant: `tenants.retention_days`, else RETENTION_DAYS (default 90). 0 keeps the
 * data until it is erased on request. Retention sends no `record.erased` webhook and writes no
 * `erasures` row: the tenant chose the period, and the row itself says when and why.
 *
 * Runs on a timer in main.ts. Idempotent; a failure for one tenant (agent unreachable) is logged and
 * the next tenant goes on; the rows it could not finish are picked up by the next pass.
 */
import { asc, gt } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import { tenants } from './db/schema.ts'
import { type ErasureDeps, dueForRetention, scrubExchanges, scrubOldDeliveries } from './erasure.ts'

export interface RetentionDeps extends ErasureDeps {
  /** Platform default in days; 0 = keep. */
  defaultDays: number
  now?: () => Date
  batch?: number
}

export interface RetentionReport {
  tenants: number
  credentials: number
  proofs: number
  deliveries: number
  failed: number
}

const DAY = 24 * 60 * 60 * 1000

/** The period that applies to a tenant: its own setting, else the platform default. */
export const effectiveRetentionDays = (tenantDays: number | null, defaultDays: number) => tenantDays ?? defaultDays

export async function retentionOnce(deps: RetentionDeps): Promise<RetentionReport> {
  const now = deps.now?.() ?? new Date()
  const batch = deps.batch ?? 100
  const report: RetentionReport = { tenants: 0, credentials: 0, proofs: 0, deliveries: 0, failed: 0 }

  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const page = await deps.db
      .select({ id: tenants.id, agentTenantId: tenants.agentTenantId, retentionDays: tenants.retentionDays })
      .from(tenants)
      .where(gt(tenants.id, after))
      .orderBy(asc(tenants.id))
      .limit(200)
    if (page.length === 0) break
    after = page[page.length - 1]!.id

    for (const tenant of page) {
      const days = effectiveRetentionDays(tenant.retentionDays, deps.defaultDays)
      if (days <= 0) continue
      const before = new Date(now.getTime() - days * DAY)
      report.tenants += 1
      try {
        for (const kind of ['credential', 'proof'] as const) {
          for (;;) {
            const due = await dueForRetention(deps.db, tenant.id, kind, before, batch)
            if (due.length === 0) break
            await scrubExchanges(deps, tenant, kind, due, 'retention', now)
            if (kind === 'credential') report.credentials += due.length
            else report.proofs += due.length
            if (due.length < batch) break
          }
        }
        for (;;) {
          const scrubbed = await scrubOldDeliveries(deps.db, tenant.id, before, batch * 5, now)
          report.deliveries += scrubbed
          if (scrubbed < batch * 5) break
        }
      } catch (error) {
        report.failed += 1
        deps.logger.error({ err: error, component: 'retention', tenantId: tenant.id }, 'retention pass failed for tenant; retried next pass')
      }
    }
    if (page.length < 200) break
  }

  deps.logger.info({ component: 'retention', ...report }, 'retention pass done')
  return report
}

/** Runs `retentionOnce` every `intervalMs` (first pass after two minutes). Returns a stop function. */
export function startRetention(deps: RetentionDeps, intervalMs: number) {
  let stopped = false
  let running: Promise<unknown> = Promise.resolve()
  const tick = () => {
    if (stopped) return
    running = retentionOnce(deps).catch((error: unknown) => deps.logger.error({ err: error, component: 'retention' }, 'retention pass failed'))
  }
  const first = setTimeout(tick, Math.min(120_000, intervalMs))
  const timer = setInterval(tick, intervalMs)
  return async () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
    await running
  }
}

