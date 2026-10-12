import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'

import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { StateWithErasure } from '@/features/tenant-data/data-protection'
import type { Eraser } from '@/features/tenant-data/data-protection'
import { erasePortalRecord, getPortalBiometricLog } from '@/features/portal/portal-data.functions'
import { portalKey } from '@/features/portal/portal.queries'
import { CustomerBody, customerTitle } from '@/features/verification/customer-body'
import { portalCustomerQuery, portalCustomerRecordsQuery } from '@/features/verification/verification.queries'
import { type CustomerSearch, customerSearch } from '@/features/verification/verification.schemas'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { tenantCan } from '@/lib/permissions'

// One customer (implement/22 C11): a connection with its credential exchanges, proof exchanges and face checks.
export const Route = createFileRoute('/_authed/t/$orgSlug/customers/$connectionId')({
  validateSearch: parseListSearch(customerSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(portalCustomerQuery(params.orgSlug, params.connectionId)),
      context.queryClient.ensureQueryData(portalCustomerRecordsQuery(params.orgSlug, params.connectionId, deps)),
    ]),
  errorComponent: RouteError,
  component: PortalCustomerPage,
})

function PortalCustomerPage() {
  const { orgSlug, connectionId } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const search = Route.useSearch()
  const onSearch = searchPatcher<CustomerSearch>(Route.useNavigate())
  const { data: activity } = useSuspenseQuery(portalCustomerQuery(orgSlug, connectionId))
  const { data: records } = useSuspenseQuery(portalCustomerRecordsQuery(orgSlug, connectionId, search))
  const canErase = tenantCan(organization.role, { exchange: ['erase'] })
  const eraser = useMemo<Eraser | undefined>(
    () => (canErase ? { erase: (kind, id, reason) => erasePortalRecord({ data: { organizationId: organization.id, kind, id, reason } }), reasonRequired: false, invalidateKey: portalKey(orgSlug) } : undefined),
    [canErase, organization.id, orgSlug]
  )
  const { connection } = activity

  return (
    <div className="space-y-4">
      <PageHeader
        title={customerTitle(connection)}
        badge={<StateWithErasure state={connection.state} erasedAt={connection.erasedAt} />}
        description={
          <>
            Everything on this connection.{' '}
            <Link to="/t/$orgSlug/exchanges" params={{ orgSlug }} className="underline">
              All connections
            </Link>
          </>
        }
        meta={
          <p className="font-mono text-xs text-muted-foreground">
            connection {connection.id}
            {connection.externalId && connection.theirLabel ? ` · ${connection.theirLabel}` : ''}
          </p>
        }
      />
      <CustomerBody activity={activity} records={records} search={search} onSearch={onSearch} fetching={useListPending()} loadBiometricLog={(kind, id) => getPortalBiometricLog({ data: { kind, id } })} eraser={eraser} />
    </div>
  )
}
