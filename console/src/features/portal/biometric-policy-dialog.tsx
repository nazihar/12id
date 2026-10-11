/**
 * Biometric policy per credential definition or proof template (Phase 6): follow the organization
 * default, always require a face check, or never. A proof template can also require it only when a
 * rule holds for numbers the organization's backend sends with the request (e.g. amount ≥ 5000).
 * The thresholds apply to "always" and to the rule.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, ScanFaceIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { Form, formValidation, submitMutation, toErrors, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import {
  type BiometricOverride,
  CONDITION_MATCH_OPTIONS,
  CONDITION_OP_OPTIONS,
  MAX_CONDITIONS,
  MODE_OPTIONS,
  TEMPLATE_MODE_OPTIONS,
  type TemplateBiometricOverride,
  type TemplateOverrideForm,
  templateOverrideForm,
  toTemplateOverride,
  toTemplateOverrideForm,
} from '@/features/portal/biometrics.schemas'
import { getPortalCredentialDefinitionPolicy, getPortalTemplatePolicy, savePortalCredentialDefinitionPolicy, savePortalTemplatePolicy } from '@/features/portal/portal-data.functions'
import { portalKey } from '@/features/portal/portal.queries'

const DEFAULT_NUMBERS = { minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3 }

interface PolicySubject {
  /** Cache key suffix, e.g. `cd:<id>` or `template:<id>`. */
  key: string
  /** Proof templates only: offer "Require a face check when…". */
  conditional?: boolean
  load: () => Promise<TemplateBiometricOverride>
  save: (policy: TemplateBiometricOverride) => Promise<unknown>
}

export function CredentialDefinitionPolicyAction({ credentialDefinitionId, label, organizationId, orgSlug }: { credentialDefinitionId: string; label: string; organizationId: string; orgSlug: string }) {
  const subject: PolicySubject = {
    key: `cd:${credentialDefinitionId}`,
    load: async () => (await getPortalCredentialDefinitionPolicy({ data: { credentialDefinitionId } })).biometricPolicy as BiometricOverride,
    // The form offers only the three modes a credential definition takes.
    save: (policy) => savePortalCredentialDefinitionPolicy({ data: { organizationId, credentialDefinitionId, policy: policy as BiometricOverride } }),
  }
  return (
    <PolicyDialog
      subject={subject}
      orgSlug={orgSlug}
      title={`Face check for ${label}`}
      description="Whether offers of this credential need the holder to pass liveness and a face match first. Applies to offers made after saving."
    />
  )
}

export function TemplatePolicyAction({ templateId, label, organizationId, orgSlug }: { templateId: string; label: string; organizationId: string; orgSlug: string }) {
  const subject: PolicySubject = {
    key: `template:${templateId}`,
    conditional: true,
    load: async () => (await getPortalTemplatePolicy({ data: { templateId } })).biometricPolicy as TemplateBiometricOverride,
    save: (policy) => savePortalTemplatePolicy({ data: { organizationId, templateId, policy } }),
  }
  return (
    <PolicyDialog
      subject={subject}
      orgSlug={orgSlug}
      title={`Face check for ${label}`}
      description="Whether proof requests from this template need the holder to pass liveness and a face match before the result is released to you."
    />
  )
}

function PolicyDialog({ subject, orgSlug, title, description }: { subject: PolicySubject; orgSlug: string; title: string; description: string }) {
  return (
    <FormDialog
      size={subject.conditional ? 'lg' : 'md'}
      trigger={
        <Button size="icon-sm" variant="ghost" aria-label="Face check" title="Face check">
          <ScanFaceIcon />
        </Button>
      }
      title={title}
      description={description}
    >
      {({ close }) => <PolicyBody subject={subject} orgSlug={orgSlug} onDone={close} />}
    </FormDialog>
  )
}

