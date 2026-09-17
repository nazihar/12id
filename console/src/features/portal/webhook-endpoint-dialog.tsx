import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PencilIcon, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'

import { type ChoiceOption, Form, formValidation, submitMutation, useAppForm } from '@/components/form/form'
import { FormDialog } from '@/components/form/form-dialog'
import { Button } from '@/components/ui/button'
import { DialogClose, DialogFooter } from '@/components/ui/dialog'
import { setPortalWebhook } from '@/features/portal/portal-data.functions'
import { portalKey } from '@/features/portal/portal.queries'
import { type WebhookEndpointForm, toWebhookEndpointInput, webhookEndpointForm } from '@/features/portal/webhook.schemas'
import { WEBHOOK_EVENT_TYPES, type WebhookEndpoint, type WebhookEventType } from '@/features/tenant-data/types'

const EVENT_OPTIONS: ChoiceOption<WebhookEventType>[] = WEBHOOK_EVENT_TYPES.map((type) => ({ value: type, label: type }))

/** Creates or edits the organization's webhook endpoint. A new endpoint's signing secret is handed to `onSecret`, shown once. */
export function WebhookEndpointDialog({ organizationId, orgSlug, endpoint, onSecret }: { organizationId: string; orgSlug: string; endpoint: WebhookEndpoint | null; onSecret: (secret: string) => void }) {
  return (
    <FormDialog
      size="md"
      trigger={
        endpoint ? (
          <Button size="sm" variant="outline">
            <PencilIcon />
            Edit endpoint
          </Button>
        ) : (
          <Button size="sm">
            <PlusIcon />
            Create endpoint
          </Button>
        )
      }
      title={endpoint ? 'Edit the webhook endpoint' : 'Create the webhook endpoint'}
      description="Events are POSTed as signed JSON (X-12id-Signature, HMAC-SHA256 with your secret). Answer 2xx within 10 seconds; failures are retried with backoff for about a day."
    >
      {({ close }) => <WebhookEndpointFormBody organizationId={organizationId} orgSlug={orgSlug} endpoint={endpoint} onDone={close} onSecret={onSecret} />}
    </FormDialog>
  )
}

function WebhookEndpointFormBody({
  organizationId,
  orgSlug,
  endpoint,
  onDone,
  onSecret,
}: {
  organizationId: string
  orgSlug: string
  endpoint: WebhookEndpoint | null
  onDone: () => void
  onSecret: (secret: string) => void
}) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (input: WebhookEndpointForm) => setPortalWebhook({ data: { organizationId, ...toWebhookEndpointInput(webhookEndpointForm.parse(input)) } }),
    onSuccess: async (saved) => {
      if (!saved.secret) toast.success('Webhook endpoint updated.')
      await queryClient.invalidateQueries({ queryKey: portalKey(orgSlug, 'webhook') })
    },
  })
  const form = useAppForm({
    defaultValues: {
      url: endpoint?.url ?? '',
      allEvents: !endpoint?.events,
      events: (endpoint?.events ?? [...WEBHOOK_EVENT_TYPES]) as WebhookEventType[],
    } satisfies WebhookEndpointForm,
    validationLogic: formValidation,
    validators: { onDynamic: webhookEndpointForm },
    onSubmit: ({ value }) =>
      submitMutation(save, value, (saved) => {
        onDone()
        if (saved.secret) onSecret(saved.secret)
      }),
  })
  return (
    <Form form={form}>
      <form.FormError error={save.error} />
      <form.AppField name="url">{(field) => <field.TextField label="HTTPS URL" type="url" placeholder="https://backend.example.com/12id/webhooks" autoFocus />}</form.AppField>
      <form.AppField name="allEvents">{(field) => <field.SwitchField label="Deliver all events" description="Including event types added to the platform later." />}</form.AppField>
      <form.Subscribe selector={(state) => state.values.allEvents}>
        {(allEvents) =>
          allEvents ? null : (
            <form.AppField name="events">
              {(field) => <field.CheckboxGroupField label="Events" options={EVENT_OPTIONS} mono description="wallet.sync_requested asks your backend to push its app so the wallet collects waiting messages." />}
            </form.AppField>
          )
        }
      </form.Subscribe>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <form.SubmitButton pendingLabel="Saving…">{endpoint ? 'Save endpoint' : 'Create endpoint'}</form.SubmitButton>
      </DialogFooter>
    </Form>
  )
}
