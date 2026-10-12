import { useSuspenseQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { exportTenantList } from '@/features/export/export.functions'
import { type ExchangeSearch, exchangeSearch } from '@/features/tenant-data/list.schemas'
import { ExchangeLists } from '@/features/tenant-data/panels'
import type { Eraser } from '@/features/tenant-data/data-protection'
import { eraseTenantRecord, getBiometricLog } from '@/features/tenant-data/tenant-data.functions'
import { exchangesQuery } from '@/features/tenant-data/tenant-data.queries'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { useCanOperate } from '@/lib/use-can-operate'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/exchanges')({
  validateSearch: parseListSearch(exchangeSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(exchangesQuery(params.tenantId, deps)),
  errorComponent: RouteError,
  component: ExchangesPage,
})

function ExchangesPage() {
  const { tenantId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = searchPatcher<ExchangeSearch>(navigate)
  const openCustomer = useCallback((connectionId: string) => void navigate({ to: '/ops/tenants/$tenantId/customers/$connectionId', params: { tenantId, connectionId } }), [navigate, tenantId])
  const { data } = useSuspenseQuery(exchangesQuery(tenantId, search))
  // Operators erase only on the organisation's request, and must say which (Phase 7 H1).
  const canOperate = useCanOperate()
  const eraser = useMemo<Eraser | undefined>(
    () => (canOperate ? { erase: (kind, id, reason) => eraseTenantRecord({ data: { tenantId, kind, id, reason: reason ?? '' } }), reasonRequired: true, invalidateKey: ['ops', 'tenant', tenantId] } : undefined),
    [tenantId, canOperate]
  )
  return (
    <div className="space-y-6">
      <PageHeader title="Exchanges" description="Newest first. Search by external id, filter by state and creation date. Personal data is masked for operators. Erase only when the organisation asks; it needs a reason and is audited." />
      <ExchangeLists data={data} search={search} onSearch={onSearch} fetching={useListPending()} loadBiometricLog={(kind, id) => getBiometricLog({ data: { tenantId, kind, id } })} eraser={eraser}
        onOpenCustomer={openCustomer}
        onExport={(list, format) => exportTenantList({ data: { tenantId, list, format, search } })}
      />
    </div>
  )
}
