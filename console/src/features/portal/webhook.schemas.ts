/** Client-safe input schemas for the webhook endpoint form and the server function's validator. */
import { z } from 'zod'

import { WEBHOOK_EVENT_TYPES } from '@/features/tenant-data/types'

export const webhookUrl = z
  .string()
  .trim()
  .min(1, 'Enter the endpoint URL.')
  .pipe(z.url('Enter a valid URL.'))
  .refine((url) => url.startsWith('https://'), 'Webhook URLs must use https.')
export const webhookEvents = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1)

/** What the server accepts: `events` omitted means every event type. */
export const webhookEndpointInput = z.object({ url: webhookUrl, events: webhookEvents.optional() })
export type WebhookEndpointInput = z.infer<typeof webhookEndpointInput>

/** What the form holds: an explicit "all events" switch, so an empty selection is a mistake rather than "all". */
export const webhookEndpointForm = z
  .object({ url: webhookUrl, allEvents: z.boolean(), events: z.array(z.enum(WEBHOOK_EVENT_TYPES)) })
  .superRefine((value, ctx) => {
    if (!value.allEvents && value.events.length === 0) ctx.addIssue({ code: 'custom', path: ['events'], message: 'Choose at least one event, or deliver all events.' })
  })
export type WebhookEndpointForm = z.input<typeof webhookEndpointForm>

export function toWebhookEndpointInput(form: z.output<typeof webhookEndpointForm>): WebhookEndpointInput {
  return { url: form.url, events: form.allEvents ? undefined : form.events }
}
