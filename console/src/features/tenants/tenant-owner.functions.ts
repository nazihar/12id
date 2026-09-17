/**
 * A tenant's console organization and its first owner (Phase 4 stage 4a).
 *
 * Operators create both server-side: accounts are invite-only, and the operator never becomes a
 * member of a tenant's organization. Better Auth treats `createOrganization` with a `userId` and no
 * session as a system action, so user-created organizations stay disabled. A new owner receives a
 * set-password link (Better Auth's reset flow creates the credential account on first use).
 */
import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { createTenantOrganizationInput, tenantInput } from '@/features/tenants/tenants.schemas'
import { OPERATOR_ROLE, hasPlatformRole } from '@/lib/permissions'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { member, organization, user } from '@/server/db/auth-schema'
import { operatorMiddleware } from '@/server/middleware'
import { platformFor, unwrap } from '@/server/platform.server'

function slugFor(name: string, tenantId: string) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${base || 'tenant'}-${tenantId.slice(0, 8)}`
}

export const getTenantOrganization = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ data }) => {
    const { db } = consoleDb()
    const [org] = await db.select({ id: organization.id, name: organization.name, slug: organization.slug }).from(organization).where(eq(organization.platformTenantId, data.tenantId))
    if (!org) return null
    const members = await db
      .select({ userId: user.id, email: user.email, name: user.name, role: member.role, since: member.createdAt, twoFactorEnabled: user.twoFactorEnabled })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, org.id))
    return { ...org, members: members.map((m) => ({ ...m, since: m.since.toISOString(), twoFactorEnabled: Boolean(m.twoFactorEnabled) })) }
  })

export const createTenantOrganization = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(createTenantOrganizationInput.shape))
  .handler(async ({ context, data }) => {
    const tenant = unwrap(await platformFor(context.principal).GET('/admin/tenants/{id}', { params: { path: { id: data.tenantId } } }))
    if (tenant.status !== 'ready') throw new Error(`The tenant is ${tenant.status}; finish onboarding first.`)

    const { db } = consoleDb()
    const [existing] = await db.select({ id: organization.id }).from(organization).where(eq(organization.platformTenantId, data.tenantId))
    if (existing) throw new Error('This tenant already has a console organization.')

    let [owner] = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.email, data.ownerEmail))
    if (owner && hasPlatformRole(owner.role, OPERATOR_ROLE)) throw new Error('An operator account cannot own a tenant organization. Use a separate account.')
    const isNewAccount = !owner
    if (!owner) {
      // No request headers: a server-side call, which the admin plugin accepts without an admin session.
      const created = await auth.api.createUser({ body: { email: data.ownerEmail, name: data.ownerName } })
      owner = { id: created.user.id, role: created.user.role ?? null }
    }

    const created = await auth.api.createOrganization({
      body: { name: tenant.name, slug: slugFor(tenant.name, data.tenantId), platformTenantId: data.tenantId, userId: owner.id },
    })
    if (isNewAccount) await auth.api.requestPasswordReset({ body: { email: data.ownerEmail, redirectTo: '/reset-password' } })
    return { organizationId: created?.id ?? null, ownerEmail: data.ownerEmail, passwordLinkSent: isNewAccount }
  })
