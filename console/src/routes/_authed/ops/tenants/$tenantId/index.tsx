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
import { createTenantOrganization, type getTenantOrganization } from '@/features/tenants/tenant-owner.functions'
import { tenantOrganizationQuery, tenantQuery } from '@/features/tenants/tenants.queries'
import { formatDateTime } from '@/lib/format'

type MemberRow = NonNullable<Awaited<ReturnType<typeof getTenantOrganization>>>['members'][number]

const column = createColumnHelper<DataTableFeatures, MemberRow>()
const memberColumns = column.columns([
  column.accessor('name', { header: 'Name' }),
  column.accessor('email', { header: 'Email' }),
  column.accessor('role', { header: 'Role', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  column.accessor('twoFactorEnabled', { header: '2FA', cell: ({ getValue }) => (getValue() ? 'on' : 'not set up') }),
  column.accessor('since', { header: 'Member since', cell: ({ getValue }) => formatDateTime(getValue()) }),
])

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(tenantOrganizationQuery(params.tenantId)),
  errorComponent: RouteError,
  component: TenantOverviewPage,
})

function TenantOverviewPage() {
  const { tenantId } = Route.useParams()
  const { data: tenant } = useSuspenseQuery(tenantQuery(tenantId))
  const { data: organization } = useSuspenseQuery(tenantOrganizationQuery(tenantId))

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Tenant</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Platform id</dt>
            <dd className="font-mono text-xs break-all">{tenant.id}</dd>
            <dt className="text-muted-foreground">Agent tenant</dt>
            <dd className="font-mono text-xs break-all">{tenant.agentTenantId}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{formatDateTime(tenant.createdAt)}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Console organization</CardTitle>
          <CardDescription>{organization ? `/${organization.slug}` : 'Customer staff sign in to the tenant portal through this organization.'}</CardDescription>
        </CardHeader>
        <CardContent>
          {organization ? (
            <DataTable columns={memberColumns} data={organization.members} emptyMessage="No members." pageSize={10} testId="members-table" />
          ) : (
            <CreateOrganizationForm tenantId={tenantId} ready={tenant.status === 'ready'} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CreateOrganizationForm({ tenantId, ready }: { tenantId: string; ready: boolean }) {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (owner: { ownerEmail: string; ownerName: string }) => createTenantOrganization({ data: { tenantId, ...owner } }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant', tenantId, 'organization'] })
      toast.success(result.passwordLinkSent ? `Organization created. ${result.ownerEmail} received a link to set a password.` : `Organization created with ${result.ownerEmail} as owner.`)
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    create.mutate({ ownerEmail: String(form.get('ownerEmail')), ownerName: String(form.get('ownerName')) })
  }

  return (
    <form method="post" onSubmit={onSubmit}>
      <FieldGroup>
        {!ready && (
          <Alert>
            <AlertDescription>Finish onboarding before creating the organization.</AlertDescription>
          </Alert>
        )}
        {create.error && (
          <Alert variant="destructive">
            <AlertDescription>{create.error.message}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="ownerName">Owner name</FieldLabel>
          <Input id="ownerName" name="ownerName" maxLength={200} required />
        </Field>
        <Field>
          <FieldLabel htmlFor="ownerEmail">Owner email</FieldLabel>
          <Input id="ownerEmail" name="ownerEmail" type="email" required />
        </Field>
        <Button type="submit" disabled={!hydrated || !ready || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create organization'}
        </Button>
      </FieldGroup>
    </form>
  )
}
