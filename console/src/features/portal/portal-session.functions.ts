/**
 * The tenant portal's organization context. Session-only (authMiddleware): these answer about the
 * caller's own memberships and never return tenant data.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders, setResponseStatus } from '@tanstack/react-start/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { type Permissions, type TenantRole, baseRoleFor, isBuiltInTenantRole } from '@/lib/permissions'
import { membershipDisabled } from '@/lib/sign-in-rules'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { member, organization } from '@/server/db/auth-schema'
import { authMiddleware } from '@/server/middleware'
import { customRoles, effectivePermissions, memberRoleNames } from '@/server/permissions.server'

const BUILT_IN_LABELS: Record<TenantRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/**
 * What a membership allows (implement/26): its permissions (built-in and custom roles together),
 * the built-in role nearest to them, and the names people see. null when no role is left.
 */
async function membershipAccess(organizationId: string, roleValue: string): Promise<{ role: TenantRole; roleLabel: string; permissions: Permissions } | null> {
  const names = memberRoleNames(roleValue)
  const permissions = await effectivePermissions(organizationId, names)
  if (Object.keys(permissions).length === 0) return null
  const custom = names.some((name) => !isBuiltInTenantRole(name)) ? await customRoles(organizationId) : []
  const label = (name: string) => (isBuiltInTenantRole(name) ? BUILT_IN_LABELS[name] : (custom.find((role) => role.role === name)?.label ?? name))
  return { role: baseRoleFor(permissions), roleLabel: names.map(label).join(', '), permissions }
}

export const listMyOrganizations = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const rows = await consoleDb()
      .db.select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role, disabledAt: member.disabledAt, disabledUntil: member.disabledUntil, disabledNote: member.disabledNote })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, context.session.user.id))
      .orderBy(asc(organization.name))
    const organizations = await Promise.all(
      rows.map(async (row) => {
        const access = await membershipAccess(row.id, row.role)
        if (!access) return null
        // A membership its owner disabled is shown, but does not open (implement/26).
        const disabled = membershipDisabled(row) ? { until: row.disabledUntil?.toISOString() ?? null, note: row.disabledNote ?? '' } : null
        return { id: row.id, name: row.name, slug: row.slug, role: access.role, roleLabel: access.roleLabel, disabled }
      }),
    )
    return organizations.filter((row) => row !== null)
  })

/** Makes the organization in the URL the session's active one; tenantMiddleware reads it from there. */
export const activateOrganization = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ slug: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    const [row] = await consoleDb()
      .db.select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role, disabledAt: member.disabledAt, disabledUntil: member.disabledUntil })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(and(eq(member.userId, context.session.user.id), eq(organization.slug, data.slug)))
    const access = row ? await membershipAccess(row.id, row.role) : null
    if (!row || !access) {
      setResponseStatus(403)
      throw new Error('You are not a member of this organization.')
    }
    if (membershipDisabled(row)) {
      setResponseStatus(403)
      throw new Error('Your membership of this organization is disabled. Ask its owner to re-enable it.')
    }
    if (context.session.session.activeOrganizationId !== row.id) {
      await auth.api.setActiveOrganization({ headers: getRequestHeaders(), body: { organizationId: row.id } })
    }
    return { id: row.id, name: row.name, slug: row.slug, ...access }
  })
