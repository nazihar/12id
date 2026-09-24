import { keepPreviousData, queryOptions, useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { BanIcon, LogOutIcon, UserCheckIcon } from 'lucide-react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { RowAction, RowActions } from '@/components/row-action'
import { StateBadge } from '@/components/state-badge'
import { InviteOperatorDialog } from '@/features/operators/invite-operator-dialog'
import { banOperator, listOperators, revokeOperatorSessions, unbanOperator } from '@/features/operators/operators.functions'
import { type OperatorSearch, operatorSearch, operatorStatusOptions } from '@/features/operators/operators.schemas'
import { SelectFilter } from '@/components/data-table/list-toolbar'
import { useListPending } from '@/components/data-table/use-list-pending'
import { formatDateTime } from '@/lib/format'
import { isFiltered, pagingFor, resetFor, parseListSearch, searchPatcher } from '@/lib/list-search'

type OperatorRow = Awaited<ReturnType<typeof listOperators>>['items'][number]

const operatorsQuery = (search: OperatorSearch) =>
  queryOptions({ queryKey: ['ops', 'operators', search], queryFn: () => listOperators({ data: search }), placeholderData: keepPreviousData })

export const Route = createFileRoute('/_authed/ops/operators')({
  validateSearch: parseListSearch(operatorSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(operatorsQuery(deps)),
  errorComponent: RouteError,
  component: OperatorsPage,
})

function OperatorsPage() {
  const { viewer } = Route.useRouteContext()
  const search = Route.useSearch()
  const onSearch = searchPatcher<OperatorSearch>(Route.useNavigate())
  const fetching = useListPending()
  const { data } = useSuspenseQuery(operatorsQuery(search))
  return (
    <section className="space-y-4">
      <PageHeader title="Operators" description="12id staff with access to every tenant." actions={<InviteOperatorDialog />} />
      <DataTable
        columns={operatorColumns(viewer.userId)}
        data={data.items}
        paging={pagingFor(data, onSearch)}
        onReset={resetFor(search, onSearch)}
        search={{ value: search.q, placeholder: 'Search name or email', onChange: (q) => onSearch({ q }) }}
        toolbar={<SelectFilter label="Status" options={operatorStatusOptions} value={search.status} onChange={(status) => onSearch({ status })} />}
        fetching={fetching}
        emptyMessage={isFiltered(search) ? 'No operators match.' : 'No operators.'}
        testId="operators-table"
      />
    </section>
  )
}

const column = createColumnHelper<DataTableFeatures, OperatorRow>()

function operatorColumns(currentUserId: string) {
  return column.columns([
    column.accessor('name', { header: 'Name' }),
    column.accessor('email', { header: 'Email' }),
    column.accessor((row) => (row.banned ? 'banned' : 'active'), { id: 'status', header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    column.accessor('createdAt', { header: 'Created', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (row.original.id === currentUserId ? <span className="flex justify-end text-xs text-muted-foreground">you</span> : <OperatorActions operator={row.original} />),
    }),
  ])
}

function OperatorActions({ operator }: { operator: OperatorRow }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ops', 'operators'] })
  const ban = useMutation({
    mutationFn: () => banOperator({ data: { userId: operator.id } }),
    onSuccess: async () => {
      toast.success(`${operator.email} is banned and signed out.`)
      await refresh()
    },
  })
  const unban = useMutation({
    mutationFn: () => unbanOperator({ data: { userId: operator.id } }),
    onSuccess: async () => {
      toast.success(`${operator.email} can sign in again.`)
      await refresh()
    },
  })
  const revoke = useMutation({
    mutationFn: () => revokeOperatorSessions({ data: { userId: operator.id } }),
    onSuccess: () => toast.success(`Signed ${operator.email} out everywhere.`),
  })
  return (
    <RowActions>
      <RowAction
        label="Sign out everywhere"
        icon={LogOutIcon}
        confirm={{
          title: `Sign ${operator.email} out everywhere?`,
          description: 'Every session of this operator ends now. They can sign in again with their password and authenticator app.',
          confirmLabel: 'Sign out everywhere',
          onConfirm: () => revoke.mutateAsync(),
        }}
      />
      {operator.banned ? (
        <RowAction
          label="Unban"
          icon={UserCheckIcon}
          confirm={{
            title: `Unban ${operator.email}?`,
            description: 'They can sign in again and see every tenant.',
            confirmLabel: 'Unban',
            onConfirm: () => unban.mutateAsync(),
          }}
        />
      ) : (
        <RowAction
          label="Ban"
          icon={BanIcon}
          confirm={{
            title: `Ban ${operator.email}?`,
            description: 'The account is blocked and every session ends now. Unban later to restore access.',
            confirmLabel: 'Ban operator',
            destructive: true,
            onConfirm: () => ban.mutateAsync(),
          }}
        />
      )}
    </RowActions>
  )
}
