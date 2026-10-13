/**
 * Biometric gate settings (Phase 6): the tenant's own vendor account, the on/off switch, the default
 * policy and add-on adoption. Vendor configuration is write-only: only its non-secret part comes back.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PencilIcon, PlugZapIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { StateBadge } from '@/components/state-badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { biometricProviderInput, biometricSettingsInput } from '@/features/portal/biometrics.schemas'
import {
  removePortalBiometricProvider,
  savePortalBiometricProvider,
  savePortalBiometricSettings,
  testPortalBiometricProvider,
} from '@/features/portal/portal-data.functions'
import { portalKey } from '@/features/portal/portal.queries'
import { formatDateTime } from '@/lib/format'
import { announceHeld } from '@/lib/held'

export interface ProviderForm {
  id: string
  displayName: string
  captureProvider: string
  fields: Array<{ key: string; options: string[] | null; pattern: string | null }>
}

export interface Settings {
  enabled: boolean
  defaultPolicy: { required: boolean; minMatchScore: number; minLivenessScore: number; maxAttempts: number; ttlMinutes: number }
  externalId: string
  provider: { id: string; publicConfig: Record<string, string>; status: 'ok' | 'failed' | 'untested'; lastTestedAt: string | null; lastError: string | null } | null
}

const FIELD_LABELS: Record<string, { label: string; placeholder?: string; description?: string }> = {
  region: { label: 'AWS region', description: 'A region where Rekognition Face Liveness is available.' },
  roleArn: { label: 'IAM role ARN', placeholder: 'arn:aws:iam::123456789012:role/12id-face-liveness', description: 'The role you created for 12id (see the setup steps).' },
}

/** The role's permissions, as the tenant should paste them (AWS console → IAM → role → inline policy). */
const AWS_PERMISSIONS = JSON.stringify(
  {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['rekognition:CreateFaceLivenessSession', 'rekognition:GetFaceLivenessSessionResults', 'rekognition:StartFaceLivenessSession', 'rekognition:CompareFaces'],
        Resource: '*',
      },
    ],
  },
  null,
  2
)

