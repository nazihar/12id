import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { WalletsTable } from '@/features/tenant-data/panels'
import { walletsQuery } from '@/features/tenant-data/tenant-data.queries'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/wallets')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(walletsQuery(params.tenantId)),
  errorComponent: RouteError,
  component: WalletsPage,
})

function WalletsPage() {
  const { tenantId } = Route.useParams()
  const { data } = useSuspenseQuery(walletsQuery(tenantId))
  return (
    <section className="space-y-4">
      <PageHeader title="Wallets" description="One wallet per app installation, created by the tenant's backend." />
      <WalletsTable wallets={data} />
    </section>
  )
}
