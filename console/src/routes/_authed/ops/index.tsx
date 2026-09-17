import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { CreateTenantDialog } from '@/features/tenants/create-tenant-dialog'
import type { getTenantOverview } from '@/features/tenants/tenants.functions'
import { tenantOverviewQuery } from '@/features/tenants/tenants.queries'
import { formatDateTime } from '@/lib/format'

type TenantRow = Awaited<ReturnType<typeof getTenantOverview>>[number]

const column = createColumnHelper<DataTableFeatures, TenantRow>()
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, n) => total + n, 0)

const columns = column.columns([
  column.accessor((row) => row.tenant.name, {
    id: 'name',
    header: 'Name',
    cell: ({ row }) => (
      <Link to="/ops/tenants/$tenantId" params={{ tenantId: row.original.tenant.id }} className="font-medium hover:underline">
        {row.original.tenant.name}
      </Link>
    ),
  }),
  column.accessor((row) => row.tenant.status, { id: 'status', header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  column.accessor((row) => sum(row.connections), { id: 'connections', header: 'Connections' }),
  column.accessor((row) => sum(row.credentials), { id: 'credentials', header: 'Credential exchanges' }),
  column.accessor((row) => row.apiKeys.active, { id: 'apiKeys', header: 'Active API keys' }),
  column.accessor('deadDeliveries', { header: 'Dead deliveries' }),
  column.accessor('lastActivityAt', { header: 'Last activity', cell: ({ getValue }) => formatDateTime(getValue()) }),
])

export const Route = createFileRoute('/_authed/ops/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(tenantOverviewQuery()),
  errorComponent: RouteError,
  component: TenantsPage,
})

function TenantsPage() {
  const { data: tenants } = useSuspenseQuery(tenantOverviewQuery())
  return (
    <section className="space-y-4">
      <PageHeader title="Tenants" description="Every customer tenant on the platform with its onboarding state and activity." actions={<CreateTenantDialog />} />
      <DataTable columns={columns} data={tenants} searchPlaceholder="Search tenants" emptyMessage="No tenants yet." testId="tenants-table" />
    </section>
  )
}
