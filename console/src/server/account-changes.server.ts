/**
 * The account actions that can wait for a second person (implement/22-console-feedback.md C18):
 * inviting a member or changing a member's role, creating, changing or deleting a custom role
 * (implement/26), and adding an operator account, changing its role or unbanning it. Removing, banning and signing out are never held: they only close access.
 *
 * These run through Better Auth with the signed-in person's own session, which re-checks that
 * person's permissions. That is why an approved request of this kind is applied by the person who
 * asked: the approver need not be someone who may manage accounts (an admin approves an owner's
 * invitation), and Better Auth would refuse the approver's session.
 *
 * One function per action, used both when no approval is required (the action runs at once) and
 * when an approved request is applied. Each validates what it is given: at apply time that is the
 * payload platform-api stored when the request was made.
 */
import { getRequestHeaders } from '@tanstack/react-start/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { inviteOperatorInput } from '@/features/operators/operators.schemas'
import { inviteMemberInput, tenantRole } from '@/features/portal/members.schemas'
import { roleName } from '@/features/portal/roles.schemas'
import type { AppliedResult } from '@/features/approvals/approvals.schemas'
import { PORTAL_ACTION_KEYS, STAFF_ROLES, permissionsForActions, staffRoleOf } from '@/lib/permissions'

import { approvalsFor } from './approvals.server'
import { principalActor, recordEvent } from './audit.server'
import { auth } from './auth.server'
import { consoleDb } from './db.server'
import { member, user } from './db/auth-schema'
import type { Principal } from './middleware'
import { customRole } from './roles.server'

/** Which request this action applies, and who approved it: kept in the audit entry next to who did it. */
export interface Approved {
  request: string
  approvedBy: string | null
}

const approvalDetail = (approved?: Approved) => (approved ? { approval: { request: approved.request, approvedBy: approved.approvedBy } } : {})

const memberInvite = inviteMemberInput.extend({ organizationId: z.string().min(1).max(100) })
const memberRole = z.object({ organizationId: z.string().min(1).max(100), memberId: z.string().min(1).max(100), role: tenantRole, account: z.string().nullable().optional() })
/** A custom role (implement/26). `actions` are the action names for the person who decides; `keys` are what is applied. */
const roleChange = z.object({
  organizationId: z.string().min(1).max(100),
  action: z.enum(['create', 'update', 'delete']),
  role: roleName,
  label: z.string().min(1).max(40).optional(),
  description: z.string().max(200).optional(),
  keys: z.array(z.enum(PORTAL_ACTION_KEYS)).optional(),
  actions: z.array(z.string()).optional(),
})
const operatorRole = z.object({ userId: z.string().min(1).max(100), role: z.enum(STAFF_ROLES), account: z.string().optional() })
const operatorUnban = z.object({ userId: z.string().min(1).max(100), account: z.string().nullable().optional() })

export const ACCOUNT_CHANGE_TYPES = ['member.invite', 'member.role', 'role.change', 'operator.invite', 'operator.role', 'operator.unban'] as const
export type AccountChangeType = (typeof ACCOUNT_CHANGE_TYPES)[number]
export const isAccountChangeType = (type: string): type is AccountChangeType => (ACCOUNT_CHANGE_TYPES as readonly string[]).includes(type)

/** The audit names the account an action was taken on by its email. */
export async function memberEmail(memberId: string) {
  const [row] = await consoleDb().db.select({ email: user.email }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.id, memberId))
  return row?.email ?? null
}

/** An account of the operator area: never a tenant member's account. */
export async function staffAccount(userId: string) {
  const [row] = await consoleDb().db.select({ id: user.id, email: user.email, name: user.name, role: user.role }).from(user).where(eq(user.id, userId))
  const role = staffRoleOf(row?.role)
  if (!row || !role) throw new Error('This is not an operator or auditor account.')
  return { ...row, role }
}

/**
 * Performs one account action as the signed-in person. `organizationId`: the organization the person
 * is acting in; a member action whose payload names another one is refused.
 */
