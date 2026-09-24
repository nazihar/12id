import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { type ExchangeSearch, exchangeSearch } from '@/features/tenant-data/list.schemas'
import { ExchangeLists } from '@/features/tenant-data/panels'
import { getBiometricLog } from '@/features/tenant-data/tenant-data.functions'
import { exchangesQuery } from '@/features/tenant-data/tenant-data.queries'
import { parseListSearch, searchPatcher } from '@/lib/list-search'

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
  const onSearch = searchPatcher<ExchangeSearch>(Route.useNavigate())
  const { data } = useSuspenseQuery(exchangesQuery(tenantId, search))
  return (
    <div className="space-y-6">
      <PageHeader title="Exchanges" description="Newest first. Search by external id, filter by state and creation date. Credential attribute values are not shown." />
      <ExchangeLists data={data} search={search} onSearch={onSearch} fetching={useListPending()} loadBiometricLog={(kind, id) => getBiometricLog({ data: { tenantId, kind, id } })} />
    </div>
  )
}
