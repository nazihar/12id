import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import type { FormEvent } from 'react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cancelMemberInvitation, changeMemberRole, inviteMember, type listMembers, removeOrganizationMember } from '@/features/portal/members.functions'
import { portalKey, portalMembersQuery } from '@/features/portal/portal.queries'
import { formatDateTime } from '@/lib/format'
import { type TenantRole, tenantCan } from '@/lib/permissions'

type MembersData = Awaited<ReturnType<typeof listMembers>>
type MemberRow = MembersData['members'][number]
type InvitationRow = MembersData['invitations'][number]

const ROLES = ['owner', 'admin', 'member'] as const
const ROLE_HELP: Record<TenantRole, string> = {
  owner: 'everything, including members',
  admin: 'API keys, webhooks, catalogue and templates',
  member: 'read-only',
}
const nativeSelect = 'h-8 rounded-lg border border-input bg-transparent px-2 text-sm'

export const Route = createFileRoute('/_authed/t/$orgSlug/members')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(portalMembersQuery(params.orgSlug)),
  errorComponent: RouteError,
  component: MembersPage,
})

const memberColumn = createColumnHelper<DataTableFeatures, MemberRow>()
const invitationColumn = createColumnHelper<DataTableFeatures, InvitationRow>()

function MembersPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data } = useSuspenseQuery(portalMembersQuery(orgSlug))
  // Controls without a form do nothing before hydration, and a changed select would show a role that was never saved.
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'members') })
  const organizationId = organization.id
  const canManage = tenantCan(organization.role, { member: ['update', 'delete'] })
  const canInvite = tenantCan(organization.role, { invitation: ['create'] })

  const changeRole = useMutation({
    mutationFn: (input: { memberId: string; role: TenantRole }) => changeMemberRole({ data: { organizationId, ...input } }),
    onSuccess: async () => {
      toast.success('Role changed.')
      await refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: (memberId: string) => removeOrganizationMember({ data: { organizationId, memberId } }),
    onSuccess: async () => {
      toast.success('Member removed.')
      await refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const cancel = useMutation({
    mutationFn: (invitationId: string) => cancelMemberInvitation({ data: { organizationId, invitationId } }),
    onSuccess: async () => {
      toast.success('Invitation cancelled.')
      await refresh()
    },
    onError: (error) => toast.error(error.message),
  })

  const memberColumns = memberColumn.columns([
    memberColumn.accessor('name', { header: 'Name', cell: ({ row }) => `${row.original.name}${row.original.isYou ? ' (you)' : ''}` }),
    memberColumn.accessor('email', { header: 'Email' }),
    memberColumn.accessor('role', {
      header: 'Role',
      cell: ({ row }) =>
        canManage && !row.original.isYou ? (
          <select
            className={nativeSelect}
            value={row.original.role}
            disabled={!hydrated || changeRole.isPending}
            onChange={(event) => changeRole.mutate({ memberId: row.original.id, role: event.target.value as TenantRole })}
            aria-label={`Role of ${row.original.email}`}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        ) : (
          <StateBadge state={row.original.role} />
        ),
    }),
    memberColumn.accessor('twoFactorEnabled', { header: '2FA', cell: ({ getValue }) => (getValue() ? 'on' : 'not set up') }),
    memberColumn.accessor('since', { header: 'Member since', cell: ({ getValue }) => formatDateTime(getValue()) }),
    memberColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        canManage && !row.original.isYou ? (
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(row.original.id)} disabled={!hydrated || remove.isPending}>
            Remove
          </Button>
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
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate(row.original.id)} disabled={!hydrated || cancel.isPending}>
            Cancel
          </Button>
        ) : null,
    }),
  ])

  return (
    <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-5">
        <section className="space-y-2">
          <h2 className="font-heading font-medium">Members</h2>
          <DataTable columns={memberColumns} data={data.members} emptyMessage="No members." testId="members-table" />
        </section>
        <section className="space-y-2">
          <h2 className="font-heading font-medium">Pending invitations</h2>
          <DataTable columns={invitationColumns} data={data.invitations} emptyMessage="No pending invitations." testId="invitations-table" />
        </section>
      </div>
      {canInvite && <InviteCard organizationId={organizationId} orgSlug={orgSlug} />}
    </div>
  )
}

function InviteCard({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const invite = useMutation({
    mutationFn: (input: { email: string; role: TenantRole }) => inviteMember({ data: { organizationId, ...input } }),
    onSuccess: async (result) => {
      toast.success(`Invitation sent to ${result.email}. The link is valid for 48 hours.`)
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'members') })
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    invite.mutate({ email: String(values.get('email')), role: String(values.get('role')) as TenantRole }, { onSuccess: () => form.reset() })
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Invite someone</CardTitle>
        <CardDescription>They receive an email, create an account and set up two-factor authentication.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" onSubmit={onSubmit}>
          <FieldGroup>
            {invite.error && (
              <Alert variant="destructive">
                <AlertDescription>{invite.error.message}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input id="invite-email" name="email" type="email" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-role">Role</FieldLabel>
              <select id="invite-role" name="role" defaultValue="member" className={nativeSelect}>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}: {ROLE_HELP[role]}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" disabled={!hydrated || invite.isPending}>
              Send invitation
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
