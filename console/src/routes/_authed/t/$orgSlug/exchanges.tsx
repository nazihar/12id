import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { ConnectionInvitationDialog } from '@/features/portal/connection-invitation-dialog'
import { portalConnectionsQuery, portalCredentialsQuery, portalProofsQuery } from '@/features/portal/portal.queries'
import { ExchangeTables } from '@/features/tenant-data/panels'
import { tenantCan } from '@/lib/permissions'

export const Route = createFileRoute('/_authed/t/$orgSlug/exchanges')({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(portalConnectionsQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(portalCredentialsQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(portalProofsQuery(params.orgSlug)),
    ]),
  errorComponent: RouteError,
  component: PortalExchangesPage,
})

function PortalExchangesPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data: connections } = useSuspenseQuery(portalConnectionsQuery(orgSlug))
  const { data: credentials } = useSuspenseQuery(portalCredentialsQuery(orgSlug))
  const { data: proofs } = useSuspenseQuery(portalProofsQuery(orgSlug))
  return (
    <div className="space-y-6">
      <PageHeader
        title="Exchanges"
        description="The latest 200 connections, credential exchanges and proof exchanges, newest first. Credential attribute values are not shown."
        actions={tenantCan(organization.role, { exchange: ['create'] }) && <ConnectionInvitationDialog organizationId={organization.id} orgSlug={orgSlug} />}
      />
      <ExchangeTables connections={connections} credentials={credentials} proofs={proofs} />
    </div>
  )
}
