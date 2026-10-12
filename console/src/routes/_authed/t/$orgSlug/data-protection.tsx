import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { setPortalAuditRetention, setPortalRetention } from '@/features/portal/portal-data.functions'
import { portalAuditRetentionQuery, portalErasuresQuery, portalKey, portalRetentionQuery } from '@/features/portal/portal.queries'
import { AuditRetentionCard, ErasureLog, RetentionCard } from '@/features/tenant-data/data-protection'
import { tenantCan } from '@/lib/permissions'

const pageOf = (search: Record<string, unknown>) => {
  const page = Math.floor(Number(search.page))
  return { page: page > 1 ? page : undefined }
}

export const Route = createFileRoute('/_authed/t/$orgSlug/data-protection')({
  validateSearch: pageOf,
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(portalRetentionQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(portalAuditRetentionQuery(params.orgSlug)),
      context.queryClient.ensureQueryData(portalErasuresQuery(params.orgSlug, deps.page)),
    ]),
  errorComponent: RouteError,
  component: PortalDataProtectionPage,
})

function PortalDataProtectionPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { page } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { data: retention } = useSuspenseQuery(portalRetentionQuery(orgSlug))
  const { data: auditRetention } = useSuspenseQuery(portalAuditRetentionQuery(orgSlug))
  const { data: erasures } = useSuspenseQuery(portalErasuresQuery(orgSlug, page))
  const canEdit = tenantCan(organization.role, { retention: ['update'] })
  return (
    <div className="space-y-6">
      <PageHeader
        title="Data protection"
        description="How long 12iD keeps your users' personal data and the audit log, and every erasure made on request. To erase one person's data, use Erase on the connection or exchange in Exchanges, or the erase endpoints of the API."
      />
      <RetentionCard
        retention={retention}
        invalidateKey={portalKey(orgSlug, 'data-protection')}
        save={canEdit ? (retentionDays) => setPortalRetention({ data: { organizationId: organization.id, retentionDays } }) : undefined}
      />
      <AuditRetentionCard
        retention={auditRetention}
        invalidateKey={portalKey(orgSlug, 'data-protection')}
        save={canEdit ? (auditRetentionDays) => setPortalAuditRetention({ data: { organizationId: organization.id, auditRetentionDays } }) : undefined}
      />
      <ErasureLog data={erasures} onPage={(next) => void navigate({ search: { page: next > 1 ? next : undefined } })} />
    </div>
  )
}
