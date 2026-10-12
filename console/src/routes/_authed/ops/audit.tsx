import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { FileSearchIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { RowAction, RowActions } from '@/components/row-action'
import { StateBadge } from '@/components/state-badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { exportOpsList } from '@/features/export/export.functions'
import { auditAction, auditKindOptions, auditResult } from '@/features/ops/audit-events'
import type { listAuditLog } from '@/features/ops/ops.functions'
import { auditLogQuery } from '@/features/ops/ops.queries'
import { type AuditSearch, auditSearch } from '@/features/ops/ops.schemas'
import { ExportMenu } from '@/components/data-table/export-menu'
import { DateRangeFilter, SelectFilter } from '@/components/data-table/list-toolbar'
import { useListPending } from '@/components/data-table/use-list-pending'
import { formatDateTime } from '@/lib/format'
import { isFiltered, pagingFor, resetFor, parseListSearch, searchPatcher } from '@/lib/list-search'

type AuditRow = Awaited<ReturnType<typeof listAuditLog>>['items'][number]

const column = createColumnHelper<DataTableFeatures, AuditRow>()
const baseColumns = [
  column.accessor('at', { header: 'When', cell: ({ getValue }) => formatDateTime(getValue()) }),
  // Break-glass entries ("admin-token") have no account.
  column.accessor((row) => `${row.actorEmail ?? ''} ${row.actor}`, {
    id: 'actor',
    header: 'Actor',
    cell: ({ row }) =>
      row.original.actorEmail ? (
        <span title={row.original.actor}>{row.original.actorEmail}</span>
      ) : (
        <span className="font-mono text-xs">{row.original.actor}</span>
      ),
  }),
  column.accessor('role', { header: 'Role', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  column.accessor('tenantId', {
    header: 'Tenant',
    cell: ({ getValue }) => {
      const tenantId = getValue()
      return tenantId ? (
        <Link to="/ops/tenants/$tenantId" params={{ tenantId }} className="font-mono text-xs hover:underline">
          {tenantId.slice(0, 8)}
        </Link>
      ) : (
        '—'
      )
    },
  }),
  column.accessor((row) => auditAction(row).text, {
    id: 'action',
    header: 'Action',
    // A call is shown as it was made; an event (a sign-in, an account change, an export) by its name.
    cell: ({ row }) => {
      const action = auditAction(row.original)
      return action.event ? <span title={row.original.route}>{action.text}</span> : <span className="font-mono text-xs">{action.text}</span>
    },
  }),
  column.accessor((row) => auditResult(row), { id: 'result', header: 'Result' }),
]

export const Route = createFileRoute('/_authed/ops/audit')({
  validateSearch: parseListSearch(auditSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(auditLogQuery(deps)),
  errorComponent: RouteError,
  component: AuditPage,
})

function AuditPage() {
  const search = Route.useSearch()
  const onSearch = searchPatcher<AuditSearch>(Route.useNavigate())
  const { data } = useSuspenseQuery(auditLogQuery(search))
  const [viewing, setViewing] = useState<AuditRow | null>(null)
  const columns = useMemo(
    () =>
      column.columns([
        ...baseColumns,
        column.display({
          id: 'actions',
          header: '',
          cell: ({ row }) =>
            row.original.changes || row.original.reason ? (
              <RowActions>
                <RowAction label="Details" icon={FileSearchIcon} onClick={() => setViewing(row.original)} />
              </RowActions>
            ) : null,
        }),
      ]),
    []
  )
  return (
    <section className="space-y-4">
      <PageHeader
        title="Audit log"
        description="Every change made through the console and the break-glass token, with what it changed; reads of webhook bodies; sign-ins and failed sign-ins; account changes; exports. Newest first."
      />
      <DataTable
        columns={columns}
        data={data.items}
        paging={pagingFor(data, onSearch)}
        onReset={resetFor(search, onSearch)}
        search={{ value: search.q, placeholder: 'Search actor, email, route or event', onChange: (q) => onSearch({ q }) }}
        toolbar={
          <>
            <SelectFilter label="Kind" options={auditKindOptions} value={search.kind} onChange={(kind) => onSearch({ kind })} testId="audit-kind" />
            <DateRangeFilter label="Date" from={search.from} to={search.to} onChange={(range) => onSearch(range)} />
          </>
        }
        actions={<ExportMenu onExport={(format) => exportOpsList({ data: { list: 'audit', format, search } })} />}
        fetching={useListPending()}
        emptyMessage={isFiltered(search) ? 'No audit entries match.' : 'No audit entries.'}
        testId="audit-table"
      />
      <AuditEntryDialog entry={viewing} onClose={() => setViewing(null)} />
    </section>
  )
}

/** Review L10: what a change was. Secrets and personal data were replaced before it was stored. */
function AuditEntryDialog({ entry, onClose }: { entry: AuditRow | null; onClose: () => void }) {
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto overscroll-contain sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className={entry && auditAction(entry).event ? 'text-sm' : 'font-mono text-sm'}>{entry ? auditAction(entry).text : ''}</DialogTitle>
          <DialogDescription>
            {entry ? `${formatDateTime(entry.at)} by ${entry.actorEmail ?? entry.actor}, result ${auditResult(entry)}.` : ''} Secrets and personal data were replaced before this was stored.
          </DialogDescription>
        </DialogHeader>
        {entry?.reason && (
          <p className="text-sm">
            <span className="text-muted-foreground">Reason: </span>
            {entry.reason}
          </p>
        )}
        {entry?.changes ? (
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs" data-testid="audit-changes">
            {entry.changes}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">No change recorded: a read, or a call without parameters or a body.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
