import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useHydrated } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { IdentifierPair } from '@/components/identifier-pair'
import { RouteError } from '@/components/route-error'
import { StateBadge } from '@/components/state-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { publishCredentialDefinition, publishSchema, setSchemaDeprecated } from '@/features/portal/portal-data.functions'
import { portalCatalogueQuery, portalKey } from '@/features/portal/portal.queries'
import type { CredentialDefinitionRow, SchemaRow } from '@/features/tenant-data/types'
import { tenantCan } from '@/lib/permissions'
import { EXPIRY_ATTRIBUTE } from '@/lib/template-schema'

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
    <div className="space-y-6">
      {canPublish && <PublishSchemaCard organizationId={organization.id} orgSlug={orgSlug} />}
      <section className="space-y-2">
        <h2 className="font-heading font-medium">Schemas</h2>
        <DataTable columns={schemaColumns} data={data.schemas} searchPlaceholder="Search schemas" emptyMessage="No schemas published." testId="schemas-table" />
      </section>
      <section className="space-y-2">
        <h2 className="font-heading font-medium">Credential definitions</h2>
        <p className="text-sm text-muted-foreground">Offers and proof requests use the wire identifier.</p>
        <DataTable columns={definitionColumns} data={data.credentialDefinitions} emptyMessage="No credential definitions published." testId="definitions-table" />
      </section>
    </div>
  )
}

function SchemaActions({ schema, organizationId, orgSlug, canPublishDefinition, canDeprecate }: { schema: SchemaRow; organizationId: string; orgSlug: string; canPublishDefinition: boolean; canDeprecate: boolean }) {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'catalogue') })
  const define = useMutation({
    mutationFn: () => publishCredentialDefinition({ data: { organizationId, schemaId: schema.id, tag: 'default' } }),
    onSuccess: async () => {
      toast.success(`Credential definition for ${schema.name} ${schema.version} published.`)
      await refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const deprecate = useMutation({
    mutationFn: (deprecated: boolean) => setSchemaDeprecated({ data: { organizationId, schemaId: schema.id, deprecated } }),
    onSuccess: async (_, deprecated) => {
      toast.success(deprecated ? `${schema.name} ${schema.version} no longer accepts new offers.` : `${schema.name} ${schema.version} is active again.`)
      await refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <div className="flex flex-wrap gap-1">
      {canPublishDefinition && (
        <Button size="sm" variant="outline" onClick={() => define.mutate()} disabled={!hydrated || define.isPending}>
          {define.isPending ? 'Publishing…' : 'Publish credential definition'}
        </Button>
      )}
      {canDeprecate && (
        <Button size="sm" variant="ghost" onClick={() => deprecate.mutate(schema.status !== 'deprecated')} disabled={!hydrated || deprecate.isPending}>
          {schema.status === 'deprecated' ? 'Reactivate' : 'Deprecate'}
        </Button>
      )}
    </div>
  )
}

function PublishSchemaCard({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
  const hydrated = useHydrated()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const publish = useMutation({
    mutationFn: (input: { name: string; version: string; attributes: string[] }) => publishSchema({ data: { organizationId, ...input } }),
    onSuccess: async (schema) => {
      toast.success(`${schema.name} ${schema.version} published. Publish its credential definition to start issuing.`)
      setOpen(false)
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'catalogue') })
    },
  })

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const attributes = String(form.get('attributes'))
      .split(/[\s,]+/)
      .map((attribute) => attribute.trim())
      .filter((attribute) => attribute && attribute !== EXPIRY_ATTRIBUTE)
    publish.mutate({ name: String(form.get('name')).trim(), version: String(form.get('version')).trim(), attributes: [...new Set(attributes)] })
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)} disabled={!hydrated}>
        Publish a schema
      </Button>
    )
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Publish a schema</CardTitle>
        <CardDescription>
          Schemas are public and permanent on the ledger: you cannot add or rename attributes later, only publish a new version. Values are strings; attributes used in predicates must hold whole
          numbers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" onSubmit={onSubmit}>
          <FieldGroup>
            {publish.error && (
              <Alert variant="destructive">
                <AlertDescription>{publish.error.message}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <Field>
                <FieldLabel htmlFor="schema-name">Name</FieldLabel>
                <Input id="schema-name" name="name" placeholder="employee-badge" maxLength={200} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="schema-version">Version</FieldLabel>
                <Input id="schema-version" name="version" defaultValue="1.0" pattern="\d+(\.\d+){0,2}" required />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="schema-attributes">Attributes</FieldLabel>
              <textarea
                id="schema-attributes"
                name="attributes"
                rows={4}
                required
                placeholder={'name\ndepartment\nemployeeNumber'}
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm"
              />
              <FieldDescription>One per line or separated by commas. {EXPIRY_ATTRIBUTE} (epoch seconds) is added to every schema: credentials expire instead of being revoked.</FieldDescription>
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={!hydrated || publish.isPending}>
                {publish.isPending ? 'Publishing on the ledger…' : 'Publish schema'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
