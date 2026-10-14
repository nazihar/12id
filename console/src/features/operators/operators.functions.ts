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
 * Account changes need the operator area's `manage-staff` action (implement/26); reading the lists,
 * the access report and who is signed in needs `view-tenants`, so an auditor sees them too.
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

import { eq } from 'drizzle-orm'

import { disableInput, disabledUntil, editOperatorInput, inviteOperatorInput, operatorSearch } from '@/features/operators/operators.schemas'
import { performAccountChange, staffAccount } from '@/server/account-changes.server'
import { askForAccountChange } from '@/server/approvals.server'
import { principalActor, recordEvent } from '@/server/audit.server'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { session, user } from '@/server/db/auth-schema'
import { liveSessions, staffAccessReport } from '@/server/access-report.server'
import { listStaffAccounts } from '@/server/staff-accounts.server'
import { operatorReadMiddleware, staffMiddleware } from '@/server/middleware'
import { unlockAccount } from '@/server/sign-in-rules.server'

const userInput = z.object({ userId: z.string().min(1).max(100) })


/** The audit names the account an action was taken on by its email, which outlives the account. */
async function emailOf(userId: string) {
  const [row] = await consoleDb().db.select({ email: user.email }).from(user).where(eq(user.id, userId))
  return row?.email ?? null
}

/** One page of operator and auditor accounts, newest first (Phase 4 C9): search by name or email, filter by role and state. */
export const listOperators = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .validator(operatorSearch)
  .handler(({ data }) => listStaffAccounts(data))

export const inviteOperator = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware('manage-staff')])
  .validator(inviteOperatorInput)
  .handler(async ({ context, data }) => {
    const held = await askForAccountChange(context.principal, null, 'operator.invite', data)
    if (held) return held
    await performAccountChange(context.principal, 'operator.invite', data)
    return { email: data.email }
  })

/** Name and role of an operator or auditor account. A role change applies to the account's next request. */
export const editOperator = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware('manage-staff')])
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
  .middleware([staffMiddleware('manage-staff')])
  .validator(userInput)
  .handler(async ({ context, data }) => {
    if (data.userId === context.principal.actor) throw new Error('You cannot delete your own account.')
    const account = await staffAccount(data.userId)
    await auth.api.removeUser({ headers: getRequestHeaders(), body: { userId: account.id } })
    await recordEvent({ type: 'account.operator_deleted', actor: principalActor(context.principal), detail: { account: account.email, userId: account.id, name: account.name, role: account.role } })
    return { deleted: true }
  })

/**
 * Disables the account until a day or until re-enabled, with a note (implement/26). Better Auth lifts a
 * dated disable at the next sign-in after it ends; it also ends the account's sessions now.
 */
export const banOperator = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware('manage-staff')])
  .validator(userInput.extend(disableInput.shape))
  .handler(async ({ context, data }) => {
    if (data.userId === context.principal.actor) throw new Error('You cannot disable your own account.')
    const until = disabledUntil(data.until)
    const banExpiresIn = until ? Math.ceil((until.getTime() - Date.now()) / 1000) : undefined
    await auth.api.banUser({ headers: getRequestHeaders(), body: { userId: data.userId, banReason: data.note, banExpiresIn } })
    await recordEvent({ type: 'account.operator_banned', actor: principalActor(context.principal), detail: { account: await emailOf(data.userId), userId: data.userId, reason: data.note, until: until?.toISOString() ?? null } })
    return { banned: true }
  })

export const unbanOperator = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware('manage-staff')])
  .validator(userInput)
  .handler(async ({ context, data }) => {
    const held = await askForAccountChange(context.principal, null, 'operator.unban', { userId: data.userId, account: await emailOf(data.userId) })
    if (held) return held
    await performAccountChange(context.principal, 'operator.unban', { userId: data.userId })
    return { banned: false }
  })

export const revokeOperatorSessions = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware('manage-staff')])
  .validator(userInput)
  .handler(async ({ context, data }) => {
    await auth.api.revokeUserSessions({ headers: getRequestHeaders(), body: { userId: data.userId } })
    await recordEvent({ type: 'account.operator_sessions_revoked', actor: principalActor(context.principal), detail: { account: await emailOf(data.userId), userId: data.userId } })
    return { revoked: true }
  })

/** Lifts the lock after wrong passwords at once (implement/24, MTB 2.26). Never held: it only restores what the rules took. */
export const unlockOperator = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware('manage-staff')])
  .validator(userInput)
  .handler(async ({ context, data }) => {
    if (!(await staffAccount(data.userId))) throw new Error('No such operator account.')
    await unlockAccount(data.userId, principalActor(context.principal), await emailOf(data.userId))
    return { unlocked: true }
  })

/** Mails the account a link to choose a new password (implement/24, MTB 2.37 item 5). It works for 10 minutes. */
export const sendOperatorPasswordLink = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware('manage-staff')])
  .validator(userInput)
  .handler(async ({ context, data }) => {
    if (data.userId === context.principal.actor) throw new Error('Change your own password from your account menu.')
    const email = await emailOf(data.userId)
    if (!email || !(await staffAccount(data.userId))) throw new Error('No such operator account.')
    await auth.api.requestPasswordReset({ body: { email, redirectTo: '/reset-password' } })
    await recordEvent({ type: 'account.password_link_sent', actor: principalActor(context.principal), detail: { account: email, userId: data.userId } })
    return { sent: true }
  })

/** Totals for the Operators page (implement/26): states, never signed in, without 2FA, signed in now, by role. */
export const getStaffAccessReport = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .handler(() => staffAccessReport())

/** Operator-area accounts signed in now (MTB 6.106). */
export const listStaffSessions = createServerFn({ method: 'GET' })
  .middleware([operatorReadMiddleware])
  .handler(() => liveSessions({ staff: true }))

/** Ends one session of a staff account at once (implement/26). Never held: it only closes access. */
export const endStaffSession = createServerFn({ method: 'POST' })
  .middleware([staffMiddleware('manage-staff')])
  .validator(z.object({ sessionId: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    const [row] = await consoleDb().db.select({ userId: session.userId, token: session.token }).from(session).where(eq(session.id, data.sessionId))
    if (!row || !(await staffAccount(row.userId))) throw new Error('This session has ended already.')
    if (row.userId === context.principal.actor) throw new Error('Sign out from your account menu instead.')
    await consoleDb().db.delete(session).where(eq(session.id, data.sessionId))
    await recordEvent({ type: 'account.session_ended', actor: principalActor(context.principal), detail: { account: await emailOf(row.userId), userId: row.userId } })
    return { ended: true }
  })
