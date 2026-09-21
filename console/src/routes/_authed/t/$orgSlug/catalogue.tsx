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
import { portalCatalogueQuery, portalKey } from '@/features/portal/portal.queries'
import { CredentialDefinitionPolicyAction } from '@/features/portal/biometric-policy-dialog'
import { PublishSchemaDialog } from '@/features/portal/publish-schema-dialog'
import type { CredentialDefinitionRow, SchemaRow } from '@/features/tenant-data/types'
import { tenantCan } from '@/lib/permissions'

export const Route = createFileRoute('/_authed/t/$orgSlug/catalogue')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(portalCatalogueQuery(params.orgSlug)),
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
  const { data } = useSuspenseQuery(portalCatalogueQuery(orgSlug))
  const canPublish = tenantCan(organization.role, { catalogue: ['publish'] })
  const canDeprecate = tenantCan(organization.role, { catalogue: ['deprecate'] })
  const canBiometrics = tenantCan(organization.role, { biometrics: ['update'] })
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
  const withDefinition = new Set(data.credentialDefinitions.map((definition) => definition.schemaId))

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

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <PageHeader
          title="Catalogue"
          description="The schemas and credential definitions this organization has published on the ledger. Offers and proof requests use the wire identifier."
          actions={canPublish && <PublishSchemaDialog organizationId={organization.id} orgSlug={orgSlug} />}
        />
        <DataTable columns={schemaColumns} data={data.schemas} searchPlaceholder="Search schemas" emptyMessage="No schemas published." testId="schemas-table" />
      </section>
      <section className="space-y-3">
        <PageHeader level={2} title="Credential definitions" description="One per schema; publishing it lets your backend issue credentials of that schema." />
        <DataTable columns={definitionColumnsWithPolicy} data={data.credentialDefinitions} emptyMessage="No credential definitions published." testId="definitions-table" />
      </section>
    </div>
  )
}

function SchemaActions({ schema, organizationId, orgSlug, canPublishDefinition, canDeprecate }: { schema: SchemaRow; organizationId: string; orgSlug: string; canPublishDefinition: boolean; canDeprecate: boolean }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'catalogue') })
  const define = useMutation({
    mutationFn: () => publishCredentialDefinition({ data: { organizationId, schemaId: schema.id, tag: 'default' } }),
    onSuccess: async () => {
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
