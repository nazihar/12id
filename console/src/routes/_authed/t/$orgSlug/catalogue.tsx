import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { ArchiveIcon, ArchiveRestoreIcon, FileBadgeIcon } from 'lucide-react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { IdentifierPair } from '@/components/identifier-pair'
import { PageHeader } from '@/components/page-header'
import { RouteError } from '@/components/route-error'
import { RowAction, RowActions } from '@/components/row-action'
import { StateBadge } from '@/components/state-badge'
import { Badge } from '@/components/ui/badge'
import { publishCredentialDefinition, setSchemaDeprecated } from '@/features/portal/portal-data.functions'
import { portalCataloguePageQuery, portalKey } from '@/features/portal/portal.queries'
import { CredentialDefinitionPolicyAction } from '@/features/portal/biometric-policy-dialog'
import { PublishSchemaDialog } from '@/features/portal/publish-schema-dialog'
import { SelectFilter } from '@/components/data-table/list-toolbar'
import { useListPending } from '@/components/data-table/use-list-pending'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type CatalogueSearch, catalogueSearch, catalogueStatusOptions } from '@/features/tenant-data/list.schemas'
import type { CredentialDefinitionRow, SchemaRow } from '@/features/tenant-data/types'
import { isFiltered, pagingFor, resetFor, parseListSearch, searchPatcher } from '@/lib/list-search'
import { canDo } from '@/lib/permissions'
import { announceHeld } from '@/lib/held'
import { PortalPendingChanges } from '@/features/approvals/pending-changes'

export const Route = createFileRoute('/_authed/t/$orgSlug/catalogue')({
  validateSearch: parseListSearch(catalogueSearch),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(portalCataloguePageQuery(params.orgSlug, deps)),
  errorComponent: RouteError,
  component: PortalCataloguePage,
})

const schemaColumn = createColumnHelper<DataTableFeatures, SchemaRow>()
const definitionColumn = createColumnHelper<DataTableFeatures, CredentialDefinitionRow>()
const definitionColumns = definitionColumn.columns([
  definitionColumn.accessor((row) => `${row.schemaName} ${row.schemaVersion}`, { id: 'schema', header: 'Schema' }),
  definitionColumn.accessor('tag', { header: 'Tag' }),
  definitionColumn.accessor('status', { header: 'Status', cell: ({ getValue }) => <StateBadge state={getValue()} /> }),
  definitionColumn.display({ id: 'ids', header: 'Identifiers', cell: ({ row }) => <IdentifierPair unqualified={row.original.credentialDefinitionId} qualified={row.original.qualifiedId} /> }),
])

