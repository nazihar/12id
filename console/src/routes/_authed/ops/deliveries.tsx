import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { RouteError } from '@/components/route-error'
import { Button } from '@/components/ui/button'
import type { listDeliveriesAcrossTenants } from '@/features/ops/ops.functions'
import { deliveriesAcrossTenantsQuery } from '@/features/ops/ops.queries'
import { retryWebhookDelivery } from '@/features/tenant-data/tenant-data.functions'
import { formatDateTime } from '@/lib/format'

type DeliveryRow = Awaited<ReturnType<typeof listDeliveriesAcrossTenants>>[number]

const column = createColumnHelper<DataTableFeatures, DeliveryRow>()
const columns = column.columns([
  column.accessor('tenantId', {
    header: 'Tenant',
    cell: ({ getValue }) => (
      <Link to="/ops/tenants/$tenantId/webhooks" params={{ tenantId: getValue() }} className="font-mono text-xs hover:underline">
        {getValue().slice(0, 8)}
      </Link>
    ),
  }),
  column.accessor('eventType', { header: 'Event' }),
  column.accessor('attempts', { header: 'Attempts' }),
  column.accessor((row) => row.lastError ?? (row.lastStatusCode ? `HTTP ${row.lastStatusCode}` : ''), { id: 'lastResult', header: 'Last result' }),
  column.accessor('createdAt', { header: 'Created', cell: ({ getValue }) => formatDateTime(getValue()) }),
  column.display({ id: 'retry', header: '', cell: ({ row }) => <RetryButton tenantId={row.original.tenantId} deliveryId={row.original.id} /> }),
])

export const Route = createFileRoute('/_authed/ops/deliveries')({
  loader: ({ context }) => context.queryClient.ensureQueryData(deliveriesAcrossTenantsQuery()),
  errorComponent: RouteError,
  component: DeadDeliveriesPage,
})

function DeadDeliveriesPage() {
  const { data } = useSuspenseQuery(deliveriesAcrossTenantsQuery())
  return (
    <section className="space-y-3">
      <h1 className="font-heading text-lg font-medium">Dead webhook deliveries</h1>
      <p className="text-sm text-muted-foreground">Deliveries that exhausted their retries, across all tenants. Retrying queues one more attempt.</p>
      <DataTable columns={columns} data={data} searchPlaceholder="Search events or errors" emptyMessage="No dead deliveries." />
    </section>
  )
}

function RetryButton({ tenantId, deliveryId }: { tenantId: string; deliveryId: number }) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () => retryWebhookDelivery({ data: { tenantId, deliveryId } }),
    onSuccess: async () => {
      toast.success('Queued for another attempt.')
      await queryClient.invalidateQueries({ queryKey: ['ops', 'deliveries'] })
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <Button size="sm" variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending}>
      Retry
    </Button>
  )
}
