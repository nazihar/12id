import { useMutation, useQueryClient } from '@tanstack/react-query'
import { QrCodeIcon } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

import { Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { CopyButton } from '@/components/identifier-pair'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { type ConnectionInvitationForm, connectionInvitationForm, toConnectionInvitationInput } from '@/features/portal/exchanges.schemas'
import { createPortalInvitation } from '@/features/portal/portal-data.functions'
import { portalKey } from '@/features/portal/portal.queries'

/** For testing with a wallet app: the form step, then the invitation as a QR code and URL in the same dialog. */
export function ConnectionInvitationDialog({ organizationId, orgSlug }: { organizationId: string; orgSlug: string }) {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <QrCodeIcon />
          Create invitation
        </Button>
      }
      title="Connection invitation"
      description="For testing with a wallet app. In production your backend creates invitations through the API."
    >
      {({ close }) => <ConnectionInvitationBody organizationId={organizationId} orgSlug={orgSlug} onDone={close} />}
    </FormDialog>
  )
}

function ConnectionInvitationBody({ organizationId, orgSlug, onDone }: { organizationId: string; orgSlug: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (input: ConnectionInvitationForm) => createPortalInvitation({ data: { organizationId, ...toConnectionInvitationInput(connectionInvitationForm.parse(input)) } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'exchanges') }),
  })
  const form = useAppForm({
    defaultValues: { alias: '', multiUse: false } as ConnectionInvitationForm,
    validationLogic: formValidation,
    validators: { onDynamic: connectionInvitationForm },
    onSubmit: ({ value }) => submitMutation(create, value),
  })

  if (create.data) return <InvitationResult invitationUrl={create.data.invitationUrl} onDone={onDone} />

  return (
    <Form form={form}>
      <form.FormError error={create.error} />
      <form.AppField name="alias">{(field) => <field.TextField label="Label (optional)" description="Shown to the holder as the inviter's name." autoFocus />}</form.AppField>
      <form.AppField name="multiUse">{(field) => <field.CheckboxField label="Multi-use" description="For a kiosk or web page: many wallets can connect through the same invitation." />}</form.AppField>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Creating…">Create invitation</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}

function InvitationResult({ invitationUrl, onDone }: { invitationUrl: string; onDone: () => void }) {
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void QRCode.toDataURL(invitationUrl, { margin: 1, width: 240 }).then((url) => !cancelled && setQr(url))
    return () => {
      cancelled = true
    }
  }, [invitationUrl])
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-center">
        {qr ? <img src={qr} alt="Invitation QR code" className="size-48 rounded-md bg-white p-1" data-testid="invitation-qr" /> : <div className="size-48 animate-pulse rounded-md bg-muted" />}
      </div>
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">Scan it with a wallet app, or open the URL on the device.</p>
        {/* The invitation is a long base64 URL; it scrolls rather than pushing the dialog off screen. */}
        <div data-testid="invitation-url" className="max-h-24 overflow-y-auto rounded-md bg-muted p-2 font-mono text-xs break-all">
          {invitationUrl}
        </div>
      </div>
      <DialogFooter>
        <CopyButton value={invitationUrl} label="Copy the invitation URL" size="sm" variant="outline">
          Copy URL
        </CopyButton>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  )
}
