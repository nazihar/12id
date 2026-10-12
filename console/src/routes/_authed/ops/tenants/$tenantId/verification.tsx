import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { RangeTabs } from '@/components/dashboard/range-tabs'
import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { rangeOf } from '@/features/dashboard/dashboard.schemas'
import { exportTenantList } from '@/features/export/export.functions'
import { getBiometricLog } from '@/features/tenant-data/tenant-data.functions'
import { VerificationBody } from '@/features/verification/verification-body'
import { tenantChecksQuery, tenantVerificationQuery } from '@/features/verification/verification.queries'
import { type CheckSearch, type VerificationSearch, verificationSearch } from '@/features/verification/verification.schemas'
import { parseListSearch, searchPatcher } from '@/lib/list-search'

/** The checks list reads everything in the search except the window and the tab. */
const listOf = ({ tab: _tab, days: _days, ...list }: VerificationSearch): CheckSearch => list

// The same Verification page the tenant sees in its portal (implement/22 C10), for an operator or auditor.
export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/verification')({
  validateSearch: parseListSearch(verificationSearch),
  loaderDeps: ({ search }): VerificationSearch => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(tenantVerificationQuery(params.tenantId, rangeOf(deps))),
      deps.tab === 'checks' ? context.queryClient.ensureQueryData(tenantChecksQuery(params.tenantId, listOf(deps))) : null,
    ]),
  errorComponent: RouteError,
  component: TenantVerificationPage,
})

function TenantVerificationPage() {
  const { tenantId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = searchPatcher<VerificationSearch>(navigate)
  const days = rangeOf(search)
  const { data: stats } = useSuspenseQuery(tenantVerificationQuery(tenantId, days))
  const checks = useQuery({ ...tenantChecksQuery(tenantId, listOf(search)), enabled: search.tab === 'checks' })
  const params = { tenantId }

  return (
    <div className="space-y-4">
      <PageHeader
        level={2}
        title="Verification"
        description="How this tenant's proof requests ended and how its face checks went. Opening a check's log is audited."
        actions={<RangeTabs value={days} onChange={(next) => onSearch({ days: next === 30 ? undefined : next, page: search.page })} />}
      />
      <VerificationBody
        stats={stats}
        checks={search.tab === 'checks' ? checks.data : undefined}
        search={search}
        onSearch={onSearch}
        fetching={useListPending() || checks.isFetching}
        loadBiometricLog={(kind, id) => getBiometricLog({ data: { tenantId, kind, id } })}
        onOpenCustomer={(connectionId) => void navigate({ to: '/ops/tenants/$tenantId/customers/$connectionId', params: { tenantId, connectionId } })}
        biometricsLink={{ to: '/ops/tenants/$tenantId/biometrics', params }}
        onExportChecks={(format) => exportTenantList({ data: { tenantId, list: 'checks', format, search: listOf(search) } })}
      />
    </div>
  )
}
