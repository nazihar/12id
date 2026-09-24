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
import { SelectFilter } from '@/components/data-table/list-toolbar'
import { useListPending } from '@/components/data-table/use-list-pending'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type CatalogueSearch, catalogueSearch, catalogueStatusOptions } from '@/features/tenant-data/list.schemas'
import { catalogueQuery } from '@/features/tenant-data/tenant-data.queries'
import type { CredentialDefinitionRow, SchemaRow } from '@/features/tenant-data/types'
import { isFiltered, pagingFor, resetFor, parseListSearch, searchPatcher } from '@/lib/list-search'

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
  validateSearch: parseListSearch(catalogueSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(catalogueQuery(params.tenantId, deps)),
  errorComponent: RouteError,
  component: CataloguePage,
})

function CataloguePage() {
  const { tenantId } = Route.useParams()
  const search = Route.useSearch()
  const onSearch = searchPatcher<CatalogueSearch>(Route.useNavigate())
  const fetching = useListPending()
  const { data } = useSuspenseQuery(catalogueQuery(tenantId, search))
  const tab = search.tab ?? 'schemas'
  const common = {
    paging: pagingFor(data.page, onSearch),
    onReset: resetFor(search, onSearch),
    search: { value: search.q, placeholder: tab === 'schemas' ? 'Search schema name' : 'Search schema name or tag', onChange: (q: string | undefined) => onSearch({ q }) },
    toolbar: <SelectFilter label="Status" options={catalogueStatusOptions} value={search.status} onChange={(status) => onSearch({ status })} />,
    fetching,
  }
  return (
    <section className="space-y-4">
      <PageHeader title="Catalogue" description="Newest first. Offers and proof requests use the wire identifier. Publishing happens in the tenant portal." />
      <Tabs value={tab} onValueChange={(next) => onSearch({ tab: next === 'schemas' ? undefined : 'definitions', q: undefined, status: undefined })}>
        <TabsList>
          <TabsTrigger value="schemas">Schemas</TabsTrigger>
          <TabsTrigger value="definitions">Credential definitions</TabsTrigger>
        </TabsList>
      </Tabs>
      {data.tab !== tab ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.tab === 'schemas' ? (
        <DataTable columns={schemaColumns} data={data.page.items} emptyMessage={isFiltered(search) ? 'No schemas match.' : 'No schemas published.'} testId="schemas-table" {...common} />
      ) : (
        <DataTable columns={definitionColumns} data={data.page.items} emptyMessage={isFiltered(search) ? 'No credential definitions match.' : 'No credential definitions published.'} testId="definitions-table" {...common} />
      )}
    </section>
  )
}
