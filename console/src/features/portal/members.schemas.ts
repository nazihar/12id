/** Client-safe input schemas shared by the member forms and the server functions' validators. */
import { z } from 'zod'

import { emailAddress } from '@/features/operators/operators.schemas'
import { listSearch } from '@/lib/list-search'
import type { TenantRole } from '@/lib/permissions'

import { roleName } from './roles.schemas'

export const TENANT_ROLES = ['owner', 'admin', 'member'] as const satisfies readonly TenantRole[]
export const ROLE_HELP: Record<TenantRole, string> = {
  owner: 'everything, including members',
  admin: 'API keys, webhooks, catalogue and templates',
  member: 'read-only',
}

/** A built-in role or one of the organization's custom roles (implement/26); Better Auth refuses a name the organization does not have. */
export const tenantRole = roleName

/** Member states for the filter (implement/26): the account's state, or this membership disabled. */
export const MEMBER_STATES = ['active', 'locked', 'disabled', 'inactive'] as const

/** Members page search (Phase 4 C9): members or pending invitations, each paged, searched and filtered by role. */
export const MEMBER_TABS = ['members', 'invitations', 'signed-in'] as const
export const memberSearch = listSearch.extend({ tab: z.enum(MEMBER_TABS).optional(), role: tenantRole.optional(), state: z.enum(MEMBER_STATES).optional() })
export type MemberSearch = z.infer<typeof memberSearch>
export const roleOptions = TENANT_ROLES.map((value) => ({ value, label: value }))


export const inviteMemberInput = z.object({ email: emailAddress, role: tenantRole })
export type InviteMemberInput = z.input<typeof inviteMemberInput>

export const memberRoleInput = z.object({ role: tenantRole })
export type MemberRoleInput = z.input<typeof memberRoleInput>
