import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CreateTenantOrganizationDialog } from '@/features/tenants/create-tenant-organization-dialog'
import type { getTenantOrganization } from '@/features/tenants/tenant-owner.functions'
import { tenantOrganizationQuery, tenantQuery } from '@/features/tenants/tenants.queries'
import { formatDateTime } from '@/lib/format'

type MemberRow = NonNullable<Awaited<ReturnType<typeof getTenantOrganization>>>['members'][number]

const column = createColumnHelper<DataTableFeatures, MemberRow>()
const memberColumns = column.columns([
  column.accessor('name', { header: 'Name' }),
  column.accessor('email', { header: 'Email' }),
  column.accessor('role', { header: 'Role', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  column.accessor('twoFactorEnabled', { header: '2FA', cell: ({ getValue }) => (getValue() ? 'on' : 'not set up') }),
  column.accessor('since', { header: 'Member since', cell: ({ getValue }) => formatDateTime(getValue()) }),
])

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(tenantOrganizationQuery(params.tenantId)),
  errorComponent: RouteError,
  component: TenantOverviewPage,
})

function TenantOverviewPage() {
  const { tenantId } = Route.useParams()
  const { data: tenant } = useSuspenseQuery(tenantQuery(tenantId))
  const { data: organization } = useSuspenseQuery(tenantOrganizationQuery(tenantId))

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Tenant</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Platform id</dt>
            <dd className="font-mono text-xs break-all">{tenant.id}</dd>
            <dt className="text-muted-foreground">Agent tenant</dt>
            <dd className="font-mono text-xs break-all">{tenant.agentTenantId}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatDateTime(tenant.createdAt)}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Console organization</CardTitle>
          <CardDescription>{organization ? `/${organization.slug}` : 'Customer staff sign in to the tenant portal through this organization.'}</CardDescription>
          {!organization && (
            <CardAction>
              <CreateTenantOrganizationDialog tenantId={tenantId} ready={tenant.status === 'ready'} />
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {organization ? (
            <DataTable columns={memberColumns} data={organization.members} emptyMessage="No members." pageSize={10} testId="members-table" />
          ) : (
            <p className="text-sm text-muted-foreground">No organization yet. Create one with its first owner; the owner invites the rest of the team from the portal.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
