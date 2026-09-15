import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { RouteError } from '@/components/route-error'
import { Button } from '@/components/ui/button'
import { createPortalTemplate, deletePortalTemplate, updatePortalTemplate } from '@/features/portal/portal-data.functions'
import { portalCatalogueQuery, portalKey, portalTemplatesQuery } from '@/features/portal/portal.queries'
import { TemplateBuilder } from '@/features/portal/template-builder'
import type { TemplateRow } from '@/features/tenant-data/types'
import { formatDateTime } from '@/lib/format'
import { tenantCan } from '@/lib/permissions'
import type { TemplateDefinition } from '@/lib/template-schema'

export const Route = createFileRoute('/_authed/t/$orgSlug/templates')({
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(portalTemplatesQuery(params.orgSlug)), context.queryClient.ensureQueryData(portalCatalogueQuery(params.orgSlug))]),
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
  const { data: catalogue } = useSuspenseQuery(portalCatalogueQuery(orgSlug))
  const [editing, setEditing] = useState<'new' | TemplateRow | null>(null)
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'templates') })
  const canCreate = tenantCan(organization.role, { template: ['create'] })
  const canUpdate = tenantCan(organization.role, { template: ['update'] })
  const canDelete = tenantCan(organization.role, { template: ['delete'] })

  const save = useMutation({
    mutationFn: (definition: TemplateDefinition) =>
      editing && editing !== 'new'
        ? updatePortalTemplate({ data: { organizationId: organization.id, templateId: editing.id, definition } })
        : createPortalTemplate({ data: { organizationId: organization.id, definition } }),
    onSuccess: async (template) => {
      toast.success(`Saved ${template.name}.`)
      setEditing(null)
      await refresh()
    },
  })
  const remove = useMutation({
    mutationFn: (template: TemplateRow) => deletePortalTemplate({ data: { organizationId: organization.id, templateId: template.id } }),
    onSuccess: async () => {
      toast.success('Template deleted.')
      await refresh()
    },
    onError: (error) => toast.error(error.message),
  })

  const columns = column.columns([
    column.accessor('name', { header: 'Template' }),
    column.accessor((row) => summarize(row.definition), { id: 'summary', header: 'Requests', cell: ({ getValue }) => <span className="text-xs">{getValue()}</span> }),
    column.accessor('updatedAt', { header: 'Updated', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex gap-1">
          {canUpdate && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(row.original)} disabled={!hydrated}>
              Edit
            </Button>
          )}
          {canDelete && (
            <Button size="sm" variant="ghost" onClick={() => remove.mutate(row.original)} disabled={!hydrated || remove.isPending}>
              Delete
            </Button>
          )}
        </div>
      ),
    }),
  ])

  if (editing) {
    return (
      <section className="space-y-3">
        <h2 className="font-heading font-medium">{editing === 'new' ? 'New proof template' : `Edit ${editing.name}`}</h2>
        <TemplateBuilder
          schemas={catalogue.schemas}
          initial={editing === 'new' ? undefined : editing.definition}
          submitLabel="Save template"
          pending={save.isPending}
          error={save.error?.message}
          onSubmit={(definition) => save.mutate(definition)}
          onCancel={() => {
            save.reset()
            setEditing(null)
          }}
        />
      </section>
    )
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Your backend requests a proof with a template id. Every request also checks that the credential has not expired.</p>
        {canCreate && (
          <Button size="sm" onClick={() => setEditing('new')} disabled={!hydrated}>
            <PlusIcon />
            New template
          </Button>
        )}
      </div>
      <DataTable columns={columns} data={templates} searchPlaceholder="Search templates" emptyMessage="No proof templates." testId="templates-table" />
    </section>
  )
}
