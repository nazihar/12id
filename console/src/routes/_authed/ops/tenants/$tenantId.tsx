import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Outlet, createFileRoute } from '@tanstack/react-router'
import { CircleAlertIcon } from 'lucide-react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { retryOnboarding } from '@/features/tenants/tenants.functions'
import { tenantQuery } from '@/features/tenants/tenants.queries'
import { useCanOperate } from '@/lib/use-can-operate'

// Tenant detail. The section navigation lives in the shell, which reads this route's loader data
// (components/shell/use-shell-model.ts).
export const Route = createFileRoute('/_authed/ops/tenants/$tenantId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(tenantQuery(params.tenantId)),
  errorComponent: RouteError,
  component: TenantLayout,
})

function TenantLayout() {
  const { tenantId } = Route.useParams()
  const { data: tenant } = useSuspenseQuery(tenantQuery(tenantId))
  const queryClient = useQueryClient()
  const canOperate = useCanOperate()
  const retry = useMutation({
    mutationFn: () => retryOnboarding({ data: { tenantId } }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant', tenantId] })
      await queryClient.invalidateQueries({ queryKey: ['ops', 'tenant-overview'] })
      if (updated.status === 'ready') toast.success('Onboarding finished.')
      else toast.error(`Onboarding is still ${updated.status}.`)
    },
  })

  return (
    <section className="space-y-5">
      <PageHeader title={tenant.name} badge={<StateBadge state={tenant.status} />} meta={<p className="font-mono text-xs text-muted-foreground">{tenant.did ?? 'No DID yet'}</p>} />

      {tenant.status !== 'ready' && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Onboarding is {tenant.status}</AlertTitle>
          <AlertDescription className="gap-3">
            {tenant.lastError && <span>{tenant.lastError}</span>}
            {canOperate && (
              <div>
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="outline">
                      Retry onboarding
                    </Button>
                  }
                  title="Retry onboarding?"
                  description="Runs the ledger onboarding again for this tenant. It joins a run already in progress instead of starting a second one."
                  confirmLabel="Retry onboarding"
                  pendingLabel="Retrying…"
                  onConfirm={() => retry.mutateAsync()}
                />
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      <Outlet />
    </section>
  )
}
