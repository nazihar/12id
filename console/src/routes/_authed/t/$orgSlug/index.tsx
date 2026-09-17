import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { RangeTabs } from '@/components/dashboard/range-tabs'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { portalDashboardQuery } from '@/features/dashboard/dashboard.queries'
import { parseDashboardSearch, rangeOf } from '@/features/dashboard/dashboard.schemas'
import { GettingStarted, gettingStartedSteps, isGettingStartedComplete } from '@/features/dashboard/getting-started'
import { TenantDashboardBody, type TenantDashboardLinks } from '@/features/dashboard/tenant-dashboard'
import { portalCatalogueQuery } from '@/features/portal/portal.queries'

// The tenant Overview (Phase 4 C8). The stats come through the route loader; the catalogue card
// loads on its own because it goes through agent-service and must not take the dashboard down.
export const Route = createFileRoute('/_authed/t/$orgSlug/')({
  validateSearch: parseDashboardSearch,
  loaderDeps: ({ search }) => ({ days: rangeOf(search) }),
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(portalDashboardQuery(params.orgSlug, deps.days)),
  errorComponent: RouteError,
  component: PortalOverviewPage,
})

function PortalOverviewPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const days = rangeOf(Route.useSearch())
  const navigate = Route.useNavigate()
  const { data: stats } = useSuspenseQuery(portalDashboardQuery(orgSlug, days))
  // No retries: the loaders do not retry an unreachable agent either, and the card should say so promptly.
  const catalogue = useQuery({ ...portalCatalogueQuery(orgSlug), retry: false })

  const params = { orgSlug }
  const links: TenantDashboardLinks = {
    exchanges: { to: '/t/$orgSlug/exchanges', params },
    wallets: { to: '/t/$orgSlug/wallets', params },
    webhooks: { to: '/t/$orgSlug/webhooks', params },
  }
  const steps = gettingStartedSteps({
    schemas: catalogue.data ? catalogue.data.schemas.length : null,
    credentialDefinitions: catalogue.data ? catalogue.data.credentialDefinitions.length : null,
    apiKeys: stats.totals.apiKeys.active,
    webhookConfigured: stats.webhook.configured,
    connections: stats.totals.connections.total,
  })

  return (
    <div className="space-y-4">
      <PageHeader title={organization.name} description="How your integration is doing, and what needs a look." actions={<RangeTabs value={days} onChange={(next) => navigate({ search: { days: next }, replace: true })} />} />
      {!isGettingStartedComplete(steps) && <GettingStarted steps={steps} orgSlug={orgSlug} />}
      <TenantDashboardBody stats={stats} links={links} />
      <Card size="sm">
        <CardHeader>
          <CardTitle>Catalogue</CardTitle>
          <CardDescription>Ledger objects published for this tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          {catalogue.error ? (
            <p className="text-sm text-destructive">{catalogue.error.message}</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="catalogue-summary">
              <dt className="text-muted-foreground">Schemas</dt>
              <dd className="tabular-nums">{catalogue.data ? `${catalogue.data.schemas.filter((s) => s.status === 'published').length} published · ${catalogue.data.schemas.filter((s) => s.status === 'deprecated').length} deprecated` : 'Loading…'}</dd>
              <dt className="text-muted-foreground">Credential definitions</dt>
              <dd className="tabular-nums">{catalogue.data ? catalogue.data.credentialDefinitions.length : 'Loading…'}</dd>
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
