import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'

import { RangeTabs } from '@/components/dashboard/range-tabs'
import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { tenantDashboardQuery } from '@/features/dashboard/dashboard.queries'
import { parseDashboardSearch, rangeOf } from '@/features/dashboard/dashboard.schemas'
import { TenantDashboardBody, type TenantDashboardLinks } from '@/features/dashboard/tenant-dashboard'
import { CreateTenantOrganizationDialog } from '@/features/tenants/create-tenant-organization-dialog'
import type { getTenantOrganization } from '@/features/tenants/tenant-owner.functions'
import { tenantOrganizationQuery, tenantQuery } from '@/features/tenants/tenants.queries'
import { formatDateTime } from '@/lib/format'
import { type PageSize, pagingFor } from '@/lib/list-search'

type MemberRow = NonNullable<Awaited<ReturnType<typeof getTenantOrganization>>>['members']['items'][number]

const column = createColumnHelper<DataTableFeatures, MemberRow>()
const memberColumns = column.columns([
  column.accessor('name', { header: 'Name' }),
  column.accessor('email', { header: 'Email' }),
  column.accessor('role', { header: 'Role', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  column.accessor('twoFactorEnabled', { header: '2FA', cell: ({ getValue }) => (getValue() ? 'on' : 'not set up') }),
  column.accessor('since', { header: 'Member since', cell: ({ getValue }) => formatDateTime(getValue()) }),
])

// Tenant overview: the same dashboard body the tenant sees in its portal (C8), then the operator-only cards.
export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/')({
  validateSearch: parseDashboardSearch,
  loaderDeps: ({ search }) => ({ days: rangeOf(search) }),
  loader: ({ context, params, deps }) => Promise.all([context.queryClient.ensureQueryData(tenantOrganizationQuery(params.tenantId)), context.queryClient.ensureQueryData(tenantDashboardQuery(params.tenantId, deps.days))]),
  errorComponent: RouteError,
  component: TenantOverviewPage,
})

function TenantOverviewPage() {
  const { tenantId } = Route.useParams()
  const { data: tenant } = useSuspenseQuery(tenantQuery(tenantId))
  const { data: organization } = useSuspenseQuery(tenantOrganizationQuery(tenantId))
  const days = rangeOf(Route.useSearch())
  const navigate = Route.useNavigate()
  const { data: stats } = useSuspenseQuery(tenantDashboardQuery(tenantId, days))
  const params = { tenantId }
  const links: TenantDashboardLinks = {
    exchanges: { to: '/ops/tenants/$tenantId/exchanges', params },
    wallets: { to: '/ops/tenants/$tenantId/wallets', params },
    webhooks: { to: '/ops/tenants/$tenantId/webhooks', params },
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <RangeTabs value={days} onChange={(next) => navigate({ search: { days: next }, replace: true })} />
      </div>
      <TenantDashboardBody stats={stats} links={links} />
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
            <OrganizationMembers tenantId={tenantId} />
          ) : (
            <p className="text-sm text-muted-foreground">No organization yet. Create one with its first owner; the owner invites the rest of the team from the portal.</p>
          )}
        </CardContent>
      </Card>
    </div>
    </div>
  )
}

/** The organization's members, paged on the server; page 1 comes from the route loader. */
function OrganizationMembers({ tenantId }: { tenantId: string }) {
  const [paging, setPaging] = useState<{ page?: number; pageSize?: PageSize }>({})
  const { data, isFetching } = useQuery(tenantOrganizationQuery(tenantId, paging))
  const members = data?.members
  if (!members) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <DataTable
      columns={memberColumns}
      data={members.items}
      paging={pagingFor(members, (next) => setPaging((current) => ({ page: next.page, pageSize: 'pageSize' in next ? next.pageSize : current.pageSize })))}
      fetching={isFetching}
      emptyMessage="No members."
      testId="members-table"
    />
  )
}
