import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { RouteError } from '@/components/route-error'
import { ExchangeTables } from '@/features/tenant-data/panels'
import { connectionsQuery, credentialsQuery, proofsQuery } from '@/features/tenant-data/tenant-data.queries'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/exchanges')({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(connectionsQuery(params.tenantId)),
      context.queryClient.ensureQueryData(credentialsQuery(params.tenantId)),
      context.queryClient.ensureQueryData(proofsQuery(params.tenantId)),
    ]),
  errorComponent: RouteError,
  component: ExchangesPage,
})

function ExchangesPage() {
  const { tenantId } = Route.useParams()
  const { data: connections } = useSuspenseQuery(connectionsQuery(tenantId))
  const { data: credentials } = useSuspenseQuery(credentialsQuery(tenantId))
  const { data: proofs } = useSuspenseQuery(proofsQuery(tenantId))
  return <ExchangeTables connections={connections} credentials={credentials} proofs={proofs} />
}
