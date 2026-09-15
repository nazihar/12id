import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute } from '@tanstack/react-router'
import { toast } from 'sonner'

import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { retryOnboarding } from '@/features/tenants/tenants.functions'
import { tenantQuery } from '@/features/tenants/tenants.queries'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(tenantQuery(params.tenantId)),
  errorComponent: RouteError,
  component: TenantLayout,
})

const TABS = [
  { to: '/ops/tenants/$tenantId', label: 'Overview', exact: true },
  { to: '/ops/tenants/$tenantId/api-keys', label: 'API keys', exact: false },
  { to: '/ops/tenants/$tenantId/catalogue', label: 'Catalogue', exact: false },
  { to: '/ops/tenants/$tenantId/templates', label: 'Proof templates', exact: false },
  { to: '/ops/tenants/$tenantId/exchanges', label: 'Exchanges', exact: false },
  { to: '/ops/tenants/$tenantId/wallets', label: 'Wallets', exact: false },
  { to: '/ops/tenants/$tenantId/webhooks', label: 'Webhooks', exact: false },
] as const

function TenantLayout() {
  const { tenantId } = Route.useParams()
  const { data: tenant } = useSuspenseQuery(tenantQuery(tenantId))
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () => retryOnboarding({ data: { tenantId } }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant', tenantId] })
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant-overview'] })
      if (updated.status === 'ready') toast.success('Onboarding finished.')
      else toast.error(`Onboarding is still ${updated.status}.`)
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-lg font-medium">{tenant.name}</h1>
          <StateBadge state={tenant.status} />
        </div>
        <p className="font-mono text-xs text-muted-foreground">{tenant.did ?? 'No DID yet'}</p>
      </div>

      {tenant.status !== 'ready' && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Onboarding is {tenant.status}{tenant.lastError ? `: ${tenant.lastError}` : '.'}</span>
            <Button size="sm" variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending}>
              {retry.isPending ? 'Retrying…' : 'Retry onboarding'}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <nav className="flex flex-wrap gap-1 border-b pb-2 text-sm" aria-label="Tenant sections">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            params={{ tenantId }}
            activeOptions={{ exact: tab.exact }}
            className="rounded-md px-2.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            activeProps={{ className: 'bg-muted font-medium text-foreground' }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </section>
  )
}
