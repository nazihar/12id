/**
 * Organization members and invitations (tenant portal). Owners manage people; Better Auth re-checks
 * the organization permissions on every call because the member's own session is passed along.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { inviteMemberInput, tenantRole } from '@/features/portal/members.schemas'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { invitation, member, user } from '@/server/db/auth-schema'
import { tenantMiddleware } from '@/server/middleware'

import { assertSameOrganization, organizationInput } from './organization-input'

export const listMembers = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => {
    const { db } = consoleDb()
    const organizationId = context.organization.id
    const members = await db
      .select({ id: member.id, userId: user.id, name: user.name, email: user.email, role: member.role, since: member.createdAt, twoFactorEnabled: user.twoFactorEnabled })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, organizationId))
    const invitations = await db
      .select({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt, createdAt: invitation.createdAt })
      .from(invitation)
      .where(and(eq(invitation.organizationId, organizationId), eq(invitation.status, 'pending')))
    const now = Date.now()
    return {
      members: members.map((m) => ({ ...m, since: m.since.toISOString(), twoFactorEnabled: Boolean(m.twoFactorEnabled), isYou: m.userId === context.session.user.id })),
      invitations: invitations.map((i) => ({ ...i, role: i.role ?? 'member', expired: i.expiresAt.getTime() < now, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() })),
    }
  })

export const inviteMember = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ invitation: ['create'] })])
  .validator(organizationInput.extend(inviteMemberInput.shape))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    await auth.api.createInvitation({ headers: getRequestHeaders(), body: { email: data.email, role: data.role, organizationId: data.organizationId } })
    return { email: data.email }
  })

export const cancelMemberInvitation = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ invitation: ['cancel'] })])
  .validator(organizationInput.extend({ invitationId: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    await auth.api.cancelInvitation({ headers: getRequestHeaders(), body: { invitationId: data.invitationId } })
    return { cancelled: true }
  })

export const changeMemberRole = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['update'] })])
  .validator(organizationInput.extend({ memberId: z.string().min(1).max(100), role: tenantRole }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    await auth.api.updateMemberRole({ headers: getRequestHeaders(), body: { memberId: data.memberId, role: data.role, organizationId: data.organizationId } })
    return { role: data.role }
  })

export const removeOrganizationMember = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['delete'] })])
  .validator(organizationInput.extend({ memberId: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    await auth.api.removeMember({ headers: getRequestHeaders(), body: { memberIdOrEmail: data.memberId, organizationId: data.organizationId } })
    return { removed: true }
  })
