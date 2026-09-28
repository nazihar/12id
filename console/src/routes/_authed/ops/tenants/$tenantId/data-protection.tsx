import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { ErasureLog, RetentionCard } from '@/features/tenant-data/data-protection'
import { setTenantRetention } from '@/features/tenant-data/tenant-data.functions'
import { tenantErasuresQuery, tenantRetentionQuery } from '@/features/tenant-data/tenant-data.queries'

const pageOf = (search: Record<string, unknown>) => {
  const page = Math.floor(Number(search.page))
  return { page: page > 1 ? page : undefined }
}

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/data-protection')({
  validateSearch: pageOf,
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([context.queryClient.ensureQueryData(tenantRetentionQuery(params.tenantId)), context.queryClient.ensureQueryData(tenantErasuresQuery(params.tenantId, deps.page))]),
  errorComponent: RouteError,
  component: DataProtectionPage,
})

function DataProtectionPage() {
  const { tenantId } = Route.useParams()
  const { page } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data: retention } = useSuspenseQuery(tenantRetentionQuery(tenantId))
  const { data: erasures } = useSuspenseQuery(tenantErasuresQuery(tenantId, page))
  return (
    <div className="space-y-6">
      <PageHeader
        title="Data protection"
        description="The tenant's retention period and its erasure log. Change the period or erase data only when the organisation asks; erasures from Exchanges need a reason and are audited."
      />
      <RetentionCard retention={retention} invalidateKey={['ops', 'tenant', tenantId, 'data-protection']} save={(retentionDays) => setTenantRetention({ data: { tenantId, retentionDays } })} />
      <ErasureLog data={erasures} onPage={(next) => void navigate({ search: { page: next > 1 ? next : undefined } })} />
    </div>
  )
}
