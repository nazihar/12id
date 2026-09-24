import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { portalWalletsQuery } from '@/features/portal/portal.queries'
import { type WalletSearch, walletSearch } from '@/features/tenant-data/list.schemas'
import { WalletsTable } from '@/features/tenant-data/panels'
import { parseListSearch, searchPatcher } from '@/lib/list-search'

export const Route = createFileRoute('/_authed/t/$orgSlug/wallets')({
  validateSearch: parseListSearch(walletSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(portalWalletsQuery(params.orgSlug, deps)),
  errorComponent: RouteError,
  component: PortalWalletsPage,
})

function PortalWalletsPage() {
  const { orgSlug } = Route.useParams()
  const search = Route.useSearch()
  const onSearch = searchPatcher<WalletSearch>(Route.useNavigate())
  const { data } = useSuspenseQuery(portalWalletsQuery(orgSlug, search))
  return (
    <section className="space-y-4">
      <PageHeader title="Wallets" description="One wallet per app installation, created by your backend. The platform does not know who the user is; the external id is yours." />
      <WalletsTable data={data} search={search} onSearch={onSearch} fetching={useListPending()} />
    </section>
  )
}
