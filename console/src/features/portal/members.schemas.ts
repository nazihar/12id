/** Client-safe input schemas shared by the member forms and the server functions' validators. */
import { z } from 'zod'

import { emailAddress } from '@/features/operators/operators.schemas'
import type { TenantRole } from '@/lib/permissions'

export const TENANT_ROLES = ['owner', 'admin', 'member'] as const satisfies readonly TenantRole[]
export const ROLE_HELP: Record<TenantRole, string> = {
  owner: 'everything, including members',
  admin: 'API keys, webhooks, catalogue and templates',
  member: 'read-only',
}

export const tenantRole = z.enum(TENANT_ROLES, 'Choose a role.')

export const inviteMemberInput = z.object({ email: emailAddress, role: tenantRole })
export type InviteMemberInput = z.input<typeof inviteMemberInput>

export const memberRoleInput = z.object({ role: tenantRole })
export type MemberRoleInput = z.input<typeof memberRoleInput>
