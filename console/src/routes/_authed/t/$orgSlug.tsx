import { createFileRoute } from '@tanstack/react-router'

import { RouteError } from '@/components/route-error'
import { activateOrganization } from '@/features/portal/portal-session.functions'

// Tenant portal. Opening an organization's URL makes it the session's active organization, which is
// what the tenant middleware reads; a non-member gets an error instead. The navigation lives in the
// shell (components/shell/use-shell-model.ts), which reads `organization` from this route's context.
export const Route = createFileRoute('/_authed/t/$orgSlug')({
  beforeLoad: async ({ params }) => ({ organization: await activateOrganization({ data: { slug: params.orgSlug } }) }),
  errorComponent: RouteError,
})