function PolicyBody({ subject, orgSlug, onDone }: { subject: PolicySubject; orgSlug: string; onDone: () => void }) {
  const current = useQuery({ queryKey: portalKey(orgSlug, 'biometric-policy', subject.key), queryFn: subject.load })
  if (current.error) return <p className="text-sm text-destructive">{current.error.message}</p>
  if (!current.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  return <PolicyForm initial={current.data} subject={subject} orgSlug={orgSlug} onDone={onDone} />
}

function usePolicyForm(defaultValues: TemplateOverrideForm, onSubmit: (values: TemplateOverrideForm) => Promise<void>) {
  return useAppForm({
    defaultValues,
    validationLogic: formValidation,
    validators: { onDynamic: templateOverrideForm },
    onSubmit: ({ value }) => onSubmit(value),
  })
}
type PolicyFormApi = ReturnType<typeof usePolicyForm>

function PolicyForm({ initial, subject, orgSlug, onDone }: { initial: TemplateBiometricOverride; subject: PolicySubject; orgSlug: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: subject.save,
    onSuccess: async () => {
      toast.success('Face check policy saved.')
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'biometric-policy', subject.key) })
      // The templates list shows each template's face-check mode.
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'templates') })
    },
  })
  const form = usePolicyForm(toTemplateOverrideForm(initial, DEFAULT_NUMBERS), (value) => submitMutation(save, toTemplateOverride(templateOverrideForm.parse(value)), () => onDone()))
  return (
    <Form form={form}>
      <form.FormError error={save.error} />
      <form.AppField
        name="mode"
        listeners={{
          // Choosing the rule starts it with one empty line to fill in.
          onChange: ({ value }) => {
            if (value === 'conditional' && form.getFieldValue('conditions').length === 0) form.pushFieldValue('conditions', { param: '', op: 'gte', value: Number.NaN })
          },
        }}
      >
        {(field) => <field.ComboboxField label="Face check" options={subject.conditional ? TEMPLATE_MODE_OPTIONS : MODE_OPTIONS} />}
      </form.AppField>
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) =>
          mode === 'required' || mode === 'conditional' ? (
            <>
              {mode === 'conditional' && <RuleFields form={form} />}
              <div className="grid gap-4 sm:grid-cols-3">
                <form.AppField name="minMatchScore">{(field) => <field.NumberField label="Minimum match" min={0} max={100} />}</form.AppField>
                <form.AppField name="minLivenessScore">{(field) => <field.NumberField label="Minimum liveness" min={0} max={100} />}</form.AppField>
                <form.AppField name="maxAttempts">{(field) => <field.NumberField label="Attempts" min={1} max={5} />}</form.AppField>
              </div>
            </>
          ) : null
        }
      </form.Subscribe>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Saving…">Save</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}

/** The rule: "any of" or "all of", and up to five lines of parameter, comparison and number. */
function RuleFields({ form }: { form: PolicyFormApi }) {
  return (
    <div className="flex flex-col gap-4" data-testid="face-check-rule">
      <form.AppField name="match">{(field) => <field.ComboboxField label="Require the check when" options={CONDITION_MATCH_OPTIONS} className="max-w-xs" />}</form.AppField>
      <form.AppField name="conditions" mode="array">
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
            <FieldLabel>Conditions</FieldLabel>
            <FieldDescription>
              You choose the parameter names. Your backend sends each one as a number with every proof request from this template (<code>biometric.params</code>), for example <code>amount</code> or <code>riskScore</code>; send a yes/no fact as 1 or 0. A request
              without one of them is refused.
            </FieldDescription>
            {field.state.value.map((_, index) => (
              <ConditionRow key={index} form={form} index={index} onRemove={() => field.removeValue(index)} />
            ))}
            <div>
              <Button type="button" variant="outline" size="sm" disabled={field.state.value.length >= MAX_CONDITIONS} onClick={() => field.pushValue({ param: '', op: 'gte', value: Number.NaN })}>
                <PlusIcon />
                Add condition
              </Button>
            </div>
            <FieldError errors={toErrors(field.state.meta.errors)} />
          </Field>
        )}
      </form.AppField>
      <form.Subscribe selector={(state) => state.values.match === 'all' && state.values.conditions.length > 1}>
        {(relaxed) => (relaxed ? <p className="text-sm text-muted-foreground">With "all of these", the check is skipped unless every line is true.</p> : null)}
      </form.Subscribe>
    </div>
  )
}

function ConditionRow({ form, index, onRemove }: { form: PolicyFormApi; index: number; onRemove: () => void }) {
  const base = `conditions[${index}]` as const
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(10rem,2fr)_minmax(5rem,1fr)_minmax(7rem,1fr)_auto] sm:items-start">
      <form.AppField name={`${base}.param`}>{(field) => <field.TextField label="Parameter" placeholder="amount" maxLength={40} />}</form.AppField>
      <form.AppField name={`${base}.op`}>{(field) => <field.ComboboxField label="Comparison" options={CONDITION_OP_OPTIONS} />}</form.AppField>
      <form.AppField name={`${base}.value`}>{(field) => <field.NumberField label="Value" decimal />}</form.AppField>
      <Button type="button" variant="ghost" size="icon-sm" className="sm:mt-6" aria-label={`Remove condition ${index + 1}`} onClick={onRemove}>
        <Trash2Icon />
      </Button>
    </div>
  )
}
