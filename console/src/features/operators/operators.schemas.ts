/** Client-safe input schemas shared by the operator forms and the server functions' validators. */
import { z } from 'zod'

import { listSearch } from '@/lib/list-search'

export const personName = z.string().trim().min(1, 'Enter a name.').max(200, 'Use at most 200 characters.')
export const emailAddress = z
  .string()
  .trim()
  .min(1, 'Enter an email address.')
  .pipe(z.email('Enter a valid email address.'))
  .transform((email) => email.toLowerCase())

export const inviteOperatorInput = z.object({ name: personName, email: emailAddress })
export type InviteOperatorInput = z.input<typeof inviteOperatorInput>

/** Operators list (Phase 4 C9): search by name or email, filter active / banned. */
export const OPERATOR_STATUSES = ['active', 'banned'] as const
export const operatorSearch = listSearch.extend({ status: z.enum(OPERATOR_STATUSES).optional() })
export type OperatorSearch = z.infer<typeof operatorSearch>
export const operatorStatusOptions = OPERATOR_STATUSES.map((value) => ({ value, label: value }))
