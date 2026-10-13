import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { RouteError } from '@/components/route-error'
import { ApprovalsBody } from '@/features/approvals/approvals-body'
import { applyOpsChange, cancelOpsChange, decideOpsChange } from '@/features/approvals/approvals.functions'
import { opsApprovalsKey, opsApprovalsQuery, opsChangeRequestsQuery } from '@/features/approvals/approvals.queries'
import { type ApprovalSearch, approvalSearch } from '@/features/approvals/approvals.schemas'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { useCanOperate } from '@/lib/use-can-operate'

// Changes to operator accounts that wait for a second operator (implement/22-console-feedback.md C19).
// Whether they wait is a server setting (OPERATOR_APPROVALS), so there is no switch here. A tenant's
// own requests are on that tenant's Approvals page.
export const Route = createFileRoute('/_authed/ops/approvals')({
  validateSearch: parseListSearch(approvalSearch),
  loaderDeps: ({ search }): ApprovalSearch => search,
  loader: ({ context, deps }) => Promise.all([context.queryClient.ensureQueryData(opsApprovalsQuery()), context.queryClient.ensureQueryData(opsChangeRequestsQuery(undefined, deps))]),
  errorComponent: RouteError,
  component: OperatorApprovalsPage,
})

function OperatorApprovalsPage() {
  const search = Route.useSearch()
  const onSearch = searchPatcher<ApprovalSearch>(Route.useNavigate())
  const fetching = useListPending()
  const canOperate = useCanOperate()
  const { data: overview } = useSuspenseQuery(opsApprovalsQuery())
  const { data } = useSuspenseQuery(opsChangeRequestsQuery(undefined, search))

  return (
    <ApprovalsBody
      scope="operators"
      overview={overview}
      data={data}
      search={search}
      onSearch={onSearch}
      fetching={fetching}
      invalidateKey={opsApprovalsKey()}
      actions={
        canOperate
          ? {
              decide: (id, action, reason) => decideOpsChange({ data: { id, action, reason } }),
              cancel: (id) => cancelOpsChange({ data: { id } }),
              apply: (id) => applyOpsChange({ data: { id } }),
            }
          : {}
      }
    />
  )
}
