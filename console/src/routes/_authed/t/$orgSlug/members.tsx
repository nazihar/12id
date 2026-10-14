import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { KeyRoundIcon, LockOpenIcon, MailXIcon, UserCheckIcon, UserMinusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { RowAction, RowActions } from '@/components/row-action'
import { RoleBadge, StateBadge } from '@/components/state-badge'
import { ExportMenu } from '@/components/data-table/export-menu'
import { AccessReport } from '@/features/accounts/access-report'
import { DisableAction, DisabledDetail } from '@/features/accounts/disable-dialog'
import { SignedInTable } from '@/features/accounts/signed-in-table'
import { exportPortalMembers } from '@/features/export/export.functions'
import type { DisableInput } from '@/features/operators/operators.schemas'
import { ChangeRoleAction, InviteMemberDialog } from '@/features/portal/member-dialogs'
import { cancelMemberInvitation, disableMembership, getMemberAccessReport, type listMembers, listMemberSessions, reenableMember, reenableMembership, removeOrganizationMember, sendMemberPasswordLink, unlockMember } from '@/features/portal/members.functions'
import { MEMBER_STATES, type MemberSearch, memberSearch } from '@/features/portal/members.schemas'
import { portalKey, portalMembersQuery, portalRolesQuery } from '@/features/portal/portal.queries'
import { SelectFilter } from '@/components/data-table/list-toolbar'
import { useListPending } from '@/components/data-table/use-list-pending'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/format'
import { isFiltered, pagingFor, resetFor, parseListSearch, searchPatcher } from '@/lib/list-search'
import { canDo } from '@/lib/permissions'
import { PortalPendingChanges } from '@/features/approvals/pending-changes'

type MembersData = Awaited<ReturnType<typeof listMembers>>
type MemberRow = Extract<MembersData, { tab: 'members' }>['page']['items'][number]
type InvitationRow = Extract<MembersData, { tab: 'invitations' }>['page']['items'][number]

// implement/26: the totals above the list, and who is signed in now.
const reportQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'members', 'report'), queryFn: () => getMemberAccessReport() })
const sessionsQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'members', 'sessions'), queryFn: () => listMemberSessions() })

const stateOptions = MEMBER_STATES.map((value) => ({ value, label: value }))

