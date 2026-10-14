/**
 * An organization's roles for the Roles page and the role pickers (implement/26): the three built-in
 * roles, locked, then the custom roles, each with its actions and how many people hold it.
 */
import { and, eq } from 'drizzle-orm'

import type { RoleRow } from '@/features/portal/roles.schemas'
import { BUILT_IN_TENANT_ROLES, type TenantRole, actionsOf, builtInPermissions } from '@/lib/permissions'

import { consoleDb } from './db.server'
import { invitation, member } from './db/auth-schema'
import { customRoles, memberRoleNames } from './permissions.server'

export const BUILT_IN_ROLE_TEXT: Record<TenantRole, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything, including members and roles.' },
  admin: { label: 'Admin', description: 'Everything except members and roles.' },
  member: { label: 'Member', description: 'Sees everything, changes nothing.' },
}

/** How many memberships and pending invitations name each role. */
async function roleCounts(organizationId: string) {
  const { db } = consoleDb()
  const [members, invitations] = await Promise.all([
    db.select({ role: member.role }).from(member).where(eq(member.organizationId, organizationId)),
    db.select({ role: invitation.role }).from(invitation).where(and(eq(invitation.organizationId, organizationId), eq(invitation.status, 'pending'))),
  ])
  const count = (rows: { role: string | null }[], name: string) => rows.filter((row) => memberRoleNames(row.role ?? 'member').includes(name)).length
  return (name: string) => ({ members: count(members, name), invitations: count(invitations, name) })
}

export async function listRoleRows(organizationId: string): Promise<RoleRow[]> {
  const [custom, counts] = await Promise.all([customRoles(organizationId), roleCounts(organizationId)])
  const builtIn = BUILT_IN_TENANT_ROLES.map((role) => ({ role, ...BUILT_IN_ROLE_TEXT[role], actions: actionsOf(builtInPermissions(role)), builtIn: true, ...counts(role) }))
  const own = custom.sort((a, b) => a.label.localeCompare(b.label)).map((row) => ({ role: row.role, label: row.label, description: row.description, actions: actionsOf(row.permissions), builtIn: false, ...counts(row.role) }))
  return [...builtIn, ...own]
}

/** One custom role of the organization; null when it has none by that name. */
export async function customRole(organizationId: string, role: string) {
  return (await customRoles(organizationId)).find((row) => row.role === role) ?? null
}
