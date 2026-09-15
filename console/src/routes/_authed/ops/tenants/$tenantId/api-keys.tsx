import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { RouteError } from '@/components/route-error'
import { ApiKeysPanel } from '@/features/tenant-data/panels'
import { createApiKey, revokeApiKey } from '@/features/tenants/tenants.functions'
import { tenantApiKeysQuery } from '@/features/tenants/tenants.queries'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/api-keys')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(tenantApiKeysQuery(params.tenantId)),
  errorComponent: RouteError,
  component: ApiKeysPage,
})

function ApiKeysPage() {
  const { tenantId } = Route.useParams()
  const { data: keys } = useSuspenseQuery(tenantApiKeysQuery(tenantId))
  return (
    <ApiKeysPanel
      keys={keys}
      invalidateKey={['ops', 'tenant', tenantId, 'api-keys']}
      createKey={(label) => createApiKey({ data: { tenantId, label } })}
      revokeKey={(apiKeyId) => revokeApiKey({ data: { tenantId, apiKeyId } })}
    />
  )
}
