/** Client-safe input for an organization's custom roles (implement/26). */
import { z } from 'zod'

import { BUILT_IN_TENANT_ROLES, PORTAL_ACTION_KEYS, type PortalAction } from '@/lib/permissions'

/** What Better Auth stores as the role's name: lower case, so `Role` and `role` are one name. */
export const roleName = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,39}$/, 'Choose a role.')

/** The stored name for a label: what members and invitations refer to; the label is what people see. */
export function roleSlug(label: string) {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
}

export const roleInput = z
  .object({
    label: z.string().trim().min(2, 'Give the role a name.').max(40, 'At most 40 characters.'),
    description: z.string().trim().max(200, 'At most 200 characters.'),
    actions: z.array(z.enum(PORTAL_ACTION_KEYS)).max(PORTAL_ACTION_KEYS.length),
  })
  .superRefine((value, ctx) => {
    const slug = roleSlug(value.label)
    if (!slug) ctx.addIssue({ code: 'custom', path: ['label'], message: 'Start the name with a letter.' })
    else if ((BUILT_IN_TENANT_ROLES as readonly string[]).includes(slug)) ctx.addIssue({ code: 'custom', path: ['label'], message: 'Owner, Admin and Member are built in. Choose another name.' })
  })
export type RoleInput = z.input<typeof roleInput>

export interface RoleRow {
  /** The stored name, which members and invitations refer to. */
  role: string
  label: string
  description: string
  actions: PortalAction[]
  builtIn: boolean
  /** How many members hold it, and how many pending invitations name it. */
  members: number
  invitations: number
}
