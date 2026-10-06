import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import type { listProofTemplates } from '@/features/tenant-data/tenant-data.functions'
import { useListPending } from '@/components/data-table/use-list-pending'
import { type TemplateSearch, templateSearch } from '@/features/tenant-data/list.schemas'
import { proofTemplatesQuery } from '@/features/tenant-data/tenant-data.queries'
import { isFiltered, pagingFor, resetFor, parseListSearch, searchPatcher } from '@/lib/list-search'
import { formatDateTime } from '@/lib/format'

type TemplateRow = Awaited<ReturnType<typeof listProofTemplates>>['items'][number]
type Group = TemplateRow['definition']['groups'][number]

function describeCredentials(group: Group) {
  return group.credentials.map((ref) => ('schemaName' in ref ? `${ref.schemaName} (${ref.versions === 'active' ? 'active versions' : 'all versions'})` : ref.credentialDefinitionId)).join(', ')
}

const column = createColumnHelper<DataTableFeatures, TemplateRow>()
const columns = column.columns([
  column.accessor('name', { header: 'Template' }),
  column.display({
    id: 'groups',
    header: 'Requests',
    cell: ({ row }) => (
      <ul className="space-y-1 text-xs">
        {row.original.definition.groups.map((group) => (
          <li key={group.key}>
            <span className="font-medium">{group.key}</span> from {describeCredentials(group)}
            {group.attributes.length > 0 && <> · discloses {group.attributes.join(', ')}</>}
            {group.predicates?.map((p) => (
              <span key={`${p.name}${p.type}${p.value}`}>
                {' '}
                · {p.name} {p.type} {p.value}
              </span>
            ))}
            <span className="text-muted-foreground"> · expiresOn checked</span>
          </li>
        ))}
      </ul>
    ),
  }),
  column.accessor('updatedAt', { header: 'Updated', cell: ({ getValue }) => formatDateTime(getValue()) }),
])

export const Route = createFileRoute('/_authed/ops/tenants/$tenantId/templates')({
  validateSearch: parseListSearch(templateSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(proofTemplatesQuery(params.tenantId, deps)),
  errorComponent: RouteError,
  component: TemplatesPage,
})

function TemplatesPage() {
  const { tenantId } = Route.useParams()
  const search = Route.useSearch()
  const onSearch = searchPatcher<TemplateSearch>(Route.useNavigate())
  const { data } = useSuspenseQuery(proofTemplatesQuery(tenantId, search))
  return (
    <section className="space-y-4">
      <PageHeader title="Proof templates" description="What the tenant's backend can ask holders to prove. Templates are edited in the tenant portal." />
      <DataTable
        columns={columns}
        data={data.items}
        paging={pagingFor(data, onSearch)}
        onReset={resetFor(search, onSearch)}
        search={{ value: search.q, placeholder: 'Search template name', onChange: (q) => onSearch({ q }) }}
        fetching={useListPending()}
        emptyMessage={isFiltered(search) ? 'No proof templates match.' : 'No proof templates.'}
        testId="templates-table"
      />
    </section>
  )
}