export async function performAccountChange(principal: Principal, type: AccountChangeType, payload: unknown, options: { organizationId?: string; approved?: Approved } = {}) {
  const headers = getRequestHeaders()
  const actor = principalActor(principal)
  const approval = approvalDetail(options.approved)
  const sameOrganization = (organizationId: string) => {
    if (organizationId !== options.organizationId) throw new Error('This request belongs to another organization.')
  }

  switch (type) {
    case 'member.invite': {
      const data = memberInvite.parse(payload)
      sameOrganization(data.organizationId)
      await auth.api.createInvitation({ headers, body: { email: data.email, role: data.role, organizationId: data.organizationId } })
      await recordEvent({ type: 'account.member_invited', actor, tenantId: principal.tenantId, detail: { account: data.email, role: data.role, ...approval } })
      return
    }
    case 'member.role': {
      const data = memberRole.parse(payload)
      sameOrganization(data.organizationId)
      await auth.api.updateMemberRole({ headers, body: { memberId: data.memberId, role: data.role, organizationId: data.organizationId } })
      await recordEvent({ type: 'account.member_role_changed', actor, tenantId: principal.tenantId, detail: { account: await memberEmail(data.memberId), memberId: data.memberId, role: data.role, ...approval } })
      return
    }
    case 'role.change': {
      const data = roleChange.parse(payload)
      sameOrganization(data.organizationId)
      const keys = data.keys ?? []
      if (data.action === 'create') {
        await auth.api.createOrgRole({ headers, body: { organizationId: data.organizationId, role: data.role, permission: permissionsForActions(keys) as Record<string, string[]>, additionalFields: { label: data.label ?? data.role, description: data.description ?? '' } } })
      } else {
        const existing = await customRole(data.organizationId, data.role)
        if (!existing) throw new Error('This organization has no such role any more.')
        if (data.action === 'update') {
          await auth.api.updateOrgRole({ headers, body: { organizationId: data.organizationId, roleName: data.role, data: { permission: permissionsForActions(keys) as Record<string, string[]>, label: data.label ?? existing.label, description: data.description ?? existing.description } } })
        } else {
          await auth.api.deleteOrgRole({ headers, body: { organizationId: data.organizationId, roleName: data.role } })
        }
      }
      const type = data.action === 'create' ? 'account.role_created' : data.action === 'update' ? 'account.role_updated' : 'account.role_deleted'
      await recordEvent({ type, actor, tenantId: principal.tenantId, detail: { role: data.role, label: data.label ?? null, actions: data.action === 'delete' ? null : keys, ...approval } })
      return
    }
    case 'operator.invite': {
      const data = inviteOperatorInput.parse(payload)
      await auth.api.createUser({ headers, body: { email: data.email, name: data.name, role: data.role } })
      await recordEvent({ type: 'account.operator_invited', actor, detail: { account: data.email, name: data.name, role: data.role, ...approval } })
      await auth.api.requestPasswordReset({ body: { email: data.email, redirectTo: '/reset-password' } })
      return
    }
    case 'operator.role': {
      const data = operatorRole.parse(payload)
      if (data.userId === principal.actor) throw new Error('You cannot change your own account here.')
      const account = await staffAccount(data.userId)
      await auth.api.setRole({ headers, body: { userId: account.id, role: data.role } })
      await recordEvent({ type: 'account.operator_role_changed', actor, detail: { account: account.email, userId: account.id, role: data.role, previousRole: account.role, ...approval } })
      return
    }
    case 'operator.unban': {
      const data = operatorUnban.parse(payload)
      const account = await staffAccount(data.userId)
      await auth.api.unbanUser({ headers, body: { userId: account.id } })
      // An account disabled for not being used starts its count again, or the next hourly pass would
      // disable it at once (implement/24).
      await consoleDb().db.update(user).set({ lastSignInAt: new Date() }).where(eq(user.id, account.id))
      await recordEvent({ type: 'account.operator_unbanned', actor, detail: { account: account.email, userId: account.id, ...approval } })
      return
    }
  }
}

/**
 * The person who asked applies an approved request (implement/22 C19).
 *
 * A platform change is made by platform-api at this moment; if its answer holds a secret (a new API
 * key, a webhook signing secret) it is returned here to be shown once. An account change is performed
 * here, under this person's session, and its outcome reported to platform-api, which closes the
 * request as applied or as failed with the reason.
 */
export async function applyApproved(principal: Principal, tenantId: string | null, id: string, organizationId?: string): Promise<AppliedResult> {
  const approvals = approvalsFor(principal, tenantId)
  const taken = await approvals.apply(id)

  if (taken.result) {
    const ok = taken.result.statusCode < 400
    const body = (taken.result.body ?? {}) as { apiKey?: unknown; secret?: unknown }
    const secret = !ok ? null : typeof body.apiKey === 'string' ? { kind: 'api_key' as const, value: body.apiKey } : typeof body.secret === 'string' ? { kind: 'webhook_secret' as const, value: body.secret } : null
    return { status: taken.request.status, error: ok ? null : (taken.request.applyError ?? 'The change was refused.'), secret }
  }

  const type = taken.request.type
  try {
    if (!isAccountChangeType(type)) throw new Error('The console does not know how to make this change.')
    await performAccountChange(principal, type, taken.payload, { organizationId, approved: { request: id, approvedBy: taken.request.decidedByLabel ?? taken.request.decidedBy } })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'The change could not be made.'
    const failed = await approvals.applied(id, { ok: false, error: reason.slice(0, 500) })
    return { status: failed.status, error: reason, secret: null }
  }
  const done = await approvals.applied(id, { ok: true })
  return { status: done.status, error: null, secret: null }
}
