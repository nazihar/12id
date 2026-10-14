import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { AdoptionCard, ProviderCard, SettingsCard } from '@/features/portal/biometrics-panels'
import { portalBiometricAdoptionQuery, portalBiometricsQuery } from '@/features/portal/portal.queries'
import { canDo } from '@/lib/permissions'
import { PortalPendingChanges } from '@/features/approvals/pending-changes'

/** Phase 6: the organization's biometric gate (liveness + face match) and its vendor account. */
export const Route = createFileRoute('/_authed/t/$orgSlug/biometrics')({
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(portalBiometricsQuery(params.orgSlug)), context.queryClient.ensureQueryData(portalBiometricAdoptionQuery(params.orgSlug))]),
  errorComponent: RouteError,
  component: PortalBiometricsPage,
})

function PortalBiometricsPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data } = useSuspenseQuery(portalBiometricsQuery(orgSlug))
  const { data: adoption } = useSuspenseQuery(portalBiometricAdoptionQuery(orgSlug))
  const canUpdate = canDo(organization.permissions, { biometrics: ['update'] })
  const captureProvider = data.providers.find((p) => p.id === data.settings.provider?.id)?.captureProvider

  return (
    <div className="space-y-6">
      <PageHeader
        title="Biometrics"
        description="Require a liveness check and a face match before a credential is issued or a proof result is released. Set per credential definition in the catalogue and per proof template."
      />
      <PortalPendingChanges orgSlug={orgSlug} types={['biometrics.provider', 'biometrics.settings']} />
      <ProviderCard settings={data.settings} providers={data.providers} organizationId={organization.id} orgSlug={orgSlug} canUpdate={canUpdate} />
      <SettingsCard key={JSON.stringify(data.settings.defaultPolicy) + data.settings.enabled} settings={data.settings} organizationId={organization.id} orgSlug={orgSlug} canUpdate={canUpdate} />
      <AdoptionCard adoption={adoption} captureProvider={captureProvider} />
    </div>
  )
}
