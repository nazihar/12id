import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { MailXIcon, UserMinusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { RowAction, RowActions } from '@/components/row-action'
import { StateBadge } from '@/components/state-badge'
import { ChangeRoleAction, InviteMemberDialog } from '@/features/portal/member-dialogs'
import { cancelMemberInvitation, type listMembers, removeOrganizationMember } from '@/features/portal/members.functions'
import { type MemberSearch, memberSearch, roleOptions } from '@/features/portal/members.schemas'
import { portalKey, portalMembersQuery } from '@/features/portal/portal.queries'
import { SelectFilter } from '@/components/data-table/list-toolbar'
import { useListPending } from '@/components/data-table/use-list-pending'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/format'
import { isFiltered, pagingFor, resetFor, parseListSearch, searchPatcher } from '@/lib/list-search'
import { type TenantRole, tenantCan } from '@/lib/permissions'

type MembersData = Awaited<ReturnType<typeof listMembers>>
type MemberRow = Extract<MembersData, { tab: 'members' }>['page']['items'][number]
type InvitationRow = Extract<MembersData, { tab: 'invitations' }>['page']['items'][number]

export const Route = createFileRoute('/_authed/t/$orgSlug/members')({
  validateSearch: parseListSearch(memberSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(portalMembersQuery(params.orgSlug, deps)),
  errorComponent: RouteError,
  component: MembersPage,
})

const memberColumn = createColumnHelper<DataTableFeatures, MemberRow>()
const invitationColumn = createColumnHelper<DataTableFeatures, InvitationRow>()

function MembersPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const search = Route.useSearch()
  const onSearch = searchPatcher<MemberSearch>(Route.useNavigate())
  const fetching = useListPending()
  const { data } = useSuspenseQuery(portalMembersQuery(orgSlug, search))
  const tab = search.tab ?? 'members'
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'members') })
  const organizationId = organization.id
  const canManage = tenantCan(organization.role, { member: ['update', 'delete'] })
  const canInvite = tenantCan(organization.role, { invitation: ['create'] })

  const remove = useMutation({
    mutationFn: (memberId: string) => removeOrganizationMember({ data: { organizationId, memberId } }),
    onSuccess: async () => {
      toast.success('Member removed.')
      await refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: (invitationId: string) => cancelMemberInvitation({ data: { organizationId, invitationId } }),
    onSuccess: async () => {
      toast.success('Invitation cancelled.')
      await refresh()
    },
  })

  const memberColumns = memberColumn.columns([
    memberColumn.accessor('name', { header: 'Name', cell: ({ row }) => `${row.original.name}${row.original.isYou ? ' (you)' : ''}` }),
    memberColumn.accessor('email', { header: 'Email' }),
    memberColumn.accessor('role', { header: 'Role', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    memberColumn.accessor('twoFactorEnabled', { header: '2FA', cell: ({ getValue }) => (getValue() ? 'on' : 'not set up') }),
    memberColumn.accessor('lastSignInAt', { header: 'Last sign-in', cell: ({ getValue }) => (getValue() ? formatDateTime(getValue() as string) : 'never') }),
    memberColumn.accessor('since', { header: 'Member since', cell: ({ getValue }) => formatDateTime(getValue()) }),
    memberColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canManage && !row.original.isYou ? (
          <RowActions>
            <ChangeRoleAction organizationId={organizationId} orgSlug={orgSlug} member={{ id: row.original.id, email: row.original.email, role: row.original.role as TenantRole }} />
            <RowAction
              label="Remove"
              icon={UserMinusIcon}
              confirm={{
                title: `Remove ${row.original.email}?`,
                description: 'They lose access to this organization on their next request. Invite them again to restore it.',
                confirmLabel: 'Remove member',
                destructive: true,
                onConfirm: () => remove.mutateAsync(row.original.id),
              }}
            />
          </RowActions>
        ) : null,
    }),
  ])

  const invitationColumns = invitationColumn.columns([
    invitationColumn.accessor('email', { header: 'Email' }),
    invitationColumn.accessor('role', { header: 'Role', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
    invitationColumn.accessor('expiresAt', { header: 'Expires', cell: ({ row }) => (row.original.expired ? 'expired' : formatDateTime(row.original.expiresAt)) }),
    invitationColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canInvite ? (
          <RowActions>
            <RowAction
              label="Cancel invitation"
              icon={MailXIcon}
              confirm={{
                title: `Cancel the invitation for ${row.original.email}?`,
                description: 'The link in their email stops working. You can invite them again later.',
                confirmLabel: 'Cancel invitation',
                destructive: true,
                onConfirm: () => cancel.mutateAsync(row.original.id),
              }}
            />
          </RowActions>
        ) : null,
    }),
  ])

  const common = {
    paging: pagingFor(data.page, onSearch),
    onReset: resetFor(search, onSearch),
    search: { value: search.q, placeholder: tab === 'members' ? 'Search name or email' : 'Search email', onChange: (q: string | undefined) => onSearch({ q }) },
    toolbar: <SelectFilter label="Role" options={roleOptions} value={search.role} onChange={(role) => onSearch({ role })} />,
    fetching,
  }

  return (
    <section className="space-y-4">
      <PageHeader title="Members" description="People who can sign in to this organization, and what their role allows." actions={canInvite && <InviteMemberDialog organizationId={organizationId} orgSlug={orgSlug} />} />
      <Tabs value={tab} onValueChange={(next) => onSearch({ tab: next === 'members' ? undefined : 'invitations', q: undefined, role: undefined })}>
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="invitations">Pending invitations</TabsTrigger>
        </TabsList>
      </Tabs>
      {data.tab !== tab ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.tab === 'members' ? (
        <DataTable columns={memberColumns} data={data.page.items} emptyMessage={isFiltered(search) ? 'No members match.' : 'No members.'} testId="members-table" {...common} />
      ) : (
        <DataTable columns={invitationColumns} data={data.page.items} emptyMessage={isFiltered(search) ? 'No invitations match.' : 'No pending invitations.'} testId="invitations-table" {...common} />
      )}
    </section>
  )
}
