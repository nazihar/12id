/**
 * Organization members and invitations (tenant portal). Owners manage people; Better Auth re-checks
 * the organization permissions on every call because the member's own session is passed along.
 *
 * Where the organization requires a second person (implement/22 C18), inviting a member and changing
 * a role are stored as a request and answer `{ held }`; removing a member and cancelling an
 * invitation never wait, because they only close access.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { inviteMemberInput, memberSearch, tenantRole } from '@/features/portal/members.schemas'
import { memberEmail, performAccountChange } from '@/server/account-changes.server'
import { askForAccountChange } from '@/server/approvals.server'
import { principalActor, recordEvent } from '@/server/audit.server'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { invitation } from '@/server/db/auth-schema'
import { listOrganizationInvitations, listOrganizationMembers } from '@/server/members.server'
import { tenantMiddleware } from '@/server/middleware'

import { assertSameOrganization, organizationInput } from './organization-input'

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
    const change = { email: data.email, role: data.role, organizationId: data.organizationId }
    const held = await askForAccountChange(context.principal, context.principal.tenantId, 'member.invite', change)
    if (held) return held
    await performAccountChange(context.principal, 'member.invite', change, { organizationId: context.organization.id })
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
    // `account` is only for the person who decides: the request names who it is about.
    const change = { organizationId: data.organizationId, memberId: data.memberId, role: data.role }
    const held = await askForAccountChange(context.principal, context.principal.tenantId, 'member.role', { ...change, account: await memberEmail(data.memberId) })
    if (held) return held
    await performAccountChange(context.principal, 'member.role', change, { organizationId: context.organization.id })
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