export function ProviderCard({ settings, providers, organizationId, orgSlug, canUpdate }: { settings: Settings; providers: ProviderForm[]; organizationId: string; orgSlug: string; canUpdate: boolean }) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'biometrics') })
  const test = useMutation({
    mutationFn: () => testPortalBiometricProvider({ data: { organizationId } }),
    onSuccess: async (result) => {
      if (result.status === 'ok') toast.success('Connection test passed.')
      else toast.error(`Connection test failed: ${result.error ?? 'unknown error'}`)
      await refresh()
    },
  })
  const provider = settings.provider
  const displayName = providers.find((p) => p.id === provider?.id)?.displayName ?? provider?.id

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Provider</CardTitle>
        <CardDescription>
          {provider ? (
            <span className="flex flex-wrap items-center gap-2">
              {displayName} <StateBadge state={provider.status} />
              {provider.lastTestedAt && <span>tested {formatDateTime(provider.lastTestedAt)}</span>}
            </span>
          ) : (
            'No provider configured. Checks use your own vendor account; 12id holds no vendor billing.'
          )}
        </CardDescription>
        {canUpdate && (
          <CardAction className="flex gap-2">
            {provider && (
              <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                <PlugZapIcon />
                {test.isPending ? 'Testing…' : 'Test connection'}
              </Button>
            )}
            <ProviderDialog providers={providers} settings={settings} organizationId={organizationId} orgSlug={orgSlug} />
            {provider && (
              <ConfirmDialog
                trigger={
                  <Button size="sm" variant="outline">
                    <Trash2Icon />
                    Remove
                  </Button>
                }
                title="Remove the biometric provider?"
                description="Biometrics are switched off. Exchanges already waiting for a face check keep waiting until they expire."
                confirmLabel="Remove provider"
                destructive
                onConfirm={async () => {
                  const removed = await removePortalBiometricProvider({ data: { organizationId } })
                  if (announceHeld(removed, queryClient)) return
                  toast.success('Biometric provider removed.')
                  await refresh()
                }}
              />
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {provider && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            {Object.entries(provider.publicConfig).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{FIELD_LABELS[key]?.label ?? key}</dt>
                <dd className="font-mono text-xs break-all">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {provider?.lastError && <p className="text-destructive">{provider.lastError}</p>}
        <details className="rounded-md border p-3" data-testid="aws-setup">
          <summary className="cursor-pointer font-medium">AWS setup (one time)</summary>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li>
              In your AWS account, create an IAM role for 12id (IAM → Roles → Create role → <em>AWS account</em> → <em>Another AWS account</em>), with the 12id account your onboarding contact gave you and
              <strong> Require external ID</strong> set to:
              <pre className="mt-1 rounded bg-muted p-2 font-mono text-xs break-all">{settings.externalId}</pre>
            </li>
            <li>
              Add this inline permissions policy to the role:
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{AWS_PERMISSIONS}</pre>
            </li>
            <li>Configure the provider here with the role ARN and region, then run the connection test.</li>
          </ol>
          <p className="mt-2 text-muted-foreground">Face images are not stored in your account or ours: no S3 output is configured and reference images are deleted after each decision.</p>
        </details>
      </CardContent>
    </Card>
  )
}

function ProviderDialog({ providers, settings, organizationId, orgSlug }: { providers: ProviderForm[]; settings: Settings; organizationId: string; orgSlug: string }) {
  const current = settings.provider
  return (
    <FormDialog
      size="md"
      trigger={
        <Button size="sm" variant={current ? 'outline' : 'default'}>
          {current ? <PencilIcon /> : <PlusIcon />}
          {current ? 'Change' : 'Configure provider'}
        </Button>
      }
      title="Biometric provider"
      description="Saved encrypted and never shown again; a new configuration must pass the connection test before face checks resume."
    >
      {({ close }) => <ProviderFormBody providers={providers} settings={settings} organizationId={organizationId} orgSlug={orgSlug} onDone={close} />}
    </FormDialog>
  )
}

function ProviderFormBody({ providers, settings, organizationId, orgSlug, onDone }: { providers: ProviderForm[]; settings: Settings; organizationId: string; orgSlug: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const initial = providers.find((p) => p.id === settings.provider?.id) ?? providers[0]
  const save = useMutation({
    mutationFn: (value: { providerId: string; config: Record<string, string> }) => {
      const provider = providers.find((p) => p.id === value.providerId)
      const config = Object.fromEntries((provider?.fields ?? []).map((field) => [field.key, value.config[field.key] ?? '']))
      return savePortalBiometricProvider({ data: { organizationId, providerId: value.providerId, config } })
    },
    onSuccess: async (saved) => {
      if (announceHeld(saved, queryClient)) return
      toast.success('Provider saved. Run the connection test next.')
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'biometrics') })
    },
  })
  const form = useAppForm({
    defaultValues: {
      providerId: initial?.id ?? '',
      config: Object.fromEntries((initial?.fields ?? []).map((field) => [field.key, settings.provider?.id === initial?.id ? (settings.provider?.publicConfig[field.key] ?? '') : ''])) as Record<string, string>,
    },
    validationLogic: formValidation,
    validators: { onDynamic: biometricProviderInput },
    onSubmit: ({ value }) => submitMutation(save, value, () => onDone()),
  })
  if (providers.length === 0) return <p className="text-sm text-muted-foreground">This deployment offers no biometric provider.</p>

  return (
    <Form form={form}>
      <form.FormError error={save.error} />
      <form.AppField name="providerId">
        {(field) => <field.ComboboxField label="Provider" options={providers.map((p) => ({ value: p.id, label: p.displayName }))} />}
      </form.AppField>
      <form.Subscribe selector={(state) => state.values.providerId}>
        {(providerId) =>
          (providers.find((p) => p.id === providerId)?.fields ?? []).map((spec) => (
            <form.AppField key={`${providerId}.${spec.key}`} name={`config.${spec.key}`}>
              {(field) =>
                spec.options ? (
                  <field.ComboboxField label={FIELD_LABELS[spec.key]?.label ?? spec.key} description={FIELD_LABELS[spec.key]?.description} options={spec.options.map((o) => ({ value: o, label: o }))} />
                ) : (
                  <field.TextField label={FIELD_LABELS[spec.key]?.label ?? spec.key} description={FIELD_LABELS[spec.key]?.description} placeholder={FIELD_LABELS[spec.key]?.placeholder} />
                )
              }
            </form.AppField>
          ))
        }
      </form.Subscribe>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Saving…">Save provider</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}

export function SettingsCard({ settings, organizationId, orgSlug, canUpdate }: { settings: Settings; organizationId: string; orgSlug: string; canUpdate: boolean }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (value: { enabled: boolean; defaultPolicy: Settings['defaultPolicy'] }) => savePortalBiometricSettings({ data: { organizationId, ...value } }),
    onSuccess: async (saved) => {
      if (announceHeld(saved, queryClient)) return
      toast.success('Biometric settings saved.')
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'biometrics') })
    },
  })
  const form = useAppForm({
    defaultValues: { enabled: settings.enabled, defaultPolicy: settings.defaultPolicy },
    validationLogic: formValidation,
    validators: { onDynamic: biometricSettingsInput },
    onSubmit: ({ value }) => submitMutation(save, value, () => undefined),
  })
  const disabled = !canUpdate
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Face checks</CardTitle>
        <CardDescription>
          When on, exchanges that require a check hold until the holder passes liveness and a face match against the reference image you send with the offer or proof request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form form={form}>
          <form.FormError error={save.error} />
          <form.AppField name="enabled">{(field) => <field.SwitchField label="Biometric gate on" description="Needs a provider that passed its connection test." disabled={disabled} />}</form.AppField>
          <form.AppField name="defaultPolicy.required">
            {(field) => <field.SwitchField label="Require by default" description="Credential definitions and proof templates can override this." disabled={disabled} />}
          </form.AppField>
          <div className="grid gap-4 sm:grid-cols-2">
            <form.AppField name="defaultPolicy.minMatchScore">{(field) => <field.NumberField label="Minimum face match (0–100)" min={0} max={100} disabled={disabled} />}</form.AppField>
            <form.AppField name="defaultPolicy.minLivenessScore">{(field) => <field.NumberField label="Minimum liveness (0–100)" min={0} max={100} disabled={disabled} />}</form.AppField>
            <form.AppField name="defaultPolicy.maxAttempts">{(field) => <field.NumberField label="Attempts" min={1} max={5} disabled={disabled} />}</form.AppField>
            <form.AppField name="defaultPolicy.ttlMinutes">{(field) => <field.NumberField label="Time to complete (minutes)" min={5} max={1440} disabled={disabled} />}</form.AppField>
          </div>
          {canUpdate && (
            <div>
              <form.SubmitButton pendingLabel="Saving…">Save settings</form.SubmitButton>
            </div>
          )}
        </Form>
      </CardContent>
    </Card>
  )
}

export function AdoptionCard({ adoption, captureProvider }: { adoption: { walletsReporting: number; modules: Array<{ module: string; wallets: number }> }; captureProvider?: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>App add-ons</CardTitle>
        <CardDescription>
          Capture add-ons reported by your apps' wallets ({adoption.walletsReporting} reporting). Before switching provider, ship an app release with the new add-on and wait until most wallets report it.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {adoption.modules.length === 0 ? (
          <p className="text-muted-foreground">No wallet has started a face check yet.</p>
        ) : (
          <ul className="space-y-1">
            {adoption.modules.map((m) => (
              <li key={m.module} className="flex items-center gap-2">
                <span className="font-mono text-xs">{m.module}</span>
                <span className="text-muted-foreground">{m.wallets} wallet{m.wallets === 1 ? '' : 's'}</span>
                {captureProvider && m.module.startsWith(`${captureProvider}@`) && <StateBadge state="active" />}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
