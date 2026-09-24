import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { RouteError } from '@/components/route-error'
import { type ApiKeySearch, apiKeySearch } from '@/features/tenant-data/list.schemas'
import { createPortalApiKey, revokePortalApiKey } from '@/features/portal/portal-data.functions'
import { portalApiKeysQuery, portalKey } from '@/features/portal/portal.queries'
import { ApiKeysPanel } from '@/features/tenant-data/panels'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { tenantCan } from '@/lib/permissions'

export const Route = createFileRoute('/_authed/t/$orgSlug/api-keys')({
  validateSearch: parseListSearch(apiKeySearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(portalApiKeysQuery(params.orgSlug, deps)),
  errorComponent: RouteError,
  component: PortalApiKeysPage,
})

function PortalApiKeysPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const search = Route.useSearch()
  const onSearch = searchPatcher<ApiKeySearch>(Route.useNavigate())
  const fetching = useListPending()
  const { data: keys } = useSuspenseQuery(portalApiKeysQuery(orgSlug, search))
  const organizationId = organization.id
  return (
    <ApiKeysPanel
      data={keys}
      search={search}
      onSearch={onSearch}
      fetching={fetching}
      invalidateKey={portalKey(orgSlug, 'api-keys')}
      createKey={tenantCan(organization.role, { apiKey: ['create'] }) ? (label) => createPortalApiKey({ data: { organizationId, label } }) : undefined}
      revokeKey={tenantCan(organization.role, { apiKey: ['revoke'] }) ? (apiKeyId) => revokePortalApiKey({ data: { organizationId, apiKeyId } }) : undefined}
    />
  )
}
