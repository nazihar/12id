import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { exportTenantList } from '@/features/export/export.functions'
import { type WalletSearch, walletSearch } from '@/features/tenant-data/list.schemas'
import { WalletsTable } from '@/features/tenant-data/panels'
import { walletsQuery } from '@/features/tenant-data/tenant-data.queries'
import { parseListSearch, searchPatcher } from '@/lib/list-search'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/wallets')({
  validateSearch: parseListSearch(walletSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(walletsQuery(params.tenantId, deps)),
  errorComponent: RouteError,
  component: WalletsPage,
})

function WalletsPage() {
  const { tenantId } = Route.useParams()
  const search = Route.useSearch()
  const onSearch = searchPatcher<WalletSearch>(Route.useNavigate())
  const { data } = useSuspenseQuery(walletsQuery(tenantId, search))
  return (
    <section className="space-y-4">
      <PageHeader title="Wallets" description="One wallet per app installation, created by the tenant's backend." />
      <WalletsTable data={data} search={search} onSearch={onSearch} fetching={useListPending()} onExport={(format) => exportTenantList({ data: { tenantId, list: 'wallets', format, search } })} />
    </section>
  )
}
