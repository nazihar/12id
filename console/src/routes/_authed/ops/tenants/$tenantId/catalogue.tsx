import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { IdentifierPair } from '@/components/identifier-pair'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Badge } from '@/components/ui/badge'
import type { getCatalogue } from '@/features/tenant-data/tenant-data.functions'
import { catalogueQuery } from '@/features/tenant-data/tenant-data.queries'

type Catalogue = Awaited<ReturnType<typeof getCatalogue>>
type SchemaRow = Catalogue['schemas'][number]
type CredentialDefinitionRow = Catalogue['credentialDefinitions'][number]

const schemaColumn = createColumnHelper<DataTableFeatures, SchemaRow>()
const schemaColumns = schemaColumn.columns([
  schemaColumn.accessor('name', { header: 'Schema' }),
  schemaColumn.accessor('version', { header: 'Version' }),
  schemaColumn.accessor('status', { header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  schemaColumn.display({
    id: 'attributes',
    header: 'Attributes',
    cell: ({ row }) => (
      <div className="flex max-w-sm flex-wrap gap-1">
        {(row.original.attributes ?? []).map((attribute) => (
          <Badge key={attribute} variant="outline">
            {attribute}
          </Badge>
        ))}
      </div>
    ),
  }),
  schemaColumn.display({ id: 'ids', header: 'Identifiers', cell: ({ row }) => <IdentifierPair unqualified={row.original.schemaId} qualified={row.original.qualifiedId} /> }),
])

const definitionColumn = createColumnHelper<DataTableFeatures, CredentialDefinitionRow>()
const definitionColumns = definitionColumn.columns([
  definitionColumn.accessor((row) => `${row.schemaName} ${row.schemaVersion}`, { id: 'schema', header: 'Schema' }),
  definitionColumn.accessor('tag', { header: 'Tag' }),
  definitionColumn.accessor('status', { header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  definitionColumn.display({ id: 'ids', header: 'Identifiers', cell: ({ row }) => <IdentifierPair unqualified={row.original.credentialDefinitionId} qualified={row.original.qualifiedId} /> }),
])

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/catalogue')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(catalogueQuery(params.tenantId)),
  errorComponent: RouteError,
  component: CataloguePage,
})

function CataloguePage() {
  const { tenantId } = Route.useParams()
  const { data } = useSuspenseQuery(catalogueQuery(tenantId))
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <PageHeader level={2} title="Schemas" description="Offers and proof requests use the wire identifier. Publishing happens in the tenant portal." />
        <DataTable columns={schemaColumns} data={data.schemas} searchPlaceholder="Search schemas" emptyMessage="No schemas published." />
      </section>
      <section className="space-y-3">
        <PageHeader level={2} title="Credential definitions" />
        <DataTable columns={definitionColumns} data={data.credentialDefinitions} emptyMessage="No credential definitions published." />
      </section>
    </div>
  )
}
