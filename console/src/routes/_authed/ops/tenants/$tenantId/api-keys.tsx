import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { RouteError } from '@/components/route-error'
import { type ApiKeySearch, apiKeySearch } from '@/features/tenant-data/list.schemas'
import { ApiKeysPanel } from '@/features/tenant-data/panels'
import { RateLimitCard } from '@/features/tenants/rate-limit-card'
import { createApiKey, revokeApiKey } from '@/features/tenants/tenants.functions'
import { tenantApiKeysQuery, tenantQuery } from '@/features/tenants/tenants.queries'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { useCanOperate } from '@/lib/use-can-operate'
import { OpsPendingChanges } from '@/features/approvals/pending-changes'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/api-keys')({
  validateSearch: parseListSearch(apiKeySearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(tenantApiKeysQuery(params.tenantId, deps)),
  errorComponent: RouteError,
  component: ApiKeysPage,
})

function ApiKeysPage() {
  const { tenantId } = Route.useParams()
  const search = Route.useSearch()
  const onSearch = searchPatcher<ApiKeySearch>(Route.useNavigate())
  const fetching = useListPending()
  const canOperate = useCanOperate()
  const { data: keys } = useSuspenseQuery(tenantApiKeysQuery(tenantId, search))
  const { data: tenant } = useSuspenseQuery(tenantQuery(tenantId))
  return (
    <div className="space-y-5">
      <RateLimitCard tenantId={tenantId} rateLimitPerMin={tenant.rateLimitPerMin} />
      <OpsPendingChanges tenantId={tenantId} types={['api_key.']} />
      <ApiKeysPanel
        data={keys}
        search={search}
        onSearch={onSearch}
        fetching={fetching}
        invalidateKey={['ops', 'tenant', tenantId, 'api-keys']}
        createKey={canOperate ? (label) => createApiKey({ data: { tenantId, label } }) : undefined}
        revokeKey={canOperate ? (apiKeyId) => revokeApiKey({ data: { tenantId, apiKeyId } }) : undefined}
      />
    </div>
  )
}
