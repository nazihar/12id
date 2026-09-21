import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AdoptionCard } from '@/features/portal/biometrics-panels'
import { tenantBiometricsQuery } from '@/features/tenant-data/tenant-data.queries'
import { formatDateTime } from '@/lib/format'

/** Phase 6, operator view: read-only. Tenants configure their own vendor account in the portal. */
export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/biometrics')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(tenantBiometricsQuery(params.tenantId)),
  errorComponent: RouteError,
  component: OpsBiometricsPage,
})

function OpsBiometricsPage() {
  const { tenantId } = Route.useParams()
  const { data } = useSuspenseQuery(tenantBiometricsQuery(tenantId))
  const { settings, adoption } = data
  const policy = settings.defaultPolicy
  return (
    <div className="space-y-6">
      <PageHeader title="Biometrics" description="The tenant's biometric gate. Read-only: tenants manage their own vendor account." />
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Gate <StateBadge state={settings.enabled ? 'active' : 'deprecated'} />
          </CardTitle>
          <CardDescription>
            {settings.enabled ? (policy.required ? 'On; required by default.' : 'On; required only where a definition or template says so.') : 'Off; nothing is gated.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Minimum match {policy.minMatchScore}, minimum liveness {policy.minLivenessScore}, {policy.maxAttempts} attempts, {policy.ttlMinutes} minutes.
          </p>
          {settings.provider ? (
            <p className="flex flex-wrap items-center gap-2">
              Provider <span className="font-mono text-xs">{settings.provider.id}</span> <StateBadge state={settings.provider.status} />
              {settings.provider.lastTestedAt && <span className="text-muted-foreground">tested {formatDateTime(settings.provider.lastTestedAt)}</span>}
              {Object.entries(settings.provider.publicConfig).map(([k, v]) => (
                <span key={k} className="font-mono text-xs text-muted-foreground">
                  {k}={v}
                </span>
              ))}
            </p>
          ) : (
            <p className="text-muted-foreground">No provider configured.</p>
          )}
        </CardContent>
      </Card>
      <AdoptionCard adoption={adoption} />
    </div>
  )
}
