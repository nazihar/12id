/**
 * Exports of the console's lists (implement/22-console-feedback.md C12). A function returns the
 * typed rows of one list under the filters the page shows; the browser turns them into an Excel or
 * a CSV file (lib/export). So an export is an ordinary guarded read: no route of its own, nothing
 * binary across the boundary, and the same rows whichever format is asked for.
 *
 *   - The list is read through the same platform-api routes as the page, 100 rows at a time, with
 *     the list's own search schema. Above EXPORT_MAX_ROWS the function answers with the total and
 *     exports nothing: the page asks for narrower filters.
 *   - Columns are fixed per list (export.lists.ts) and never include attribute values, disclosed
 *     values or webhook bodies. An operator's and an auditor's export is masked like their pages.
 *   - Every export is written to the audit log: who, which list, which filters, how many rows.
 *
 * Tenant members need the `export` permission (owners and admins). Operators and auditors may
 * export; that is why these are reads (`GET`) and carry the read middleware.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { operatorSearch } from '@/features/operators/operators.schemas'
import { auditSearch } from '@/features/ops/ops.schemas'
import { memberSearch } from '@/features/portal/members.schemas'
import { deliveryQueryParams, exchangeQueryParams, walletQueryParams } from '@/features/tenant-data/list.params'
import { deliverySearch, exchangeSearch, walletSearch } from '@/features/tenant-data/list.schemas'
import { checkQueryParams, checkSearch } from '@/features/verification/verification.schemas'
import type { Page } from '@/lib/list-search'
import { principalActor, recordEvent } from '@/server/audit.server'
import { readAuditLog } from '@/server/audit-log.server'
import { listOrganizationMembers } from '@/server/members.server'
import { listStaffAccounts } from '@/server/staff-accounts.server'
import { type Principal, operatorReadMiddleware, tenantMiddleware } from '@/server/middleware'
import { platformFor, unwrap } from '@/server/platform.server'

import { ACCOUNT_EXPORTS, EXPORT_FORMATS, EXPORT_MAX_ROWS, type ExportFormat, type ExportResult, type ExportTable, OPS_EXPORTS, OPS_EXPORT_LISTS, TENANT_EXPORTS, TENANT_EXPORT_LISTS, type TenantExportList, exportFilename, tableOf } from './export.lists'

const PAGE_SIZE = 100
const exportInput = z.object({ format: z.enum(EXPORT_FORMATS), search: z.record(z.string(), z.unknown()).default({}) })

/** Every row of a list, or its total when it is too long to export. */
async function everyRow<Row>(fetchPage: (page: number) => Promise<Page<Row>>): Promise<{ rows: Row[] } | { total: number }> {
  const first = await fetchPage(1)
  if (first.total > EXPORT_MAX_ROWS) return { total: first.total }
  const rows = [...first.items]
  for (let page = 2; rows.length < first.total && page <= EXPORT_MAX_ROWS / PAGE_SIZE; page += 1) {
    const next = await fetchPage(page)
    if (next.items.length === 0) break
    rows.push(...next.items)
  }
  return { rows }
}

/** The filters as the audit records them: what narrowed the list, without paging and tabs. */
function filtersOf(search: Record<string, unknown>) {
  const { page: _page, pageSize: _pageSize, tab: _tab, days: _days, ...filters } = search
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined))
}

async function finish(principal: Principal, tenantId: string | null, list: string, format: ExportFormat, search: Record<string, unknown>, read: { table: ExportTable } | { total: number }): Promise<ExportResult> {
  if ('total' in read) return { ok: false, total: read.total, max: EXPORT_MAX_ROWS }
  await recordEvent({ type: 'export.run', actor: principalActor(principal), tenantId, detail: { list, format, rows: read.table.rows.length, filters: filtersOf(search) } })
  return { ok: true, filename: exportFilename(read.table.name, format), table: read.table }
}

