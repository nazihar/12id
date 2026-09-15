import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

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
  return <WalletsTable wallets={data} />
}