export const Route = createFileRoute('/_authed/t/$orgSlug/members')({
  validateSearch: parseListSearch(memberSearch),
  loaderDeps: ({ search }): MemberSearch => search,
  loader: async ({ context, params, deps }) => {
    const report = context.queryClient.ensureQueryData(reportQuery(params.orgSlug))
    const roles = context.queryClient.ensureQueryData(portalRolesQuery(params.orgSlug))
    const list = deps.tab === 'signed-in' ? context.queryClient.ensureQueryData(sessionsQuery(params.orgSlug)) : context.queryClient.ensureQueryData(portalMembersQuery(params.orgSlug, deps))
    await Promise.all([report, roles, list])
  },
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
  const tab = search.tab ?? 'members'
  const { data } = useQuery({ ...portalMembersQuery(orgSlug, search), enabled: tab !== 'signed-in' })
  const { data: report } = useSuspenseQuery(reportQuery(orgSlug))
  const { data: roles } = useSuspenseQuery(portalRolesQuery(orgSlug))
  const roleLabel = (role: string) => roles.find((row) => row.role === role)?.label ?? role
  const roleOptions = roles.map((role) => ({ value: role.role, label: role.label }))
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'members') })
  const organizationId = organization.id
  const canManage = canDo(organization.permissions, { member: ['update', 'delete'] })
  const canInvite = canDo(organization.permissions, { invitation: ['create'] })
  const canExport = canDo(organization.permissions, { export: ['run'] })

  const remove = useMutation({
    mutationFn: (memberId: string) => removeOrganizationMember({ data: { organizationId, memberId } }),
    onSuccess: async () => {
      toast.success('Member removed.')
      await refresh()
    },
  })
  // implement/24: the lock after wrong passwords, the inactivity rule and a password link.
  const unlock = useMutation({
    mutationFn: (memberId: string) => unlockMember({ data: { organizationId, memberId } }),
    onSuccess: async () => {
      toast.success('Member unlocked.')
      await refresh()
    },
  })
  const reenable = useMutation({
    mutationFn: (memberId: string) => reenableMember({ data: { organizationId, memberId } }),
    onSuccess: async () => {
      toast.success('Member re-enabled.')
      await refresh()
    },
  })
  // implement/26: disable in this organization only, until a day or until re-enabled.
  const disable = useMutation({
    mutationFn: ({ memberId, ...input }: DisableInput & { memberId: string }) => disableMembership({ data: { organizationId, memberId, ...input } }),
    onSuccess: async () => {
      toast.success('Member disabled in this organization.')
      await refresh()
    },
  })
  const reenableHere = useMutation({
    mutationFn: (memberId: string) => reenableMembership({ data: { organizationId, memberId } }),
    onSuccess: async () => {
      toast.success('Member re-enabled.')
      await refresh()
    },
  })
  const passwordLink = useMutation({
    mutationFn: (memberId: string) => sendMemberPasswordLink({ data: { organizationId, memberId } }),
    onSuccess: () => toast.success('A password link was mailed.'),
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
    memberColumn.accessor('roleLabel', { header: 'Role', cell: ({ getValue }) => <RoleBadge label={getValue()} /> }),
    memberColumn.accessor('twoFactorEnabled', { header: '2FA', cell: ({ getValue }) => (getValue() ? 'on' : 'not set up') }),
    memberColumn.accessor('lastSignInAt', { header: 'Last sign-in', cell: ({ getValue }) => (getValue() ? formatDateTime(getValue() as string) : 'never') }),
    memberColumn.accessor('state', {
      header: 'Status',
      cell: ({ row }) => (
        <>
          <StateBadge state={row.original.state} />
          <DisabledDetail disabled={row.original.disabled} />
        </>
      ),
    }),
    memberColumn.accessor('since', { header: 'Member since', cell: ({ getValue }) => formatDateTime(getValue()) }),
    memberColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canManage && !row.original.isYou ? (
          <RowActions>
            <ChangeRoleAction organizationId={organizationId} orgSlug={orgSlug} member={{ id: row.original.id, email: row.original.email, role: row.original.role }} />
            {row.original.state === 'locked' && (
              <RowAction
                label="Unlock"
                icon={LockOpenIcon}
                confirm={{
                  title: `Unlock ${row.original.email}?`,
                  description: 'The account was locked after too many wrong passwords. Unlocking lets them try again now instead of waiting.',
                  confirmLabel: 'Unlock',
                  onConfirm: () => unlock.mutateAsync(row.original.id),
                }}
              />
            )}
            {row.original.disabled?.scope === 'membership' ? (
              <RowAction
                label="Re-enable here"
                icon={UserCheckIcon}
                confirm={{
                  title: `Re-enable ${row.original.email} in this organization?`,
                  description: 'They can open this organization again on their next request.',
                  confirmLabel: 'Re-enable',
                  onConfirm: () => reenableHere.mutateAsync(row.original.id),
                }}
              />
            ) : (
              row.original.state !== 'inactive' && (
                <DisableAction
                  who={row.original.email}
                  what="Only in this organization: they keep their account and any other organization. They cannot open this one until the day you pick, or until someone re-enables it."
                  onDisable={(input) => disable.mutateAsync({ memberId: row.original.id, ...input })}
                />
              )
            )}
            {row.original.state === 'inactive' && (
              <RowAction
                label="Re-enable"
                icon={UserCheckIcon}
                confirm={{
                  title: `Re-enable ${row.original.email}?`,
                  description: 'The account was disabled because it was not used. They can sign in again.',
                  confirmLabel: 'Re-enable',
                  onConfirm: () => reenable.mutateAsync(row.original.id),
                }}
              />
            )}
            <RowAction
              label="Send password link"
              icon={KeyRoundIcon}
              confirm={{
                title: `Send ${row.original.email} a password link?`,
                description: 'They get an email to choose a new password. The link works once and for 10 minutes.',
                confirmLabel: 'Send link',
                onConfirm: () => passwordLink.mutateAsync(row.original.id),
              }}
            />
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
    invitationColumn.accessor('roleLabel', { header: 'Role', cell: ({ getValue }) => <RoleBadge label={getValue()} /> }),
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

  const common = data && {
    paging: pagingFor(data.page, onSearch),
    onReset: resetFor(search, onSearch),
    search: { value: search.q, placeholder: tab === 'members' ? 'Search name or email' : 'Search email', onChange: (q: string | undefined) => onSearch({ q }) },
    toolbar: (
      <>
        <SelectFilter label="Role" options={roleOptions} value={search.role} onChange={(role) => onSearch({ role })} />
        {tab === 'members' && <SelectFilter label="Status" options={stateOptions} value={search.state} onChange={(state) => onSearch({ state })} />}
      </>
    ),
    fetching,
  }

  return (
    <section className="space-y-4">
      <PageHeader title="Members" description="People who can sign in to this organization, and what their role allows." actions={canInvite && <InviteMemberDialog organizationId={organizationId} orgSlug={orgSlug} />} />
      <PortalPendingChanges orgSlug={orgSlug} types={['member.']} />
      <AccessReport report={report} roleLabel={roleLabel} />
      <Tabs value={tab} onValueChange={(next) => onSearch({ tab: next === 'members' ? undefined : (next as 'invitations' | 'signed-in'), q: undefined, role: undefined, state: undefined })}>
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="invitations">Pending invitations</TabsTrigger>
          <TabsTrigger value="signed-in">Signed in now</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'signed-in' ? (
        <MemberSessions orgSlug={orgSlug} roleLabel={roleLabel} />
      ) : !data || !common || data.tab !== tab ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.tab === 'members' ? (
        <DataTable
          columns={memberColumns}
          data={data.page.items}
          emptyMessage={isFiltered(search) ? 'No members match.' : 'No members.'}
          testId="members-table"
          actions={canExport && <ExportMenu onExport={(format) => exportPortalMembers({ data: { format, search } })} />}
          {...common}
        />
      ) : (
        <DataTable columns={invitationColumns} data={data.page.items} emptyMessage={isFiltered(search) ? 'No invitations match.' : 'No pending invitations.'} testId="invitations-table" {...common} />
      )}
    </section>
  )
}

/** Members signed in now. Read-only: an owner disables a membership; ending a session would sign the person out of their other organizations too. */
function MemberSessions({ orgSlug, roleLabel }: { orgSlug: string; roleLabel: (role: string) => string }) {
  const { viewer } = Route.useRouteContext()
  const { data } = useSuspenseQuery(sessionsQuery(orgSlug))
  return <SignedInTable rows={data} currentUserId={viewer.userId} roleLabel={(value) => value.split(',').map((role) => roleLabel(role.trim())).join(', ')} />
}
