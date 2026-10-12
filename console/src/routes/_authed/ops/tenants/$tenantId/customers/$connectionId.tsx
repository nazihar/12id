import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'

import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { StateWithErasure } from '@/features/tenant-data/data-protection'
import type { Eraser } from '@/features/tenant-data/data-protection'
import { eraseTenantRecord, getBiometricLog } from '@/features/tenant-data/tenant-data.functions'
import { CustomerBody, customerTitle } from '@/features/verification/customer-body'
import { tenantCustomerQuery, tenantCustomerRecordsQuery } from '@/features/verification/verification.queries'
import { type CustomerSearch, customerSearch } from '@/features/verification/verification.schemas'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { useCanOperate } from '@/lib/use-can-operate'

// The tenant's customer page (implement/22 C11) for an operator or auditor: the holder label is masked,
// and an operator erases only on the organisation's request, with a reason.
export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/customers/$connectionId')({
  validateSearch: parseListSearch(customerSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(tenantCustomerQuery(params.tenantId, params.connectionId)),
      context.queryClient.ensureQueryData(tenantCustomerRecordsQuery(params.tenantId, params.connectionId, deps)),
    ]),
  errorComponent: RouteError,
  component: TenantCustomerPage,
})

function TenantCustomerPage() {
  const { tenantId, connectionId } = Route.useParams()
  const search = Route.useSearch()
  const onSearch = searchPatcher<CustomerSearch>(Route.useNavigate())
  const { data: activity } = useSuspenseQuery(tenantCustomerQuery(tenantId, connectionId))
  const { data: records } = useSuspenseQuery(tenantCustomerRecordsQuery(tenantId, connectionId, search))
  const canOperate = useCanOperate()
  const eraser = useMemo<Eraser | undefined>(
    () => (canOperate ? { erase: (kind, id, reason) => eraseTenantRecord({ data: { tenantId, kind, id, reason: reason ?? '' } }), reasonRequired: true, invalidateKey: ['ops', 'tenant', tenantId] } : undefined),
    [tenantId, canOperate]
  )
  const { connection } = activity

  return (
    <div className="space-y-4">
      <PageHeader
        level={2}
        title={customerTitle(connection)}
        badge={<StateWithErasure state={connection.state} erasedAt={connection.erasedAt} />}
        description={
          <>
            Everything on this connection. Personal data is masked.{' '}
            <Link to="/ops/tenants/$tenantId/exchanges" params={{ tenantId }} className="underline">
              All connections
            </Link>
          </>
        }
        meta={<p className="font-mono text-xs text-muted-foreground">connection {connection.id}</p>}
      />
      <CustomerBody activity={activity} records={records} search={search} onSearch={onSearch} fetching={useListPending()} loadBiometricLog={(kind, id) => getBiometricLog({ data: { tenantId, kind, id } })} eraser={eraser} />
    </div>
  )
}
