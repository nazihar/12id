import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { AuditRetentionCard, ErasureLog, RetentionCard } from '@/features/tenant-data/data-protection'
import { setTenantAuditRetention, setTenantRetention } from '@/features/tenant-data/tenant-data.functions'
import { tenantAuditRetentionQuery, tenantErasuresQuery, tenantRetentionQuery } from '@/features/tenant-data/tenant-data.queries'
import { useCanOperate } from '@/lib/use-can-operate'
import { OpsPendingChanges } from '@/features/approvals/pending-changes'

const pageOf = (search: Record<string, unknown>) => {
  const page = Math.floor(Number(search.page))
  return { page: page > 1 ? page : undefined }
}

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/data-protection')({
  validateSearch: pageOf,
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(tenantRetentionQuery(params.tenantId)),
      context.queryClient.ensureQueryData(tenantAuditRetentionQuery(params.tenantId)),
      context.queryClient.ensureQueryData(tenantErasuresQuery(params.tenantId, deps.page)),
    ]),
  errorComponent: RouteError,
  component: DataProtectionPage,
})

function DataProtectionPage() {
  const { tenantId } = Route.useParams()
  const { page } = Route.useSearch()
  const navigate = Route.useNavigate()
  const canOperate = useCanOperate()
  const { data: retention } = useSuspenseQuery(tenantRetentionQuery(tenantId))
  const { data: auditRetention } = useSuspenseQuery(tenantAuditRetentionQuery(tenantId))
  const { data: erasures } = useSuspenseQuery(tenantErasuresQuery(tenantId, page))
  return (
    <div className="space-y-6">
      <PageHeader
        title="Data protection"
        description="The tenant's retention period, its audit log period and its erasure log. Change a period or erase data only when the organisation asks; erasures from Exchanges need a reason and are audited."
      />
      <OpsPendingChanges tenantId={tenantId} types={['retention.']} />
      <RetentionCard retention={retention} invalidateKey={['ops', 'tenant', tenantId, 'data-protection']} save={canOperate ? (retentionDays) => setTenantRetention({ data: { tenantId, retentionDays } }) : undefined} />
      <AuditRetentionCard
        retention={auditRetention}
        invalidateKey={['ops', 'tenant', tenantId, 'data-protection']}
        save={canOperate ? (auditRetentionDays) => setTenantAuditRetention({ data: { tenantId, auditRetentionDays } }) : undefined}
      />
      <ErasureLog data={erasures} onPage={(next) => void navigate({ search: { page: next > 1 ? next : undefined } })} />
    </div>
  )
}
