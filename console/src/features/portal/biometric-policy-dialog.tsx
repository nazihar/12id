/**
 * Biometric policy per credential definition or proof template (Phase 6): follow the organization
 * default, always require a face check, or never. The thresholds apply only to "always".
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ScanFaceIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { type BiometricOverride, MODE_OPTIONS, biometricOverrideForm, toOverride, toOverrideForm } from '@/features/portal/biometrics.schemas'
import { getPortalCredentialDefinitionPolicy, getPortalTemplatePolicy, savePortalCredentialDefinitionPolicy, savePortalTemplatePolicy } from '@/features/portal/portal-data.functions'
import { portalKey } from '@/features/portal/portal.queries'

const DEFAULT_NUMBERS = { minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3 }

interface PolicySubject {
  /** Cache key suffix, e.g. `cd:<id>` or `template:<id>`. */
  key: string
  load: () => Promise<BiometricOverride>
  save: (policy: BiometricOverride) => Promise<unknown>
}

export function CredentialDefinitionPolicyAction({ credentialDefinitionId, label, organizationId, orgSlug }: { credentialDefinitionId: string; label: string; organizationId: string; orgSlug: string }) {
  const subject: PolicySubject = {
    key: `cd:${credentialDefinitionId}`,
    load: async () => (await getPortalCredentialDefinitionPolicy({ data: { credentialDefinitionId } })).biometricPolicy as BiometricOverride,
    save: (policy) => savePortalCredentialDefinitionPolicy({ data: { organizationId, credentialDefinitionId, policy } }),
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
    load: async () => (await getPortalTemplatePolicy({ data: { templateId } })).biometricPolicy as BiometricOverride,
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
      size="md"
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

function PolicyForm({ initial, subject, orgSlug, onDone }: { initial: BiometricOverride; subject: PolicySubject; orgSlug: string; onDone: () => void }) {
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
  const form = useAppForm({
    defaultValues: toOverrideForm(initial, DEFAULT_NUMBERS),
    validationLogic: formValidation,
    validators: { onDynamic: biometricOverrideForm },
    onSubmit: ({ value }) => submitMutation(save, toOverride(biometricOverrideForm.parse(value)), () => onDone()),
  })
  return (
    <Form form={form}>
      <form.FormError error={save.error} />
      <form.AppField name="mode">{(field) => <field.ComboboxField label="Face check" options={MODE_OPTIONS} />}</form.AppField>
      <form.Subscribe selector={(state) => state.values.mode}>
        {(mode) =>
          mode === 'required' ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <form.AppField name="minMatchScore">{(field) => <field.NumberField label="Minimum match" min={0} max={100} />}</form.AppField>
              <form.AppField name="minLivenessScore">{(field) => <field.NumberField label="Minimum liveness" min={0} max={100} />}</form.AppField>
              <form.AppField name="maxAttempts">{(field) => <field.NumberField label="Attempts" min={1} max={5} />}</form.AppField>
            </div>
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
