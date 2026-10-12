/** Client-safe input schemas shared by the operator forms and the server functions' validators. */
import { z } from 'zod'

import { listSearch } from '@/lib/list-search'
import { STAFF_ROLES, type StaffRole } from '@/lib/permissions'

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

/** Operators list (Phase 4 C9): search by name or email, filter by role and active / banned. */
export const OPERATOR_STATUSES = ['active', 'banned'] as const
export const operatorSearch = listSearch.extend({ status: z.enum(OPERATOR_STATUSES).optional(), role: staffRole.optional() })
export type OperatorSearch = z.infer<typeof operatorSearch>
export const operatorStatusOptions = OPERATOR_STATUSES.map((value) => ({ value, label: value }))
