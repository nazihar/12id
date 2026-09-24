import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, notFound, redirect, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { updatePortalTemplate } from '@/features/portal/portal-data.functions'
import { portalCatalogueQuery, portalKey, portalTemplateQuery } from '@/features/portal/portal.queries'
import { TemplateBuilder } from '@/features/portal/template-builder'
import { tenantCan } from '@/lib/permissions'
import type { TemplateDefinition } from '@/lib/template-schema'

export const Route = createFileRoute('/_authed/t/$orgSlug/templates/$templateId/edit')({
  beforeLoad: ({ context, params }) => {
    if (!tenantCan(context.organization.role, { template: ['update'] })) throw redirect({ to: '/t/$orgSlug/templates', params })
  },
  loader: async ({ context, params }) => {
    const [template] = await Promise.all([context.queryClient.ensureQueryData(portalTemplateQuery(params.orgSlug, params.templateId)), context.queryClient.ensureQueryData(portalCatalogueQuery(params.orgSlug))])
    if (!template) throw notFound()
  },
  errorComponent: RouteError,
  notFoundComponent: () => <p className="text-sm text-muted-foreground">This template no longer exists.</p>,
  component: EditTemplatePage,
})

function EditTemplatePage() {
  const { orgSlug, templateId } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data: catalogue } = useSuspenseQuery(portalCatalogueQuery(orgSlug))
  const { data: template } = useSuspenseQuery(portalTemplateQuery(orgSlug, templateId))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const update = useMutation({
    mutationFn: (definition: TemplateDefinition) => updatePortalTemplate({ data: { organizationId: organization.id, templateId, definition } }),
    onSuccess: async (saved) => {
      toast.success(`Saved ${saved.name}.`)
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'templates') })
    },
  })
  const backToList = () => navigate({ to: '/t/$orgSlug/templates', params: { orgSlug } })

  if (!template) return <p className="text-sm text-muted-foreground">This template no longer exists.</p>

  return (
    <section className="space-y-5">
      <PageHeader title={`Edit ${template.name}`} description="Changes apply to proof requests made after saving." />
      <TemplateBuilder
        key={template.id}
        schemas={catalogue.schemas}
        initial={template.definition}
        submitLabel="Save template"
        error={update.error}
        onSubmit={async (definition) => {
          await update.mutateAsync(definition)
          await backToList()
        }}
        onCancel={() => void backToList()}
      />
    </section>
  )
}
