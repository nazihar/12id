import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { KeyRoundIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { useListPending } from '@/components/data-table/use-list-pending'
import { RouteError } from '@/components/route-error'
import { SecretOnceDialog } from '@/components/secret-once-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { exportPortalList } from '@/features/export/export.functions'
import { deletePortalWebhook, getPortalDelivery, retryPortalDelivery, rotatePortalWebhookSecret } from '@/features/portal/portal-data.functions'
import { portalDeliveriesQuery, portalKey, portalWebhookQuery } from '@/features/portal/portal.queries'
import { WebhookEndpointDialog } from '@/features/portal/webhook-endpoint-dialog'
import { type DeliverySearch, deliverySearch } from '@/features/tenant-data/list.schemas'
import { DeliveriesPanel } from '@/features/tenant-data/panels'
import type { WebhookEndpoint } from '@/features/tenant-data/types'
import { formatDateTime } from '@/lib/format'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { tenantCan } from '@/lib/permissions'
import { announceHeld } from '@/lib/held'
import { PortalPendingChanges } from '@/features/approvals/pending-changes'

export const Route = createFileRoute('/_authed/t/$orgSlug/webhooks')({
  validateSearch: parseListSearch(deliverySearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([context.queryClient.ensureQueryData(portalWebhookQuery(params.orgSlug)), context.queryClient.ensureQueryData(portalDeliveriesQuery(params.orgSlug, deps))]),
  errorComponent: RouteError,
  component: PortalWebhooksPage,
})

function PortalWebhooksPage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const { data: endpoint } = useSuspenseQuery(portalWebhookQuery(orgSlug))
  const search = Route.useSearch()
  const onSearch = searchPatcher<DeliverySearch>(Route.useNavigate())
  const fetching = useListPending()
  const { data: deliveries } = useSuspenseQuery(portalDeliveriesQuery(orgSlug, search))
  const canUpdate = tenantCan(organization.role, { webhook: ['update'] })
  const canRotate = tenantCan(organization.role, { webhook: ['rotate'] })
  const canRetry = tenantCan(organization.role, { webhook: ['retry'] })
  const organizationId = organization.id

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <PageHeader title="Webhooks" description="Where the platform sends connection, credential, proof and wallet events for this organization." />
        <PortalPendingChanges orgSlug={orgSlug} types={['webhook.']} />
        <EndpointCard endpoint={endpoint} organizationId={organizationId} orgSlug={orgSlug} canUpdate={canUpdate} canRotate={canRotate} />
      </section>
      <DeliveriesPanel
        data={deliveries}
        search={search}
        onSearch={onSearch}
        fetching={fetching}
        invalidateKey={portalKey(orgSlug, 'webhook-deliveries')}
        loadBody={(deliveryId) => getPortalDelivery({ data: { deliveryId } })}
        retryDelivery={canRetry ? (deliveryId) => retryPortalDelivery({ data: { organizationId, deliveryId } }) : undefined}
        onExport={tenantCan(organization.role, { export: ['run'] }) ? (format) => exportPortalList({ data: { list: 'deliveries', format, search } }) : undefined}
      />
    </div>
  )
}

function EndpointCard({ endpoint, organizationId, orgSlug, canUpdate, canRotate }: { endpoint: WebhookEndpoint | null; organizationId: string; orgSlug: string; canUpdate: boolean; canRotate: boolean }) {
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState<string | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'webhook') })

  const rotate = useMutation({
    mutationFn: () => rotatePortalWebhookSecret({ data: { organizationId } }),
    onSuccess: (rotated) => {
      if (!announceHeld(rotated, queryClient)) setSecret(rotated.secret)
    },
  })
  const remove = useMutation({
    mutationFn: () => deletePortalWebhook({ data: { organizationId } }),
    onSuccess: async (removed) => {
      if (announceHeld(removed, queryClient)) return
      toast.success('Webhook endpoint removed. Events are no longer delivered.')
      await refresh()
    },
  })

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Endpoint</CardTitle>
        <CardDescription>{endpoint ? `Updated ${formatDateTime(endpoint.updatedAt)}.` : 'No webhook endpoint configured; events are not delivered.'}</CardDescription>
        {canUpdate && (
          <CardAction>
            <WebhookEndpointDialog organizationId={organizationId} orgSlug={orgSlug} endpoint={endpoint} onSecret={setSecret} />
          </CardAction>
        )}
      </CardHeader>
      {endpoint && (
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">URL</dt>
            <dd className="font-mono text-xs break-all">{endpoint.url}</dd>
            <dt className="text-muted-foreground">Events</dt>
            <dd className="flex flex-wrap gap-1">
              {endpoint.events ? (
                endpoint.events.map((type) => (
                  <Badge key={type} variant="outline" className="font-mono text-xs">
                    {type}
                  </Badge>
                ))
              ) : (
                <Badge variant="secondary">all events</Badge>
              )}
            </dd>
          </dl>
          {canUpdate && (
            <div className="flex flex-wrap gap-2">
              {canRotate && (
                <ConfirmDialog
                  trigger={
                    <Button size="sm" variant="outline">
                      <KeyRoundIcon />
                      Rotate signing secret
                    </Button>
                  }
                  title="Rotate the signing secret?"
                  description="A new secret is shown once. For 24 hours every delivery is signed with both the new and the previous secret, so your backend keeps accepting events while you switch it over. After that only the new secret signs."
                  confirmLabel="Rotate secret"
                  pendingLabel="Rotating…"
                  destructive
                  onConfirm={() => rotate.mutateAsync()}
                />
              )}
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="ghost">
                    <Trash2Icon />
                    Remove endpoint
                  </Button>
                }
                title="Remove the webhook endpoint?"
                description="Events are no longer delivered and pending deliveries are dropped. Creating an endpoint again issues a new secret."
                confirmLabel="Remove endpoint"
                pendingLabel="Removing…"
                destructive
                onConfirm={() => remove.mutateAsync()}
              />
            </div>
          )}
        </CardContent>
      )}
      <SecretOnceDialog
        secret={secret}
        title="Webhook signing secret"
        description="Store it in your backend to verify signatures. It is shown only once; rotate it if it is lost. The previous secret stops working now."
        onClose={() => setSecret(null)}
      />
    </Card>
  )
}
