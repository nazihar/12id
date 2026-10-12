import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { useListPending } from '@/components/data-table/use-list-pending'
import { RouteError } from '@/components/route-error'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { exportTenantList } from '@/features/export/export.functions'
import { type DeliverySearch, deliverySearch } from '@/features/tenant-data/list.schemas'
import { DeliveriesPanel } from '@/features/tenant-data/panels'
import { getWebhookDelivery, retryWebhookDelivery } from '@/features/tenant-data/tenant-data.functions'
import { webhookDeliveriesQuery, webhookEndpointQuery } from '@/features/tenant-data/tenant-data.queries'
import { formatDateTime } from '@/lib/format'
import { parseListSearch, searchPatcher } from '@/lib/list-search'
import { useCanOperate } from '@/lib/use-can-operate'

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/webhooks')({
  validateSearch: parseListSearch(deliverySearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([context.queryClient.ensureQueryData(webhookEndpointQuery(params.tenantId)), context.queryClient.ensureQueryData(webhookDeliveriesQuery(params.tenantId, deps))]),
  errorComponent: RouteError,
  component: WebhooksPage,
})

function WebhooksPage() {
  const canOperate = useCanOperate()
  const { tenantId } = Route.useParams()
  const { data: endpoint } = useSuspenseQuery(webhookEndpointQuery(tenantId))
  const search = Route.useSearch()
  const onSearch = searchPatcher<DeliverySearch>(Route.useNavigate())
  const fetching = useListPending()
  const { data: deliveries } = useSuspenseQuery(webhookDeliveriesQuery(tenantId, search))
  return (
    <div className="space-y-6">
      <PageHeader title="Webhooks" />
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
        data={deliveries}
        search={search}
        onSearch={onSearch}
        fetching={fetching}
        invalidateKey={['ops', 'tenant', tenantId, 'webhook-deliveries']}
        loadBody={(deliveryId) => getWebhookDelivery({ data: { tenantId, deliveryId } })}
        revealBody={canOperate ? (deliveryId, revealReason) => getWebhookDelivery({ data: { tenantId, deliveryId, revealReason } }) : undefined}
        retryDelivery={canOperate ? (deliveryId) => retryWebhookDelivery({ data: { tenantId, deliveryId } }) : undefined}
        onExport={(format) => exportTenantList({ data: { tenantId, list: 'deliveries', format, search } })}
      />
    </div>
  )
}