/** One tenant's list as a table. A search that does not fit the list's schema is refused, never widened. */
async function tenantTable(platform: ReturnType<typeof platformFor>, list: TenantExportList, raw: Record<string, unknown>) {
  const paged = <Query extends object>(query: Query, page: number) => ({ ...query, page, pageSize: PAGE_SIZE })
  const done = <Row>(definition: Parameters<typeof tableOf<Row>>[0], read: { rows: Row[] } | { total: number }) => ('total' in read ? read : { table: tableOf(definition, read.rows) })
  switch (list) {
    case 'connections': {
      const query = exchangeQueryParams(exchangeSearch.parse(raw))
      return done(TENANT_EXPORTS.connections, await everyRow(async (page) => unwrap(await platform.GET('/v1/connections', { params: { query: paged(query, page) } }))))
    }
    case 'credentials': {
      const query = exchangeQueryParams(exchangeSearch.parse(raw))
      return done(TENANT_EXPORTS.credentials, await everyRow(async (page) => unwrap(await platform.GET('/v1/credentials', { params: { query: paged(query, page) } }))))
    }
    case 'proofs': {
      const query = exchangeQueryParams(exchangeSearch.parse(raw))
      return done(TENANT_EXPORTS.proofs, await everyRow(async (page) => unwrap(await platform.GET('/v1/proofs', { params: { query: paged(query, page) } }))))
    }
    case 'wallets': {
      const query = walletQueryParams(walletSearch.parse(raw))
      return done(TENANT_EXPORTS.wallets, await everyRow(async (page) => unwrap(await platform.GET('/v1/wallets', { params: { query: paged(query, page) } }))))
    }
    case 'checks': {
      const query = checkQueryParams(checkSearch.parse(raw))
      return done(TENANT_EXPORTS.checks, await everyRow(async (page) => unwrap(await platform.GET('/v1/biometrics/checks', { params: { query: paged(query, page) } }))))
    }
    case 'deliveries': {
      const query = deliveryQueryParams(deliverySearch.parse(raw))
      return done(TENANT_EXPORTS.deliveries, await everyRow(async (page) => unwrap(await platform.GET('/v1/webhook/deliveries', { params: { query: paged(query, page) } }))))
    }
  }
}

/** A tenant member exports one of the organization's lists (owners and admins). */
export const exportPortalList = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware({ export: ['run'] })])
  .validator(exportInput.extend({ list: z.enum(TENANT_EXPORT_LISTS) }))
  .handler(async ({ context, data }): Promise<ExportResult> => finish(context.principal, context.principal.tenantId, data.list, data.format, data.search, await tenantTable(platformFor(context.principal), data.list, data.search)))

/** An operator or auditor exports one tenant's list; personal data stays masked. */
export const exportTenantList = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(exportInput.extend({ list: z.enum(TENANT_EXPORT_LISTS), tenantId: z.uuid() }))
  .handler(
    async ({ context, data }): Promise<ExportResult> => finish(context.principal, data.tenantId, data.list, data.format, data.search, await tenantTable(platformFor(context.principal, { tenantId: data.tenantId }), data.list, data.search))
  )

/** An operator or auditor exports a list of the operator area: the audit log. */
export const exportOpsList = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(exportInput.extend({ list: z.enum(OPS_EXPORT_LISTS) }))
  .handler(async ({ context, data }): Promise<ExportResult> => {
    const search = auditSearch.parse(data.search)
    const read = await everyRow((page) => readAuditLog(context.principal, { ...search, page, pageSize: PAGE_SIZE }))
    return finish(context.principal, search.tenantId ?? null, data.list, data.format, data.search, 'total' in read ? read : { table: tableOf(OPS_EXPORTS.audit, read.rows) })
  })

/** An operator or auditor exports the operator area's accounts (implement/26). */
export const exportOperatorAccounts = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(exportInput)
  .handler(async ({ context, data }): Promise<ExportResult> => {
    const search = operatorSearch.parse(data.search)
    const read = await everyRow((page) => listStaffAccounts({ ...search, page, pageSize: PAGE_SIZE }))
    return finish(context.principal, null, 'operators', data.format, data.search, 'total' in read ? read : { table: tableOf(ACCOUNT_EXPORTS.operators, read.rows) })
  })

/** A tenant member with the export permission exports the organization's members (implement/26). */
export const exportPortalMembers = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware({ export: ['run'] })])
  .validator(exportInput)
  .handler(async ({ context, data }): Promise<ExportResult> => {
    const search = memberSearch.parse(data.search)
    const read = await everyRow((page) => listOrganizationMembers(context.organization.id, { ...search, page, pageSize: PAGE_SIZE }))
    return finish(context.principal, context.principal.tenantId, 'members', data.format, data.search, 'total' in read ? read : { table: tableOf(ACCOUNT_EXPORTS.members, read.rows) })
  })
