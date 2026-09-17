/** Client-safe input schemas shared by the operator forms and the server functions' validators. */
import { z } from 'zod'

export const personName = z.string().trim().min(1, 'Enter a name.').max(200, 'Use at most 200 characters.')
export const emailAddress = z
  .string()
  .trim()
  .min(1, 'Enter an email address.')
  .pipe(z.email('Enter a valid email address.'))
  .transform((email) => email.toLowerCase())

export const inviteOperatorInput = z.object({ name: personName, email: emailAddress })
export type InviteOperatorInput = z.input<typeof inviteOperatorInput>
