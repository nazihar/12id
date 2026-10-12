/**
 * Audit log period (implement/22-console-feedback.md C15). Audit rows older than a period are
 * deleted. The period is longer than the one for end users' data on purpose (`retention.ts`): the
 * audit has to outlast the data it describes, or the record that someone revealed or erased a
 * person's data would disappear together with that data.
 *
 *   - a row with a tenant follows `tenants.audit_retention_days`, else AUDIT_RETENTION_DAYS;
 *   - a row with no tenant (sign-ins, operator and platform changes), or with a tenant id that names
 *     no tenant, follows AUDIT_RETENTION_DAYS;
 *   - 0 keeps everything.
 *
 * `console_audit` is append-only (migrations 0012, 0014): its trigger lets a DELETE through only
 * inside a transaction that set `app.audit_purge`, which nothing but `deleteBatch` here does. A pass
 * that deleted rows writes one audit row saying how many and up to when, so the gap is explained.
 * The erasure log is never deleted: it is the proof that a request was honoured.
 *
 * Runs with retention on the sweep's schedule (`retention.ts` `startRetention`). Idempotent.
 */
import { type SQL, asc, gt, sql } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { Database } from './db/client.ts'
import { consoleAudit, tenants } from './db/schema.ts'

/** A period a tenant or the deployment may choose: a year to ten years, or 0 to keep everything. */
export const AUDIT_RETENTION_MIN_DAYS = 365
export const AUDIT_RETENTION_MAX_DAYS = 3650
export const validAuditRetentionDays = (days: number) => days === 0 || (days >= AUDIT_RETENTION_MIN_DAYS && days <= AUDIT_RETENTION_MAX_DAYS)

/** `route` of the row a pass leaves behind (method `EVENT`, like what the console reports). */
export const AUDIT_PURGED_EVENT = 'audit.purged'

export interface AuditRetentionDeps {
  db: Database
  logger: PinoLogger
  /** Deployment period in days; 0 = keep. */
  defaultDays: number
  now?: () => Date
  batch?: number
}

export interface AuditRetentionReport {
  /** Scopes (tenants, plus the rows with no tenant) that had something to delete. */
  scopes: number
  deleted: number
}

const DAY = 24 * 60 * 60 * 1000

/** The period that applies to a tenant's audit rows: its own setting, else the deployment's. */
export const effectiveAuditRetentionDays = (tenantDays: number | null, defaultDays: number) => tenantDays ?? defaultDays

/** One batch, oldest first. The setting is local to the transaction, so no other statement inherits it. */
async function deleteBatch(db: Database, scope: SQL, before: Date, limit: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.audit_purge', 'on', true)`)
    const result = await tx.execute(
      sql`delete from ${consoleAudit} where ${consoleAudit.id} in (select ${consoleAudit.id} from ${consoleAudit} where ${scope} and ${consoleAudit.at} < ${before.toISOString()} order by ${consoleAudit.at} limit ${limit})`
    )
    return result.rowCount ?? 0
  })
}

async function purgeScope(deps: AuditRetentionDeps, scope: SQL, tenantId: string | null, days: number, now: Date, report: AuditRetentionReport) {
  if (days <= 0) return
  const batch = deps.batch ?? 5000
  const before = new Date(now.getTime() - days * DAY)
  let deleted = 0
  for (;;) {
    const n = await deleteBatch(deps.db, scope, before, batch)
    deleted += n
    if (n < batch) break
  }
  if (deleted === 0) return
  report.scopes += 1
  report.deleted += deleted
  await deps.db.insert(consoleAudit).values({ actor: 'system', role: 'system', tenantId, method: 'EVENT', route: AUDIT_PURGED_EVENT, statusCode: 200, requestId: 'audit-retention', changes: { deleted, olderThan: before.toISOString(), periodDays: days } })
}

export async function auditRetentionOnce(deps: AuditRetentionDeps): Promise<AuditRetentionReport> {
  const now = deps.now?.() ?? new Date()
  const report: AuditRetentionReport = { scopes: 0, deleted: 0 }

  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const page = await deps.db.select({ id: tenants.id, auditRetentionDays: tenants.auditRetentionDays }).from(tenants).where(gt(tenants.id, after)).orderBy(asc(tenants.id)).limit(200)
    if (page.length === 0) break
    after = page[page.length - 1]!.id
    for (const tenant of page) {
      try {
        await purgeScope(deps, sql`${consoleAudit.tenantId} = ${tenant.id}`, tenant.id, effectiveAuditRetentionDays(tenant.auditRetentionDays, deps.defaultDays), now, report)
      } catch (error) {
        deps.logger.error({ err: error, component: 'audit-retention', tenantId: tenant.id }, 'audit retention failed for tenant; retried next pass')
      }
    }
    if (page.length < 200) break
  }

  // Rows of no tenant, and rows whose tenant id names none (a refused call on an unknown tenant).
  await purgeScope(deps, sql`(${consoleAudit.tenantId} is null or not exists (select 1 from ${tenants} where ${tenants.id} = ${consoleAudit.tenantId}))`, null, deps.defaultDays, now, report)

  deps.logger.info({ component: 'audit-retention', ...report }, 'audit retention pass done')
  return report
}
