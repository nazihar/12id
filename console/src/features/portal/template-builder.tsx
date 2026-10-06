import { useBlocker } from '@tanstack/react-router'
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import { type ChoiceOption, ComboboxControl, Form, formValidation, toErrors, useAppForm } from '@/components/form/form'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import type { SchemaRow } from '@/features/tenant-data/types'
import { EXPIRY_ATTRIBUTE, PREDICATE_TYPES, type TemplateDefinition, type TemplateFormValues, type TemplatePredicate, templateDefinitionForm } from '@/lib/template-schema'

type PredicateType = TemplatePredicate['type']
type GroupValues = TemplateFormValues['groups'][number]
type CredentialRef = GroupValues['credentials'][number]

const PREDICATE_OPTIONS: ChoiceOption<PredicateType>[] = PREDICATE_TYPES.map((type) => ({ value: type, label: type }))
const VERSION_OPTIONS: ChoiceOption<'all' | 'active'>[] = [
  { value: 'all', label: 'all versions', description: 'credentials issued under a deprecated version stay valid' },
  { value: 'active', label: 'active versions only' },
]

function describeRef(ref: CredentialRef) {
  return 'schemaName' in ref ? `${ref.schemaName} · ${ref.versions === 'active' ? 'active versions' : 'all versions'}` : `definition ${ref.credentialDefinitionId}`
}

function toValues(schemas: SchemaRow[], initial?: TemplateDefinition): TemplateFormValues {
  if (initial) {
    return {
      name: initial.name,
      groups: initial.groups.map((group) => ({ key: group.key, credentials: group.credentials, attributes: group.attributes, predicates: group.predicates ?? [] })),
    }
  }
  const firstSchema = [...new Set(schemas.map((schema) => schema.name))].sort()[0]
  return { name: '', groups: [{ key: 'credential', credentials: firstSchema ? [{ schemaName: firstSchema, versions: 'all' }] : [], attributes: [], predicates: [] }] }
}

function toDefinition(values: TemplateFormValues): TemplateDefinition {
  const parsed = templateDefinitionForm.parse(values)
  return { ...parsed, groups: parsed.groups.map((group) => ({ ...group, predicates: group.predicates.length > 0 ? group.predicates : undefined })) }
}

function useTemplateForm(defaultValues: TemplateFormValues, onSubmit: (values: TemplateFormValues) => Promise<void>) {
  return useAppForm({
    defaultValues,
    validationLogic: formValidation,
    validators: { onDynamic: templateDefinitionForm },
    onSubmit: ({ value }) => onSubmit(value),
  })
}
type TemplateForm = ReturnType<typeof useTemplateForm>

/**
 * Builds a proof request template: which credential types each group accepts, which attributes are
 * disclosed, and which integer predicates apply. `expiresOn >= today` is added to every group by the
 * platform and cannot be disclosed or edited. Every rule is checked on submit and shown at the field
 * it concerns; leaving with unsaved changes asks first.
 */
