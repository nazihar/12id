/** Client-safe input schemas for the connection invitation form and the server function's validator. */
import { z } from 'zod'

const alias = z.string().trim().max(200, 'Use at most 200 characters.')

/** What the server accepts: no alias means none. */
export const connectionInvitationInput = z.object({ alias: alias.optional(), multiUse: z.boolean() })

/** What the form holds: the alias field is always a string, blank when unused. */
export const connectionInvitationForm = z.object({ alias, multiUse: z.boolean() })
export type ConnectionInvitationForm = z.input<typeof connectionInvitationForm>

export function toConnectionInvitationInput(form: z.output<typeof connectionInvitationForm>): z.input<typeof connectionInvitationInput> {
  return { alias: form.alias || undefined, multiUse: form.multiUse }
}
