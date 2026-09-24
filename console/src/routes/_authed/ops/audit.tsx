import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import type { listAuditLog } from '@/features/ops/ops.functions'
import { auditLogQuery } from '@/features/ops/ops.queries'
import { type AuditSearch, auditSearch } from '@/features/ops/ops.schemas'
import { DateRangeFilter } from '@/components/data-table/list-toolbar'
import { useListPending } from '@/components/data-table/use-list-pending'
import { formatDateTime } from '@/lib/format'
import { isFiltered, pagingFor, resetFor, parseListSearch, searchPatcher } from '@/lib/list-search'

type AuditRow = Awaited<ReturnType<typeof listAuditLog>>['items'][number]

const column = createColumnHelper<DataTableFeatures, AuditRow>()
const columns = column.columns([
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
  column.accessor((row) => `${row.method} ${row.route}`, { id: 'action', header: 'Action', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> }),
  column.accessor('statusCode', { header: 'Result' }),
])

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
  return (
    <section className="space-y-4">
      <PageHeader title="Audit log" description="Every change made through the console and the break-glass token, plus reads of webhook bodies. Newest first." />
      <DataTable
        columns={columns}
        data={data.items}
        paging={pagingFor(data, onSearch)}
        onReset={resetFor(search, onSearch)}
        search={{ value: search.q, placeholder: 'Search actor, email or route', onChange: (q) => onSearch({ q }) }}
        toolbar={<DateRangeFilter label="Date" from={search.from} to={search.to} onChange={(range) => onSearch(range)} />}
        fetching={useListPending()}
        emptyMessage={isFiltered(search) ? 'No audit entries match.' : 'No audit entries.'}
        testId="audit-table"
      />
    </section>
  )
}
