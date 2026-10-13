import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { RouteError } from '@/components/route-error'
import { ApprovalsBody } from '@/features/approvals/approvals-body'
import { applyOpsChange, cancelOpsChange, decideOpsChange, setTenantApprovals } from '@/features/approvals/approvals.functions'
import { opsApprovalsKey, opsApprovalsQuery, opsChangeRequestsQuery } from '@/features/approvals/approvals.queries'
import { type ApprovalSearch, approvalSearch } from '@/features/approvals/approvals.schemas'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { useCanOperate } from '@/lib/use-can-operate'

// The same Approvals page the organization sees (implement/22 C19), for an operator or auditor.
// platform-api lets an operator decide only what an operator could change here.
export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/approvals')({
  validateSearch: parseListSearch(approvalSearch),
  loaderDeps: ({ search }): ApprovalSearch => search,
  loader: ({ context, params, deps }) =>
    Promise.all([context.queryClient.ensureQueryData(opsApprovalsQuery(params.tenantId)), context.queryClient.ensureQueryData(opsChangeRequestsQuery(params.tenantId, deps))]),
  errorComponent: RouteError,
  component: TenantApprovalsPage,
})

function TenantApprovalsPage() {
  const { tenantId } = Route.useParams()
  const search = Route.useSearch()
  const onSearch = searchPatcher<ApprovalSearch>(Route.useNavigate())
  const fetching = useListPending()
  const canOperate = useCanOperate()
  const { data: overview } = useSuspenseQuery(opsApprovalsQuery(tenantId))
  const { data } = useSuspenseQuery(opsChangeRequestsQuery(tenantId, search))

  return (
    <ApprovalsBody
      scope="tenant"
      overview={overview}
      data={data}
      search={search}
      onSearch={onSearch}
      fetching={fetching}
      invalidateKey={opsApprovalsKey(tenantId)}
      actions={
        canOperate
          ? {
              setRequired: (required) => setTenantApprovals({ data: { tenantId, required } }),
              decide: (id, action, reason) => decideOpsChange({ data: { tenantId, id, action, reason } }),
              cancel: (id) => cancelOpsChange({ data: { tenantId, id } }),
              apply: (id) => applyOpsChange({ data: { tenantId, id } }),
            }
          : {}
      }
    />
  )
}
