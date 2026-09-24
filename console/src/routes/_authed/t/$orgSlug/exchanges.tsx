import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { ConnectionInvitationDialog } from '@/features/portal/connection-invitation-dialog'
import { portalExchangesQuery } from '@/features/portal/portal.queries'
import { getPortalBiometricLog } from '@/features/portal/portal-data.functions'
import { type ExchangeSearch, exchangeSearch } from '@/features/tenant-data/list.schemas'
import { ExchangeLists } from '@/features/tenant-data/panels'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { tenantCan } from '@/lib/permissions'

export const Route = createFileRoute('/_authed/t/$orgSlug/exchanges')({
  validateSearch: parseListSearch(exchangeSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(portalExchangesQuery(params.orgSlug, deps)),
  errorComponent: RouteError,
  component: PortalExchangesPage,
})

function PortalExchangesPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const search = Route.useSearch()
  const onSearch = searchPatcher<ExchangeSearch>(Route.useNavigate())
  const { data } = useSuspenseQuery(portalExchangesQuery(orgSlug, search))
  return (
    <div className="space-y-6">
      <PageHeader
        title="Exchanges"
        description="Connections, credential exchanges and proof exchanges, newest first. Search by your external id, filter by state and creation date. Credential attribute values are not shown."
        actions={tenantCan(organization.role, { exchange: ['create'] }) && <ConnectionInvitationDialog organizationId={organization.id} orgSlug={orgSlug} />}
      />
      <ExchangeLists data={data} search={search} onSearch={onSearch} fetching={useListPending()} loadBiometricLog={(kind, id) => getPortalBiometricLog({ data: { kind, id } })} />
    </div>
  )
}
