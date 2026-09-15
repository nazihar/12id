import { useHydrated } from '@tanstack/react-router'
import { PlusIcon, XIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { SchemaRow } from '@/features/tenant-data/types'
import { EXPIRY_ATTRIBUTE, type TemplateCredentialRef, type TemplateDefinition, type TemplatePredicate, templateProblems } from '@/lib/template-schema'

interface GroupState {
  key: string
  credentials: TemplateCredentialRef[]
  attributes: string[]
  predicates: TemplatePredicate[]
}

const nativeSelect = 'h-8 rounded-lg border border-input bg-transparent px-2 text-sm'
const PREDICATE_TYPES = ['>=', '>', '<=', '<'] as const

function describeRef(ref: TemplateCredentialRef) {
  return 'schemaName' in ref ? `${ref.schemaName} · ${ref.versions === 'active' ? 'active versions' : 'all versions'}` : `definition ${ref.credentialDefinitionId}`
}

/**
 * Builds a proof request template: which credential types each group accepts, which attributes are
 * disclosed, and which integer predicates apply. `expiresAt >= now` is added to every group by the
 * platform and cannot be disclosed or edited.
 */
export function TemplateBuilder({
  schemas,
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  schemas: SchemaRow[]
  initial?: TemplateDefinition
  submitLabel: string
  pending: boolean
  error?: string
  onSubmit: (definition: TemplateDefinition) => void
  onCancel: () => void
}) {
  const hydrated = useHydrated()
  const schemaNames = [...new Set(schemas.map((schema) => schema.name))].sort()
  const [name, setName] = useState(initial?.name ?? '')
  const [groups, setGroups] = useState<GroupState[]>(
    initial?.groups.map((group) => ({ key: group.key, credentials: group.credentials, attributes: group.attributes, predicates: group.predicates ?? [] })) ?? [
      { key: 'credential', credentials: schemaNames[0] ? [{ schemaName: schemaNames[0], versions: 'all' }] : [], attributes: [], predicates: [] },
    ]
  )
  const [problems, setProblems] = useState<string[]>([])

  const update = (index: number, change: Partial<GroupState>) => setGroups((current) => current.map((group, i) => (i === index ? { ...group, ...change } : group)))

  const attributesFor = (group: GroupState) => {
    const names = new Set(group.credentials.flatMap((ref) => ('schemaName' in ref ? schemas.filter((s) => s.name === ref.schemaName).flatMap((s) => s.attributes ?? []) : [])))
    names.delete(EXPIRY_ATTRIBUTE)
    return [...names].sort()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const definition: TemplateDefinition = {
      name: name.trim(),
      groups: groups.map((group) => ({ key: group.key.trim(), credentials: group.credentials, attributes: group.attributes, predicates: group.predicates.length > 0 ? group.predicates : undefined })),
    }
    const found = templateProblems(definition)
    setProblems(found)
    if (found.length === 0) onSubmit(definition)
  }

  return (
    <form method="post" onSubmit={submit} className="space-y-4" data-testid="template-builder">
      <Field className="max-w-md">
        <FieldLabel htmlFor="template-name">Template name</FieldLabel>
        <Input id="template-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
        <FieldDescription>Shown to the holder in their wallet app as the request title.</FieldDescription>
      </Field>

      {groups.map((group, index) => {
        const available = attributesFor(group)
        return (
          <Card key={index} size="sm">
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle>Requested credential {index + 1}</CardTitle>
              {groups.length > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setGroups((current) => current.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field className="max-w-xs">
                  <FieldLabel htmlFor={`group-key-${index}`}>Key</FieldLabel>
                  <Input id={`group-key-${index}`} value={group.key} onChange={(event) => update(index, { key: event.target.value })} maxLength={50} required />
                  <FieldDescription>Name of this part of the response, e.g. employee.</FieldDescription>
                </Field>

                <Field>
                  <FieldLabel>Accepted credentials</FieldLabel>
                  <div className="flex flex-wrap gap-1">
                    {group.credentials.map((ref, refIndex) => (
                      <Badge key={refIndex} variant="outline" className="gap-1">
                        {describeRef(ref)}
                        <button type="button" aria-label="Remove credential type" onClick={() => update(index, { credentials: group.credentials.filter((_, i) => i !== refIndex) })}>
                          <XIcon />
                        </button>
                      </Badge>
                    ))}
                  </div>
                  <AddCredentialRef schemaNames={schemaNames} onAdd={(ref) => update(index, { credentials: [...group.credentials, ref] })} />
                  <FieldDescription>"All versions" keeps credentials issued under a deprecated schema version valid.</FieldDescription>
                </Field>

                <Field>
                  <FieldLabel>Disclosed attributes</FieldLabel>
                  {available.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Choose a credential type first.</p>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      {available.map((attribute) => {
                        const predicated = group.predicates.some((p) => p.name === attribute)
                        return (
                          <label key={attribute} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              checked={group.attributes.includes(attribute)}
                              disabled={predicated}
                              onChange={(event) => update(index, { attributes: event.target.checked ? [...group.attributes, attribute] : group.attributes.filter((a) => a !== attribute) })}
                            />
                            {attribute}
                          </label>
                        )
                      })}
                    </div>
                  )}
                </Field>

                <Field>
                  <FieldLabel>Predicates (integer attributes, value stays hidden)</FieldLabel>
                  {group.predicates.map((predicate, predicateIndex) => (
                    <div key={predicateIndex} className="flex flex-wrap items-center gap-2">
                      <select
                        className={nativeSelect}
                        value={predicate.name}
                        onChange={(event) => update(index, { predicates: group.predicates.map((p, i) => (i === predicateIndex ? { ...p, name: event.target.value } : p)) })}
                        aria-label="Predicate attribute"
                      >
                        {available
                          .filter((attribute) => attribute === predicate.name || !group.attributes.includes(attribute))
                          .map((attribute) => (
                            <option key={attribute} value={attribute}>
                              {attribute}
                            </option>
                          ))}
                      </select>
                      <select
                        className={nativeSelect}
                        value={predicate.type}
                        onChange={(event) => update(index, { predicates: group.predicates.map((p, i) => (i === predicateIndex ? { ...p, type: event.target.value as TemplatePredicate['type'] } : p)) })}
                        aria-label="Predicate comparison"
                      >
                        {PREDICATE_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                      <Input
                        type="number"
                        step={1}
                        className="w-32"
                        value={Number.isFinite(predicate.value) ? predicate.value : ''}
                        onChange={(event) => update(index, { predicates: group.predicates.map((p, i) => (i === predicateIndex ? { ...p, value: Number.parseInt(event.target.value, 10) } : p)) })}
                        aria-label="Predicate value"
                      />
                      <Button type="button" variant="ghost" size="sm" onClick={() => update(index, { predicates: group.predicates.filter((_, i) => i !== predicateIndex) })}>
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={available.filter((a) => !group.attributes.includes(a)).length === 0}
                      onClick={() => {
                        const first = available.find((a) => !group.attributes.includes(a) && !group.predicates.some((p) => p.name === a))
                        if (first) update(index, { predicates: [...group.predicates, { name: first, type: '>=', value: 0 }] })
                      }}
                    >
                      <PlusIcon />
                      Add predicate
                    </Button>
                  </div>
                  <FieldDescription>{EXPIRY_ATTRIBUTE} ≥ now is always checked and never disclosed.</FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        )
      })}

      <Button type="button" variant="outline" onClick={() => setGroups((current) => [...current, { key: `credential${current.length + 1}`, credentials: [], attributes: [], predicates: [] }])}>
        <PlusIcon />
        Request another credential
      </Button>

      {(problems.length > 0 || error) && (
        <Alert variant="destructive">
          <AlertDescription>
            <ul className="list-disc pl-4" data-testid="template-problems">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
              {error && <li>{error}</li>}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={!hydrated || pending}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function AddCredentialRef({ schemaNames, onAdd }: { schemaNames: string[]; onAdd: (ref: TemplateCredentialRef) => void }) {
  const [schemaName, setSchemaName] = useState(schemaNames[0] ?? '')
  const [versions, setVersions] = useState<'all' | 'active'>('all')
  if (schemaNames.length === 0) return <p className="text-sm text-muted-foreground">Publish a schema first.</p>
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={nativeSelect} value={schemaName} onChange={(event) => setSchemaName(event.target.value)} aria-label="Schema">
        {schemaNames.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <select className={nativeSelect} value={versions} onChange={(event) => setVersions(event.target.value as 'all' | 'active')} aria-label="Schema versions">
        <option value="all">all versions</option>
        <option value="active">active versions only</option>
      </select>
      <Button type="button" variant="outline" size="sm" onClick={() => onAdd({ schemaName, versions })}>
        Add
      </Button>
    </div>
  )
}
