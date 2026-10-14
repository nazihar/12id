import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { LockIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { RowAction, RowActions } from '@/components/row-action'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PortalPendingChanges } from '@/features/approvals/pending-changes'
import { portalKey, portalRolesQuery } from '@/features/portal/portal.queries'
import { NewRoleDialog, RoleRowAction } from '@/features/portal/role-dialogs'
import { deleteCustomRole } from '@/features/portal/roles.functions'
import type { RoleRow } from '@/features/portal/roles.schemas'
import { announceHeld } from '@/lib/held'
import { PORTAL_ACTIONS, canDo } from '@/lib/permissions'

/**
 * The organization's roles (implement/26): the three built-in ones, locked, and the custom ones its
 * owners make from the portal actions. For those who manage people; everyone else is sent to Members.
 */
export const Route = createFileRoute('/_authed/t/$orgSlug/roles')({
  beforeLoad: ({ context, params }) => {
    if (!canDo(context.organization.permissions, { ac: ['update'] })) throw redirect({ to: '/t/$orgSlug/members', params })
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(portalRolesQuery(params.orgSlug)),
  errorComponent: RouteError,
  component: RolesPage,
})

const column = createColumnHelper<DataTableFeatures, RoleRow>()
const actionLabel = (key: string) => PORTAL_ACTIONS.find((action) => action.key === key)?.label ?? key

function RolesPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data } = useSuspenseQuery(portalRolesQuery(orgSlug))
  const queryClient = useQueryClient()
  const organizationId = organization.id
  const canCreate = canDo(organization.permissions, { ac: ['create'] })
  const canUpdate = canDo(organization.permissions, { ac: ['update'] })
  const canDelete = canDo(organization.permissions, { ac: ['delete'] })

  const remove = useMutation({
    mutationFn: (role: string) => deleteCustomRole({ data: { organizationId, role } }),
    onSuccess: async (result) => {
      if (announceHeld(result, queryClient)) return
      toast.success('Role deleted.')
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'roles') })
    },
  })

  const columns = column.columns([
    column.accessor('label', {
      header: 'Role',
      cell: ({ row }) => (
        <div className="grid gap-0.5">
          <span className="flex items-center gap-1.5 font-medium">
            {row.original.label}
            {row.original.builtIn && (
              <Tooltip>
                <TooltipTrigger render={<LockIcon className="size-3.5 text-muted-foreground" aria-label="Built in" />} />
                <TooltipContent>Built in: cannot be changed or deleted</TooltipContent>
              </Tooltip>
            )}
          </span>
          {row.original.description && <span className="text-xs text-muted-foreground">{row.original.description}</span>}
        </div>
      ),
    }),
    column.accessor('actions', {
      header: 'May also',
      cell: ({ getValue }) =>
        getValue().length === 0 ? (
          <span className="text-muted-foreground">view only</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {getValue().map((key) => (
              <Badge key={key} variant="secondary">
                {actionLabel(key)}
              </Badge>
            ))}
          </div>
        ),
    }),
    column.accessor('members', { header: 'Members', cell: ({ row }) => `${row.original.members}${row.original.invitations > 0 ? ` (+${row.original.invitations} invited)` : ''}` }),
    column.display({
      id: 'row-actions',
      header: '',
      cell: ({ row }) => (
        <RowActions>
          {canCreate && <RoleRowAction organizationId={organizationId} orgSlug={orgSlug} role={row.original} kind="clone" />}
          {!row.original.builtIn && canUpdate && <RoleRowAction organizationId={organizationId} orgSlug={orgSlug} role={row.original} kind="edit" />}
          {!row.original.builtIn && canDelete && (
            <RowAction
              label={`Delete ${row.original.label}`}
              icon={Trash2Icon}
              disabled={row.original.members > 0 || row.original.invitations > 0}
              confirm={{
                title: `Delete the role ${row.original.label}?`,
                description: 'Nobody holds it now. It can be made again later.',
                confirmLabel: 'Delete role',
                destructive: true,
                onConfirm: () => remove.mutateAsync(row.original.role),
              }}
            />
          )}
        </RowActions>
      ),
    }),
  ])

  return (
    <section className="space-y-4">
      <PageHeader
        title="Roles"
        description="Everyone in the organization sees every page. A role says what they may also change. Give people roles on the Members page."
        actions={canCreate && <NewRoleDialog organizationId={organizationId} orgSlug={orgSlug} />}
      />
      <PortalPendingChanges orgSlug={orgSlug} types={['role.']} />
      <DataTable columns={columns} data={data} emptyMessage="No roles." testId="roles-table" />
    </section>
  )
}
