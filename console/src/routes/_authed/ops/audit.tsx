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
import { formatDateTime } from '@/lib/format'

type AuditRow = Awaited<ReturnType<typeof listAuditLog>>[number]

const column = createColumnHelper<DataTableFeatures, AuditRow>()
const columns = column.columns([
  column.accessor('at', { header: 'When', cell: ({ getValue }) => formatDateTime(getValue()) }),
  // Searchable by email and id; break-glass entries ("admin-token") have no account.
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
  loader: ({ context }) => context.queryClient.ensureQueryData(auditLogQuery()),
  errorComponent: RouteError,
  component: AuditPage,
})

function AuditPage() {
  const { data } = useSuspenseQuery(auditLogQuery())
  return (
    <section className="space-y-4">
      <PageHeader title="Audit log" description="Every change made through the console and the break-glass token, plus reads of webhook bodies. The latest 200 entries." />
      <DataTable columns={columns} data={data} searchPlaceholder="Search actor, route or tenant" emptyMessage="No audit entries." />
    </section>
  )
}
