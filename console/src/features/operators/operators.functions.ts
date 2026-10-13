/**
 * Accounts of the operator area (Phase 4 stage 4a; implement/22-console-feedback.md C14), through
 * Better Auth's admin plugin. Calls pass the signed-in operator's own session, so Better Auth
 * re-checks the operator role's permissions as well. Two roles: an operator runs the platform, an
 * auditor reads it and changes nothing. A new account receives a set-password link and must set up
 * an authenticator app at first sign-in.
 *
 * Every change is reported to the audit log (C13), naming the account by its email: after a deletion
 * that is all that is left of it.
 *
 * Where the deployment requires a second operator (`OPERATOR_APPROVALS`, implement/22 C18), adding an
 * account, changing a role and unbanning are stored as a request and answer `{ held }`. Banning,
 * signing out and deleting never wait: they only close access.
 *
 * Nobody acts on their own account here. That also keeps the platform operable: whoever makes a
 * change is an operator who can sign in, and stays one afterwards.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { z } from 'zod'

import { type SQL, and, count, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm'

import { editOperatorInput, inviteOperatorInput, operatorSearch } from '@/features/operators/operators.schemas'
import { likeContains, pageParams } from '@/lib/list-search'
import { STAFF_ROLES, staffRoleOf } from '@/lib/permissions'
import { performAccountChange, staffAccount } from '@/server/account-changes.server'
import { askForAccountChange } from '@/server/approvals.server'
import { principalActor, recordEvent } from '@/server/audit.server'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { user } from '@/server/db/auth-schema'
import { operatorMiddleware, operatorReadMiddleware } from '@/server/middleware'

const userInput = z.object({ userId: z.string().min(1).max(100) })

/** The audit names the account an action was taken on by its email, which outlives the account. */
async function emailOf(userId: string) {
  const [row] = await consoleDb().db.select({ email: user.email }).from(user).where(eq(user.id, userId))
  return row?.email ?? null
}

/** One page of operator and auditor accounts, newest first (Phase 4 C9): search by name or email, filter by role and status. */
export const listOperators = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(operatorSearch)
  .handler(async ({ data }) => {
    const { db } = consoleDb()
    const { page, pageSize, q } = pageParams(data)
    const filters: SQL[] = [data.role ? eq(user.role, data.role) : inArray(user.role, [...STAFF_ROLES])]
    if (data.status) filters.push(data.status === 'banned' ? eq(user.banned, true) : or(isNull(user.banned), eq(user.banned, false))!)
    if (q) {
      const pattern = likeContains(q)
      filters.push(or(ilike(user.email, pattern), ilike(user.name, pattern))!)
    }
    const where = and(...filters)
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ id: user.id, email: user.email, name: user.name, role: user.role, banned: user.banned, twoFactorEnabled: user.twoFactorEnabled, lastSignInAt: user.lastSignInAt, createdAt: user.createdAt })
        .from(user)
        .where(where)
        .orderBy(desc(user.createdAt), desc(user.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ total: count() }).from(user).where(where),
    ])
    const items = rows.map((account) => ({
      ...account,
      role: staffRoleOf(account.role) ?? 'operator',
      banned: Boolean(account.banned),
      twoFactorEnabled: Boolean(account.twoFactorEnabled),
      lastSignInAt: account.lastSignInAt?.toISOString() ?? null,
      createdAt: account.createdAt.toISOString(),
    }))
    return { items, total, page, pageSize }
  })

export const inviteOperator = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(inviteOperatorInput)
  .handler(async ({ context, data }) => {
    const held = await askForAccountChange(context.principal, null, 'operator.invite', data)
    if (held) return held
    await performAccountChange(context.principal, 'operator.invite', data)
    return { email: data.email }
  })

/** Name and role of an operator or auditor account. A role change applies to the account's next request. */
export const editOperator = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(userInput.extend(editOperatorInput.shape))
  .handler(async ({ context, data }) => {
    if (data.userId === context.principal.actor) throw new Error('You cannot change your own account here.')
    const account = await staffAccount(data.userId)
    const actor = principalActor(context.principal)
    if (data.name !== account.name) {
      await auth.api.adminUpdateUser({ headers: getRequestHeaders(), body: { userId: account.id, data: { name: data.name } } })
      await recordEvent({ type: 'account.operator_updated', actor, detail: { account: account.email, userId: account.id, name: data.name, previousName: account.name } })
    }
    // A name is not access; a role is. Only the role can wait for a second operator.
    if (data.role !== account.role) {
      const change = { userId: account.id, role: data.role }
      const held = await askForAccountChange(context.principal, null, 'operator.role', { ...change, account: account.email })
      if (held) return held
      await performAccountChange(context.principal, 'operator.role', change)
    }
    return { name: data.name, role: data.role }
  })

/** Removes the account and its sessions for good. Its past audit entries keep its email (C13). */
export const deleteOperator = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(userInput)
  .handler(async ({ context, data }) => {
    if (data.userId === context.principal.actor) throw new Error('You cannot delete your own account.')
    const account = await staffAccount(data.userId)
    await auth.api.removeUser({ headers: getRequestHeaders(), body: { userId: account.id } })
    await recordEvent({ type: 'account.operator_deleted', actor: principalActor(context.principal), detail: { account: account.email, userId: account.id, name: account.name, role: account.role } })
    return { deleted: true }
  })

export const banOperator = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(userInput.extend({ reason: z.string().trim().max(200).optional() }))
  .handler(async ({ context, data }) => {
    if (data.userId === context.principal.actor) throw new Error('You cannot ban your own account.')
    // Banning also revokes the user's sessions.
    await auth.api.banUser({ headers: getRequestHeaders(), body: { userId: data.userId, banReason: data.reason } })
    await recordEvent({ type: 'account.operator_banned', actor: principalActor(context.principal), detail: { account: await emailOf(data.userId), userId: data.userId, reason: data.reason } })
    return { banned: true }
  })

export const unbanOperator = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(userInput)
  .handler(async ({ context, data }) => {
    const held = await askForAccountChange(context.principal, null, 'operator.unban', { userId: data.userId, account: await emailOf(data.userId) })
    if (held) return held
    await performAccountChange(context.principal, 'operator.unban', { userId: data.userId })
    return { banned: false }
  })

export const revokeOperatorSessions = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(userInput)
  .handler(async ({ context, data }) => {
    await auth.api.revokeUserSessions({ headers: getRequestHeaders(), body: { userId: data.userId } })
    await recordEvent({ type: 'account.operator_sessions_revoked', actor: principalActor(context.principal), detail: { account: await emailOf(data.userId), userId: data.userId } })
    return { revoked: true }
  })