export function TemplateBuilder({
  schemas,
  initial,
  submitLabel,
  error,
  onSubmit,
  onCancel,
}: {
  schemas: SchemaRow[]
  initial?: TemplateDefinition
  submitLabel: string
  error?: Error | null
  /** Resolves once saved; a rejection is shown through `error` and keeps the page. */
  onSubmit: (definition: TemplateDefinition) => Promise<unknown>
  onCancel: () => void
}) {
  const schemaNames = [...new Set(schemas.map((schema) => schema.name))].sort()
  const saved = useRef(false)
  const form = useTemplateForm(toValues(schemas, initial), async (values) => {
    // Marked before the call: the page navigates away from inside `onSubmit` once saved, and the
    // unsaved-changes guard must not stop that. A failure un-marks it.
    saved.current = true
    try {
      await onSubmit(toDefinition(values))
    } catch {
      saved.current = false // shown through the `error` prop
    }
  })

  const attributesFor = (group: GroupValues) => {
    const names = new Set(group.credentials.flatMap((ref) => ('schemaName' in ref ? schemas.filter((s) => s.name === ref.schemaName).flatMap((s) => s.attributes ?? []) : [])))
    names.delete(EXPIRY_ATTRIBUTE)
    return [...names].sort()
  }

  return (
    <Form form={form} data-testid="template-builder" className="gap-5">
      <UnsavedChangesGuard isDirty={() => form.state.isDirty && !saved.current} />
      <form.FormError error={error} />
      <form.AppField name="name">{(field) => <field.TextField label="Template name" description="Shown to the holder in their wallet app as the request title." className="max-w-md" autoFocus={!initial} />}</form.AppField>

      <form.AppField name="groups" mode="array">
        {(groupsField) => (
          <div className="flex flex-col gap-4">
            <FieldError errors={toErrors(groupsField.state.meta.errors)} />
            {groupsField.state.value.map((_, index) => (
              <form.Subscribe key={index} selector={(state) => state.values.groups[index]}>
                {(group) => {
                  const available = attributesFor(group)
                  const disclosed = new Set(group.attributes)
                  const predicated = new Set(group.predicates.map((p) => p.name))
                  const free = available.filter((attribute) => !disclosed.has(attribute))
                  const nextPredicate = free.find((attribute) => !predicated.has(attribute))
                  return (
                    <Card size="sm">
                      <CardHeader>
                        <CardTitle>Requested credential {index + 1}</CardTitle>
                        <CardDescription>The holder presents one credential matching this group.</CardDescription>
                        {groupsField.state.value.length > 1 && (
                          <CardAction>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove requested credential ${index + 1}`} onClick={() => groupsField.removeValue(index)}>
                              <Trash2Icon />
                            </Button>
                          </CardAction>
                        )}
                      </CardHeader>
                      <CardContent className="flex flex-col gap-5">
                        <form.AppField name={`groups[${index}].key`}>{(field) => <field.TextField label="Key" description="Name of this part of the response, e.g. employee." className="max-w-xs" />}</form.AppField>

                        <form.AppField name={`groups[${index}].credentials`} mode="array">
                          {(field) => (
                            <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                              <FieldLabel>Accepted credentials</FieldLabel>
                              {field.state.value.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {field.state.value.map((ref, refIndex) => (
                                    <Badge key={refIndex} variant="outline" className="gap-1 pr-1">
                                      {describeRef(ref)}
                                      <button type="button" className="rounded-sm opacity-60 hover:opacity-100" aria-label="Remove credential type" onClick={() => field.removeValue(refIndex)}>
                                        <XIcon className="size-3" />
                                      </button>
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              <AddCredentialRef schemaNames={schemaNames} onAdd={(ref) => field.pushValue(ref)} />
                              <FieldDescription>"All versions" keeps credentials issued under a deprecated schema version valid.</FieldDescription>
                              <FieldError errors={toErrors(field.state.meta.errors)} />
                            </Field>
                          )}
                        </form.AppField>

                        <form.AppField name={`groups[${index}].attributes`}>
                          {(field) => (
                            <field.CheckboxGroupField
                              label="Disclosed attributes"
                              emptyMessage="Choose a credential type first."
                              options={available.map((attribute) => ({ value: attribute, label: attribute, disabled: predicated.has(attribute), description: predicated.has(attribute) ? 'used in a predicate' : undefined }))}
                            />
                          )}
                        </form.AppField>

                        <form.AppField name={`groups[${index}].predicates`} mode="array">
                          {(field) => (
                            <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                              <FieldLabel>Predicates</FieldLabel>
                              <FieldDescription>Integer comparisons the holder proves without revealing the value. {EXPIRY_ATTRIBUTE} ≥ today is always checked and never disclosed.</FieldDescription>
                              {field.state.value.map((predicate, predicateIndex) => (
                                <PredicateRow
                                  key={predicateIndex}
                                  form={form}
                                  groupIndex={index}
                                  predicateIndex={predicateIndex}
                                  attributes={free.filter((a) => a === predicate.name || !predicated.has(a))}
                                  onRemove={() => field.removeValue(predicateIndex)}
                                />
                              ))}
                              <div>
                                <Button type="button" variant="outline" size="sm" disabled={!nextPredicate} onClick={() => nextPredicate && field.pushValue({ name: nextPredicate, type: '>=', value: 0 })}>
                                  <PlusIcon />
                                  Add predicate
                                </Button>
                              </div>
                              <FieldError errors={toErrors(field.state.meta.errors)} />
                            </Field>
                          )}
                        </form.AppField>
                      </CardContent>
                    </Card>
                  )
                }}
              </form.Subscribe>
            ))}
            <div>
              <Button type="button" variant="outline" onClick={() => groupsField.pushValue({ key: `credential${groupsField.state.value.length + 1}`, credentials: [], attributes: [], predicates: [] })}>
                <PlusIcon />
                Request another credential
              </Button>
            </div>
          </div>
        )}
      </form.AppField>

      <div className="flex gap-2">
        <form.SubmitButton pendingLabel="Saving…">{submitLabel}</form.SubmitButton>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Form>
  )
}

function PredicateRow({ form, groupIndex, predicateIndex, attributes, onRemove }: { form: TemplateForm; groupIndex: number; predicateIndex: number; attributes: string[]; onRemove: () => void }) {
  const base = `groups[${groupIndex}].predicates[${predicateIndex}]` as const
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(10rem,2fr)_minmax(6rem,1fr)_minmax(6rem,1fr)_auto] sm:items-start">
      <form.AppField name={`${base}.name`}>{(field) => <field.ComboboxField label="Attribute" options={attributes.map((attribute) => ({ value: attribute, label: attribute }))} />}</form.AppField>
      <form.AppField name={`${base}.type`}>{(field) => <field.ComboboxField label="Comparison" options={PREDICATE_OPTIONS} />}</form.AppField>
      <form.AppField name={`${base}.value`}>{(field) => <field.NumberField label="Value" />}</form.AppField>
      <Button type="button" variant="ghost" size="icon-sm" className="sm:mt-6" aria-label="Remove predicate" onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </div>
  )
}

function AddCredentialRef({ schemaNames, onAdd }: { schemaNames: string[]; onAdd: (ref: CredentialRef) => void }) {
  const [schemaName, setSchemaName] = useState<string>(schemaNames[0] ?? '')
  const [versions, setVersions] = useState<'all' | 'active' | ''>('all')
  if (schemaNames.length === 0) return <p className="text-sm text-muted-foreground">Publish a schema first.</p>
  const options = schemaNames.map((name) => ({ value: name, label: name }))
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ComboboxControl aria-label="Schema" options={options} value={schemaName} onChange={setSchemaName} className="w-56" />
      <ComboboxControl aria-label="Schema versions" options={VERSION_OPTIONS} value={versions} onChange={setVersions} className="w-44" />
      <Button type="button" variant="outline" size="sm" disabled={!schemaName || !versions} onClick={() => schemaName && versions && onAdd({ schemaName, versions })}>
        Add
      </Button>
    </div>
  )
}

/** Blocks navigation away from unsaved changes, with a confirmation dialog. */
function UnsavedChangesGuard({ isDirty }: { isDirty: () => boolean }) {
  const blocker = useBlocker({ shouldBlockFn: () => isDirty(), withResolver: true, enableBeforeUnload: isDirty })
  const blocked = blocker.status === 'blocked'
  return (
    <AlertDialog open={blocked} onOpenChange={(open) => !open && blocked && blocker.reset()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>The template has changes that are not saved. Leaving this page discards them.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => blocked && blocker.proceed()}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
