import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { RouteError } from '@/components/route-error'
import { createPortalApiKey, revokePortalApiKey } from '@/features/portal/portal-data.functions'
import { portalApiKeysQuery, portalKey } from '@/features/portal/portal.queries'
import { ApiKeysPanel } from '@/features/tenant-data/panels'
import { tenantCan } from '@/lib/permissions'

export const Route = createFileRoute('/_authed/t/$orgSlug/api-keys')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(portalApiKeysQuery(params.orgSlug)),
  errorComponent: RouteError,
  component: PortalApiKeysPage,
})

function PortalApiKeysPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data: keys } = useSuspenseQuery(portalApiKeysQuery(orgSlug))
  const organizationId = organization.id
  return (
    <ApiKeysPanel
      keys={keys}
      invalidateKey={portalKey(orgSlug, 'api-keys')}
      createKey={tenantCan(organization.role, { apiKey: ['create'] }) ? (label) => createPortalApiKey({ data: { organizationId, label } }) : undefined}
      revokeKey={tenantCan(organization.role, { apiKey: ['revoke'] }) ? (apiKeyId) => revokePortalApiKey({ data: { organizationId, apiKeyId } }) : undefined}
    />
  )
}