function PortalCataloguePage() {
  const { orgSlug } = Route.useParams()
  const { organization } = Route.useRouteContext()
  const search = Route.useSearch()
  const onSearch = searchPatcher<CatalogueSearch>(Route.useNavigate())
  const fetching = useListPending()
  const { data } = useSuspenseQuery(portalCataloguePageQuery(orgSlug, search))
  const tab = search.tab ?? 'schemas'
  const canPublish = canDo(organization.permissions, { catalogue: ['publish'] })
  const canDeprecate = canDo(organization.permissions, { catalogue: ['deprecate'] })
  const canBiometrics = canDo(organization.permissions, { biometrics: ['update'] })
  // Phase 6: a face-check policy per credential definition (owners and admins).
  const definitionColumnsWithPolicy = canBiometrics
    ? [
        ...definitionColumns,
        definitionColumn.display({
          id: 'biometric',
          header: '',
          cell: ({ row }) => (
            <RowActions>
              <CredentialDefinitionPolicyAction credentialDefinitionId={row.original.id} label={`${row.original.schemaName} ${row.original.schemaVersion}`} organizationId={organization.id} orgSlug={orgSlug} />
            </RowActions>
          ),
        }),
      ]
    : definitionColumns
  const withDefinition = new Set(data.tab === 'schemas' ? data.withDefinition : [])

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
    schemaColumn.display({
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <SchemaActions
          schema={row.original}
          organizationId={organization.id}
          orgSlug={orgSlug}
          canPublishDefinition={canPublish && row.original.status === 'published' && !withDefinition.has(row.original.id)}
          canDeprecate={canDeprecate && (row.original.status === 'published' || row.original.status === 'deprecated')}
        />
      ),
    }),
  ])

  const common = {
    paging: pagingFor(data.page, onSearch),
    onReset: resetFor(search, onSearch),
    search: { value: search.q, placeholder: tab === 'schemas' ? 'Search schema name' : 'Search schema name or tag', onChange: (q: string | undefined) => onSearch({ q }) },
    toolbar: <SelectFilter label="Status" options={catalogueStatusOptions} value={search.status} onChange={(status) => onSearch({ status })} />,
    fetching,
  }

  return (
    <section className="space-y-4">
      <PageHeader
        title="Catalogue"
        description="The schemas and credential definitions this organization has published on the ledger, newest first. Offers and proof requests use the wire identifier. One credential definition per schema; publishing it lets your backend issue credentials of that schema."
        actions={canPublish && <PublishSchemaDialog organizationId={organization.id} orgSlug={orgSlug} />}
      />
      <PortalPendingChanges orgSlug={orgSlug} types={['catalogue.', 'biometrics.cred_def_policy']} />
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
        <DataTable columns={definitionColumnsWithPolicy} data={data.page.items} emptyMessage={isFiltered(search) ? 'No credential definitions match.' : 'No credential definitions published.'} testId="definitions-table" {...common} />
      )}
    </section>
  )
}

function SchemaActions({ schema, organizationId, orgSlug, canPublishDefinition, canDeprecate }: { schema: SchemaRow; organizationId: string; orgSlug: string; canPublishDefinition: boolean; canDeprecate: boolean }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'catalogue') })
  const define = useMutation({
    mutationFn: () => publishCredentialDefinition({ data: { organizationId, schemaId: schema.id, tag: 'default' } }),
    onSuccess: async (published) => {
      if (announceHeld(published, queryClient)) return
      toast.success(`Credential definition for ${schema.name} ${schema.version} published.`)
      await refresh()
    },
  })
  const deprecate = useMutation({
    mutationFn: (deprecated: boolean) => setSchemaDeprecated({ data: { organizationId, schemaId: schema.id, deprecated } }),
    onSuccess: async (_, deprecated) => {
      toast.success(deprecated ? `${schema.name} ${schema.version} no longer accepts new offers.` : `${schema.name} ${schema.version} is active again.`)
      await refresh()
    },
  })
  const label = `${schema.name} ${schema.version}`
  return (
    <RowActions>
      {canPublishDefinition && (
        <RowAction
          label="Publish credential definition"
          icon={FileBadgeIcon}
          confirm={{
            title: `Publish the credential definition for ${label}?`,
            description: 'Writes the definition on the ledger, which cannot be undone. Credentials of this schema can be issued afterwards; they expire instead of being revoked.',
            confirmLabel: 'Publish on the ledger',
            pendingLabel: 'Publishing…',
            onConfirm: () => define.mutateAsync(),
          }}
        />
      )}
      {canDeprecate &&
        (schema.status === 'deprecated' ? (
          <RowAction
            label="Reactivate"
            icon={ArchiveRestoreIcon}
            confirm={{
              title: `Reactivate ${label}?`,
              description: 'New credential offers with this schema are accepted again.',
              confirmLabel: 'Reactivate',
              onConfirm: () => deprecate.mutateAsync(false),
            }}
          />
        ) : (
          <RowAction
            label="Deprecate"
            icon={ArchiveIcon}
            confirm={{
              title: `Deprecate ${label}?`,
              description: 'New credential offers with this schema are refused. Credentials already issued stay valid, and proof templates that accept all versions keep working. You can reactivate it later.',
              confirmLabel: 'Deprecate',
              destructive: true,
              onConfirm: () => deprecate.mutateAsync(true),
            }}
          />
        ))}
    </RowActions>
  )
}
