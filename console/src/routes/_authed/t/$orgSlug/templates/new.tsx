import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { createPortalTemplate } from '@/features/portal/portal-data.functions'
import { portalCatalogueQuery, portalKey } from '@/features/portal/portal.queries'
import { TemplateBuilder } from '@/features/portal/template-builder'
import { tenantCan } from '@/lib/permissions'
import type { TemplateDefinition } from '@/lib/template-schema'

export const Route = createFileRoute('/_authed/t/$orgSlug/templates/new')({
  beforeLoad: ({ context, params }) => {
    if (!tenantCan(context.organization.role, { template: ['create'] })) throw redirect({ to: '/t/$orgSlug/templates', params })
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(portalCatalogueQuery(params.orgSlug)),
  errorComponent: RouteError,
  component: NewTemplatePage,
})

function NewTemplatePage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data: catalogue } = useSuspenseQuery(portalCatalogueQuery(orgSlug))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (definition: TemplateDefinition) => createPortalTemplate({ data: { organizationId: organization.id, definition } }),
    onSuccess: async (template) => {
      toast.success(`Saved ${template.name}.`)
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'templates') })
    },
  })
  const backToList = () => navigate({ to: '/t/$orgSlug/templates', params: { orgSlug } })

  return (
    <section className="space-y-5">
      <PageHeader title="New proof template" description="Describe what a holder must present. Save publishes it to your backend through the API." />
      <TemplateBuilder
        schemas={catalogue.schemas}
        submitLabel="Save template"
        error={create.error}
        onSubmit={async (definition) => {
          await create.mutateAsync(definition)
          await backToList()
        }}
        onCancel={() => void backToList()}
      />
    </section>
  )
}
