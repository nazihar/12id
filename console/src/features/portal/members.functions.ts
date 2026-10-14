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

import { disableInput, disabledUntil } from '@/features/operators/operators.schemas'
import { inviteMemberInput, memberSearch, tenantRole } from '@/features/portal/members.schemas'
import { memberEmail, performAccountChange } from '@/server/account-changes.server'
import { askForAccountChange } from '@/server/approvals.server'
import { principalActor, recordEvent } from '@/server/audit.server'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { invitation, member, user } from '@/server/db/auth-schema'
import { liveSessions, memberAccessReport } from '@/server/access-report.server'
import { memberRoleNames } from '@/server/permissions.server'
import { listOrganizationInvitations, listOrganizationMembers, memberAccount } from '@/server/members.server'
import { tenantMiddleware } from '@/server/middleware'
import { staffRoleOf } from '@/lib/permissions'
import { INACTIVE_BAN_PREFIX, membershipDisabled } from '@/lib/sign-in-rules'
import { unlockAccount } from '@/server/sign-in-rules.server'

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

const memberInput = organizationInput.extend({ memberId: z.string().min(1).max(100) })

/**
 * A member's account that an owner may act on (implement/24): in this organization, and never an
 * operator's or auditor's account, which only operators manage.
 */
async function ownersMemberAccount(organizationId: string, memberId: string) {
  const account = await memberAccount(organizationId, memberId)
  if (!account || staffRoleOf(account.role)) throw new Error('No such member in this organization.')
  return account
}

/** Lifts the lock after wrong passwords at once (implement/24, MTB 2.26). */
export const unlockMember = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['update'] })])
  .validator(memberInput)
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const account = await ownersMemberAccount(data.organizationId, data.memberId)
    await unlockAccount(account.userId, principalActor(context.principal), account.email)
    return { unlocked: true }
  })

/**
 * Re-enables a member the inactivity rule disabled (implement/24, MTB 2.28). Only that: an account a
 * person banned stays banned. Not held for a second person: it restores what a rule took away.
 */
export const reenableMember = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['update'] })])
  .validator(memberInput)
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const account = await ownersMemberAccount(data.organizationId, data.memberId)
    if (!account.banned || !account.banReason?.startsWith(INACTIVE_BAN_PREFIX)) throw new Error('Only an account disabled for not being used can be re-enabled here.')
    // Counts as a fresh start: without it the next hourly pass would disable the account again.
    await consoleDb().db.update(user).set({ banned: false, banReason: null, banExpires: null, lastSignInAt: new Date() }).where(eq(user.id, account.userId))
    await recordEvent({ type: 'account.reenabled', actor: principalActor(context.principal), tenantId: context.principal.tenantId, detail: { account: account.email, memberId: data.memberId } })
    return { reenabled: true }
  })

/** Mails the member a link to choose a new password (implement/24, MTB 2.37 item 5). It works for 10 minutes. */
export const sendMemberPasswordLink = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['update'] })])
  .validator(memberInput)
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const account = await ownersMemberAccount(data.organizationId, data.memberId)
    if (account.userId === context.session.user.id) throw new Error('Change your own password from your account menu.')
    await auth.api.requestPasswordReset({ body: { email: account.email, redirectTo: '/reset-password' } })
    await recordEvent({ type: 'account.password_link_sent', actor: principalActor(context.principal), tenantId: context.principal.tenantId, detail: { account: account.email, memberId: data.memberId } })
    return { sent: true }
  })

/**
 * implement/26: disable a member in this organization only, until a date or until re-enabled, with a
 * note. Their other organizations and their account are untouched; this one refuses them from their
 * next request. Not held for a second person: it only closes access.
 */
export const disableMembership = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['update'] })])
  .validator(memberInput.extend(disableInput.shape))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const account = await ownersMemberAccount(data.organizationId, data.memberId)
    if (account.userId === context.session.user.id) throw new Error('You cannot disable yourself.')
    // An organization keeps at least one owner who can open it, or nobody could manage its people.
    const owners = await consoleDb()
      .db.select({ id: member.id, role: member.role, disabledAt: member.disabledAt, disabledUntil: member.disabledUntil })
      .from(member)
      .where(eq(member.organizationId, data.organizationId))
    const isOwner = (row: { role: string }) => memberRoleNames(row.role).includes('owner')
    const target = owners.find((row) => row.id === data.memberId)
    if (target && isOwner(target) && !owners.some((row) => row.id !== data.memberId && isOwner(row) && !membershipDisabled(row))) throw new Error('This is the only owner who can open the organization. Make someone else owner first.')
    const until = disabledUntil(data.until)
    await consoleDb().db.update(member).set({ disabledAt: new Date(), disabledUntil: until, disabledNote: data.note }).where(and(eq(member.id, data.memberId), eq(member.organizationId, data.organizationId)))
    await recordEvent({ type: 'account.membership_disabled', actor: principalActor(context.principal), tenantId: context.principal.tenantId, detail: { account: account.email, memberId: data.memberId, until: until?.toISOString() ?? null, note: data.note } })
    return { disabled: true }
  })

/** Lifts an owner's disable of this membership at once (implement/26). Restores access, so it is not held either: the disable was. */
export const reenableMembership = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ member: ['update'] })])
  .validator(memberInput)
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const account = await ownersMemberAccount(data.organizationId, data.memberId)
    if (!membershipDisabled(account)) throw new Error('This membership is not disabled.')
    await consoleDb().db.update(member).set({ disabledAt: null, disabledUntil: null, disabledNote: null }).where(and(eq(member.id, data.memberId), eq(member.organizationId, data.organizationId)))
    await recordEvent({ type: 'account.membership_reenabled', actor: principalActor(context.principal), tenantId: context.principal.tenantId, detail: { account: account.email, memberId: data.memberId } })
    return { reenabled: true }
  })

/** Totals for the Members page (implement/26): states, never signed in, without 2FA, signed in now, by role. */
export const getMemberAccessReport = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => memberAccessReport(context.organization.id))

/** Members signed in now (MTB 6.106). Read-only here: an owner disables a membership instead of ending a session, which would sign the person out of their other organizations too. */
export const listMemberSessions = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => liveSessions({ organizationId: context.organization.id }))
