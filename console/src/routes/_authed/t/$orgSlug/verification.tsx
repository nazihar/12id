import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { RangeTabs } from '@/components/dashboard/range-tabs'
import { useListPending } from '@/components/data-table/use-list-pending'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { rangeOf } from '@/features/dashboard/dashboard.schemas'
import { exportPortalList } from '@/features/export/export.functions'
import { getPortalBiometricLog } from '@/features/portal/portal-data.functions'
import { VerificationBody } from '@/features/verification/verification-body'
import { portalChecksQuery, portalVerificationQuery } from '@/features/verification/verification.queries'
import { type CheckSearch, type VerificationSearch, verificationSearch } from '@/features/verification/verification.schemas'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { canDo } from '@/lib/permissions'

/** The checks list reads everything in the search except the window and the tab. */
const listOf = ({ tab: _tab, days: _days, ...list }: VerificationSearch): CheckSearch => list

// Verification (implement/22 C10): proof outcomes and face checks for this organization. The
// aggregates come through the loader; the checks list loads only while its tab is open.
export const Route = createFileRoute('/_authed/t/$orgSlug/verification')({
  validateSearch: parseListSearch(verificationSearch),
  loaderDeps: ({ search }): VerificationSearch => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(portalVerificationQuery(params.orgSlug, rangeOf(deps))),
      deps.tab === 'checks' ? context.queryClient.ensureQueryData(portalChecksQuery(params.orgSlug, listOf(deps))) : null,
    ]),
  errorComponent: RouteError,
  component: PortalVerificationPage,
})

function PortalVerificationPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = searchPatcher<VerificationSearch>(navigate)
  const days = rangeOf(search)
  const { data: stats } = useSuspenseQuery(portalVerificationQuery(orgSlug, days))
  const checks = useQuery({ ...portalChecksQuery(orgSlug, listOf(search)), enabled: search.tab === 'checks' })
  const params = { orgSlug }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Verification"
        description="How proof requests ended and how face checks went. A request or a check counts on the day it started; an attempt on the day it was made."
        actions={<RangeTabs value={days} onChange={(next) => onSearch({ days: next === 30 ? undefined : next, page: search.page })} />}
      />
      <VerificationBody
        stats={stats}
        checks={search.tab === 'checks' ? checks.data : undefined}
        search={search}
        onSearch={onSearch}
        fetching={useListPending() || checks.isFetching}
        loadBiometricLog={(kind, id) => getPortalBiometricLog({ data: { kind, id } })}
        onOpenCustomer={(connectionId) => void navigate({ to: '/t/$orgSlug/customers/$connectionId', params: { orgSlug, connectionId } })}
        biometricsLink={{ to: '/t/$orgSlug/biometrics', params }}
        onExportChecks={canDo(organization.permissions, { export: ['run'] }) ? (format) => exportPortalList({ data: { list: 'checks', format, search: listOf(search) } }) : undefined}
      />
    </div>
  )
}
