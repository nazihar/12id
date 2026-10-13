import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { RouteError } from '@/components/route-error'
import { ApprovalsBody } from '@/features/approvals/approvals-body'
import { applyPortalChange, cancelPortalChange, decidePortalChange, setPortalApprovals } from '@/features/approvals/approvals.functions'
import { portalApprovalsKey, portalApprovalsQuery, portalChangeRequestsQuery } from '@/features/approvals/approvals.queries'
import { type ApprovalSearch, approvalSearch } from '@/features/approvals/approvals.schemas'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { tenantCan } from '@/lib/permissions'

// Approval by a second person (implement/22-console-feedback.md C19), for an organization: the
// switch, what waits and what was decided. Members read; owners and admins decide.
export const Route = createFileRoute('/_authed/t/$orgSlug/approvals')({
  validateSearch: parseListSearch(approvalSearch),
  loaderDeps: ({ search }): ApprovalSearch => search,
  loader: ({ context, params, deps }) =>
    Promise.all([context.queryClient.ensureQueryData(portalApprovalsQuery(params.orgSlug)), context.queryClient.ensureQueryData(portalChangeRequestsQuery(params.orgSlug, deps))]),
  errorComponent: RouteError,
  component: PortalApprovalsPage,
})

function PortalApprovalsPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const search = Route.useSearch()
  const onSearch = searchPatcher<ApprovalSearch>(Route.useNavigate())
  const fetching = useListPending()
  const { data: overview } = useSuspenseQuery(portalApprovalsQuery(orgSlug))
  const { data } = useSuspenseQuery(portalChangeRequestsQuery(orgSlug, search))
  const organizationId = organization.id
  const canDecide = tenantCan(organization.role, { approval: ['decide'] })
  // A member can ask for nothing that is held, so has nothing of their own to cancel or apply.
  const canAsk = organization.role !== 'member'

  return (
    <ApprovalsBody
      scope="organization"
      overview={overview}
      data={data}
      search={search}
      onSearch={onSearch}
      fetching={fetching}
      invalidateKey={portalApprovalsKey(orgSlug)}
      actions={{
        setRequired: tenantCan(organization.role, { approval: ['configure'] }) ? (required) => setPortalApprovals({ data: { organizationId, required } }) : undefined,
        decide: canDecide ? (id, action, reason) => decidePortalChange({ data: { organizationId, id, action, reason } }) : undefined,
        cancel: canAsk ? (id) => cancelPortalChange({ data: { organizationId, id } }) : undefined,
        apply: canAsk ? (id) => applyPortalChange({ data: { organizationId, id } }) : undefined,
      }}
    />
  )
}
