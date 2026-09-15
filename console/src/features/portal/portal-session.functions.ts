/**
 * The tenant portal's organization context. Session-only (authMiddleware): these answer about the
 * caller's own memberships and never return tenant data.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders, setResponseStatus } from '@tanstack/react-start/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'

import type { TenantRole } from '@/lib/permissions'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { member, organization } from '@/server/db/auth-schema'
import { authMiddleware } from '@/server/middleware'

const ROLE_ORDER = ['owner', 'admin', 'member'] as const

function strongestRole(value: string): TenantRole | null {
  const roles = value.split(',').map((role) => role.trim())
  return ROLE_ORDER.find((role) => roles.includes(role)) ?? null
}

export const listMyOrganizations = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const rows = await consoleDb()
      .db.select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, context.session.user.id))
      .orderBy(asc(organization.name))
    return rows.flatMap((row) => {
      const role = strongestRole(row.role)
      return role ? [{ id: row.id, name: row.name, slug: row.slug, role }] : []
    })
  })

/** Makes the organization in the URL the session's active one; tenantMiddleware reads it from there. */
export const activateOrganization = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(z.object({ slug: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    const [row] = await consoleDb()
      .db.select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(and(eq(member.userId, context.session.user.id), eq(organization.slug, data.slug)))
    const role = row ? strongestRole(row.role) : null
    if (!row || !role) {
      setResponseStatus(403)
      throw new Error('You are not a member of this organization.')
    }
    if (context.session.session.activeOrganizationId !== row.id) {
      await auth.api.setActiveOrganization({ headers: getRequestHeaders(), body: { organizationId: row.id } })
    }
    return { id: row.id, name: row.name, slug: row.slug, role }
  })
