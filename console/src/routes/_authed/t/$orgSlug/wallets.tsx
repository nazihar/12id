import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { RouteError } from '@/components/route-error'
import { portalWalletsQuery } from '@/features/portal/portal.queries'
import { WalletsTable } from '@/features/tenant-data/panels'

export const Route = createFileRoute('/_authed/t/$orgSlug/wallets')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(portalWalletsQuery(params.orgSlug)),
  errorComponent: RouteError,
  component: PortalWalletsPage,
})

function PortalWalletsPage() {
  const { orgSlug } = Route.useParams()
  const { data } = useSuspenseQuery(portalWalletsQuery(orgSlug))
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">One wallet per app installation, created by your backend. The platform does not know who the user is; the external id is yours.</p>
      <WalletsTable wallets={data} />
    </div>
  )
}
