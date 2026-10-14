/** Client-safe input schemas shared by the operator forms and the server functions' validators. */
import { z } from 'zod'

import { listSearch } from '@/lib/list-search'
import { STAFF_ROLES, type StaffRole } from '@/lib/permissions'
import { ACCOUNT_STATES } from '@/lib/sign-in-rules'

export const personName = z.string().trim().min(1, 'Enter a name.').max(200, 'Use at most 200 characters.')
export const emailAddress = z
  .string()
  .trim()
  .min(1, 'Enter an email address.')
  .pipe(z.email('Enter a valid email address.'))
  .transform((email) => email.toLowerCase())

/** The roles of the operator area (implement/22 C14): an operator runs the platform, an auditor only reads it. */
export const staffRole = z.enum(STAFF_ROLES, 'Choose a role.')
export const STAFF_ROLE_HELP: Record<StaffRole, string> = {
  operator: 'every tenant, and every change',
  auditor: 'every tenant, read-only; personal data stays masked',
}
export const staffRoleOptions = STAFF_ROLES.map((value) => ({ value, label: value }))

export const inviteOperatorInput = z.object({ name: personName, email: emailAddress, role: staffRole })
export type InviteOperatorInput = z.input<typeof inviteOperatorInput>

/** Editing an account: its name and its role. The email is the account; a new address is a new invitation. */
export const editOperatorInput = z.object({ name: personName, role: staffRole })
export type EditOperatorInput = z.input<typeof editOperatorInput>

/**
 * Disabling an account or a membership (implement/26): until a day (`YYYY-MM-DD`, re-enabled at the
 * start of it, UTC) or, empty, until someone re-enables it; always with a note saying why.
 */
export const disableInput = z.object({
  until: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Pick a day.')
    .refine((day) => day === '' || Date.parse(`${day}T00:00:00Z`) > Date.now(), 'Pick a day after today.'),
  note: z.string().trim().min(1, 'Say why, for the next person who reads it.').max(200, 'At most 200 characters.'),
})
export type DisableInput = z.input<typeof disableInput>
/** When a disable ends: the start of its day, UTC; null for until re-enabled. */
export const disabledUntil = (day: string) => (day ? new Date(`${day}T00:00:00Z`) : null)

/** Operators list (Phase 4 C9): search by name or email, filter by role and state (implement/26). */
export const OPERATOR_STATUSES = ACCOUNT_STATES
export const operatorSearch = listSearch.extend({ status: z.enum(OPERATOR_STATUSES).optional(), role: staffRole.optional(), tab: z.enum(['accounts', 'signed-in']).optional() })
export type OperatorSearch = z.infer<typeof operatorSearch>
export const operatorStatusOptions = OPERATOR_STATUSES.map((value) => ({ value, label: value }))
