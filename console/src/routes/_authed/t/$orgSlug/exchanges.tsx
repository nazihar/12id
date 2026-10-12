import { useSuspenseQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { exportPortalList } from '@/features/export/export.functions'
import { ConnectionInvitationDialog } from '@/features/portal/connection-invitation-dialog'
import { portalExchangesQuery, portalKey } from '@/features/portal/portal.queries'
import { erasePortalRecord, getPortalBiometricLog } from '@/features/portal/portal-data.functions'
import type { Eraser } from '@/features/tenant-data/data-protection'
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
  const navigate = Route.useNavigate()
  const onSearch = searchPatcher<ExchangeSearch>(navigate)
  const openCustomer = useCallback((connectionId: string) => void navigate({ to: '/t/$orgSlug/customers/$connectionId', params: { orgSlug, connectionId } }), [navigate, orgSlug])
  const { data } = useSuspenseQuery(portalExchangesQuery(orgSlug, search))
  const canErase = tenantCan(organization.role, { exchange: ['erase'] })
  const eraser = useMemo<Eraser | undefined>(
    () => (canErase ? { erase: (kind, id, reason) => erasePortalRecord({ data: { organizationId: organization.id, kind, id, reason } }), reasonRequired: false, invalidateKey: portalKey(orgSlug) } : undefined),
    [canErase, organization.id, orgSlug]
  )
  return (
    <div className="space-y-6">
      <PageHeader
        title="Exchanges"
        description="Connections, credential exchanges and proof exchanges, newest first. Search by your external id, filter by state and creation date; a row leads to everything on its connection. Credential attribute values are not shown. Erase removes a finished exchange's personal data, or a person's whole connection."
        actions={tenantCan(organization.role, { exchange: ['create'] }) && <ConnectionInvitationDialog organizationId={organization.id} orgSlug={orgSlug} />}
      />
      <ExchangeLists data={data} search={search} onSearch={onSearch} fetching={useListPending()} loadBiometricLog={(kind, id) => getPortalBiometricLog({ data: { kind, id } })} eraser={eraser}
        onOpenCustomer={openCustomer}
        onExport={tenantCan(organization.role, { export: ['run'] }) ? (list, format) => exportPortalList({ data: { list, format, search } }) : undefined}
      />
    </div>
  )
}
