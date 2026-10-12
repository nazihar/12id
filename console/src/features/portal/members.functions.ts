/**
 * Organization members and invitations (tenant portal). Owners manage people; Better Auth re-checks
 * the organization permissions on every call because the member's own session is passed along.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { inviteMemberInput, memberSearch, tenantRole } from '@/features/portal/members.schemas'
import { principalActor, recordEvent } from '@/server/audit.server'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { invitation, member, user } from '@/server/db/auth-schema'
import { listOrganizationInvitations, listOrganizationMembers } from '@/server/members.server'
import { tenantMiddleware } from '@/server/middleware'

import { assertSameOrganization, organizationInput } from './organization-input'

/** The audit names the account an action was taken on by its email. */
async function memberEmail(memberId: string) {
  const [row] = await consoleDb().db.select({ email: user.email }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.id, memberId))
  return row?.email ?? null
}

/** One page of members or of pending invitations (`tab`), newest first (Phase 4 C9). */
export const listMembers = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(memberSearch)
  .handler(async ({ context, data }) => {
    const organizationId = context.organization.id
    if (data.tab === 'invitations') return { tab: 'invitations' as const, page: await listOrganizationInvitations(organizationId, data) }
    const page = await listOrganizationMembers(organizationId, data)
    return { tab: 'members' as const, page: { ...page, items: page.items.map((m) => ({ ...m, isYou: m.userId === context.session.user.id })) } }
  })

export const inviteMember = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ invitation: ['create'] })])
  .validator(organizationInput.extend(inviteMemberInput.shape))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    await auth.api.createInvitation({ headers: getRequestHeaders(), body: { email: data.email, role: data.role, organizationId: data.organizationId } })
    await recordEvent({ type: 'account.member_invited', actor: principalActor(context.principal), tenantId: context.principal.tenantId, detail: { account: data.email, role: data.role } })
    return { email: data.email }
  })

export const cancelMemberInvitation = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ invitation: ['cancel'] })])
  .validator(organizationInput.extend({ invitationId: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const [invited] = await consoleDb().db.select({ email: invitation.email }).from(invitation).where(eq(invitation.id, data.invitationId))
    await auth.api.cancelInvitation({ headers: getRequestHeaders(), body: { invitationId: data.invitationId } })
    await recordEvent({ type: 'account.invitation_cancelled', actor: principalActor(context.principal), tenantId: context.principal.tenantId, detail: { account: invited?.email ?? null, invitationId: data.invitationId } })
    return { cancelled: true }
  })

export const changeMemberRole = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['update'] })])
  .validator(organizationInput.extend({ memberId: z.string().min(1).max(100), role: tenantRole }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    await auth.api.updateMemberRole({ headers: getRequestHeaders(), body: { memberId: data.memberId, role: data.role, organizationId: data.organizationId } })
    await recordEvent({ type: 'account.member_role_changed', actor: principalActor(context.principal), tenantId: context.principal.tenantId, detail: { account: await memberEmail(data.memberId), memberId: data.memberId, role: data.role } })
    return { role: data.role }
  })

export const removeOrganizationMember = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['delete'] })])
  .validator(organizationInput.extend({ memberId: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    // Read before the removal: afterwards the membership that names the account is gone.
    const account = await memberEmail(data.memberId)
    await auth.api.removeMember({ headers: getRequestHeaders(), body: { memberIdOrEmail: data.memberId, organizationId: data.organizationId } })
    await recordEvent({ type: 'account.member_removed', actor: principalActor(context.principal), tenantId: context.principal.tenantId, detail: { account, memberId: data.memberId } })
    return { removed: true }
  })
