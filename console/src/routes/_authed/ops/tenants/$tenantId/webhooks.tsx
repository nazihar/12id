import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { RouteError } from '@/components/route-error'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DeliveriesPanel } from '@/features/tenant-data/panels'
import { getWebhookDelivery, retryWebhookDelivery } from '@/features/tenant-data/tenant-data.functions'
import { webhookDeliveriesQuery, webhookEndpointQuery } from '@/features/tenant-data/tenant-data.queries'
import { formatDateTime } from '@/lib/format'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/webhooks')({
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(webhookEndpointQuery(params.tenantId)), context.queryClient.ensureQueryData(webhookDeliveriesQuery(params.tenantId))]),
  errorComponent: RouteError,
  component: WebhooksPage,
})

function WebhooksPage() {
  const { tenantId } = Route.useParams()
  const { data: endpoint } = useSuspenseQuery(webhookEndpointQuery(tenantId))
  return (
    <div className="space-y-5">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Endpoint</CardTitle>
          <CardDescription>The signing secret is never shown here; the tenant rotates it in the portal or through the API.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {endpoint ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">URL</dt>
              <dd className="font-mono text-xs break-all">{endpoint.url}</dd>
              <dt className="text-muted-foreground">Events</dt>
              <dd>{endpoint.events?.join(', ') ?? 'all events'}</dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatDateTime(endpoint.updatedAt)}</dd>
            </dl>
          ) : (
            <p className="text-muted-foreground">No webhook endpoint configured.</p>
          )}
        </CardContent>
      </Card>
      <DeliveriesPanel
        queryFor={(status) => webhookDeliveriesQuery(tenantId, status)}
        invalidateKey={['ops', 'tenant', tenantId, 'webhook-deliveries']}
        loadBody={(deliveryId) => getWebhookDelivery({ data: { tenantId, deliveryId } })}
        retryDelivery={(deliveryId) => retryWebhookDelivery({ data: { tenantId, deliveryId } })}
      />
    </div>
  )
}
