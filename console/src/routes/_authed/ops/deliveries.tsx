import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { RotateCwIcon } from 'lucide-react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { RowAction, RowActions } from '@/components/row-action'
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
  column.display({ id: 'retry', header: '', cell: ({ row }) => <RetryAction tenantId={row.original.tenantId} delivery={row.original} /> }),
])

export const Route = createFileRoute('/_authed/ops/deliveries')({
  loader: ({ context }) => context.queryClient.ensureQueryData(deliveriesAcrossTenantsQuery()),
  errorComponent: RouteError,
  component: DeadDeliveriesPage,
})

function DeadDeliveriesPage() {
  const { data } = useSuspenseQuery(deliveriesAcrossTenantsQuery())
  return (
    <section className="space-y-4">
      <PageHeader title="Dead webhook deliveries" description="Deliveries that exhausted their retries, across all tenants. Retrying queues one more attempt." />
      <DataTable columns={columns} data={data} searchPlaceholder="Search events or errors" emptyMessage="No dead deliveries." />
    </section>
  )
}

function RetryAction({ tenantId, delivery }: { tenantId: string; delivery: DeliveryRow }) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () => retryWebhookDelivery({ data: { tenantId, deliveryId: delivery.id } }),
    onSuccess: async () => {
      toast.success('Queued for another attempt.')
      await queryClient.invalidateQueries({ queryKey: ['ops', 'deliveries'] })
    },
  })
  return (
    <RowActions>
      <RowAction
        label="Retry"
        icon={RotateCwIcon}
        confirm={{
          title: `Retry delivery ${delivery.id}?`,
          description: `The ${delivery.eventType} event is sent again to the tenant's endpoint, with the same signed body.`,
          confirmLabel: 'Retry',
          onConfirm: () => retry.mutateAsync(),
        }}
      />
    </RowActions>
  )
}
