import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { RowAction, RowActions } from '@/components/row-action'
import { TemplatePolicyAction } from '@/features/portal/biometric-policy-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { deletePortalTemplate } from '@/features/portal/portal-data.functions'
import { portalKey, portalTemplatesQuery } from '@/features/portal/portal.queries'
import type { TemplateRow } from '@/features/tenant-data/types'
import { formatDateTime } from '@/lib/format'
import { tenantCan } from '@/lib/permissions'

export const Route = createFileRoute('/_authed/t/$orgSlug/templates/')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(portalTemplatesQuery(params.orgSlug)),
  errorComponent: RouteError,
  component: PortalTemplatesPage,
})

const column = createColumnHelper<DataTableFeatures, TemplateRow>()

function summarize(definition: TemplateRow['definition']) {
  return definition.groups
    .map((group) => {
      const from = group.credentials.map((ref) => ('schemaName' in ref ? ref.schemaName : ref.credentialDefinitionId)).join(' or ')
      const parts = [group.attributes.length ? `discloses ${group.attributes.join(', ')}` : '', ...(group.predicates ?? []).map((p) => `${p.name} ${p.type} ${p.value}`)].filter(Boolean)
      return `${group.key} (${from}): ${parts.join(' · ')}`
    })
    .join(' | ')
}

function PortalTemplatesPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data: templates } = useSuspenseQuery(portalTemplatesQuery(orgSlug))
  const queryClient = useQueryClient()
  const canCreate = tenantCan(organization.role, { template: ['create'] })
  const canUpdate = tenantCan(organization.role, { template: ['update'] })
  const canDelete = tenantCan(organization.role, { template: ['delete'] })
  const canBiometrics = tenantCan(organization.role, { biometrics: ['update'] })

  const remove = useMutation({
    mutationFn: (template: TemplateRow) => deletePortalTemplate({ data: { organizationId: organization.id, templateId: template.id } }),
    onSuccess: async () => {
      toast.success('Template deleted.')
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'templates') })
    },
  })

  const columns = column.columns([
    column.accessor('name', { header: 'Template' }),
    column.accessor((row) => summarize(row.definition), { id: 'summary', header: 'Requests', cell: ({ getValue }) => <span className="text-xs">{getValue()}</span> }),
    column.accessor((row) => (row.biometricPolicy.mode === 'inherit' ? 'default' : row.biometricPolicy.mode === 'off' ? 'off' : 'required'), { id: 'biometric', header: 'Face check' }),
    column.accessor('updatedAt', { header: 'Updated', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <RowActions>
          {canUpdate && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Link to="/t/$orgSlug/templates/$templateId/edit" params={{ orgSlug, templateId: row.original.id }} aria-label={`Edit ${row.original.name}`} className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
                    <PencilIcon />
                  </Link>
                }
              />
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          )}
          {canBiometrics && <TemplatePolicyAction templateId={row.original.id} label={row.original.name} organizationId={organization.id} orgSlug={orgSlug} />}
          {canDelete && (
            <RowAction
              label="Delete"
              icon={Trash2Icon}
              confirm={{
                title: `Delete ${row.original.name}?`,
                description: 'Proof requests that name this template fail from now on. This cannot be undone.',
                confirmLabel: 'Delete template',
                destructive: true,
                onConfirm: () => remove.mutateAsync(row.original),
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
        title="Proof templates"
        description="Your backend requests a proof with a template id. Every request also checks that the credential has not expired."
        actions={
          canCreate && (
            <Button size="sm" render={<Link to="/t/$orgSlug/templates/new" params={{ orgSlug }} />}>
              <PlusIcon />
              New template
            </Button>
          )
        }
      />
      <DataTable columns={columns} data={templates} searchPlaceholder="Search templates" emptyMessage="No proof templates." testId="templates-table" />
    </section>
  )
}
