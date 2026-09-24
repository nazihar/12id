/**
 * Operator accounts (Phase 4 stage 4a), through Better Auth's admin plugin. Calls pass the signed-in
 * operator's own session, so Better Auth re-checks the operator role's permissions as well.
 * A new operator receives a set-password link and must set up an authenticator app at first sign-in.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { z } from 'zod'

import { type SQL, and, count, desc, eq, ilike, isNull, or } from 'drizzle-orm'

import { inviteOperatorInput, operatorSearch } from '@/features/operators/operators.schemas'
import { likeContains, pageParams } from '@/lib/list-search'
import { OPERATOR_ROLE } from '@/lib/permissions'
import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { user } from '@/server/db/auth-schema'
import { operatorMiddleware } from '@/server/middleware'

const userInput = z.object({ userId: z.string().min(1).max(100) })

/** One page of operator accounts, newest first (Phase 4 C9): search by name or email, filter by status. */
export const listOperators = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(operatorSearch)
  .handler(async ({ data }) => {
    const { db } = consoleDb()
    const { page, pageSize, q } = pageParams(data)
    const filters: SQL[] = [eq(user.role, OPERATOR_ROLE)]
    if (data.status) filters.push(data.status === 'banned' ? eq(user.banned, true) : or(isNull(user.banned), eq(user.banned, false))!)
    if (q) {
      const pattern = likeContains(q)
      filters.push(or(ilike(user.email, pattern), ilike(user.name, pattern))!)
    }
    const where = and(...filters)
    const [rows, [{ total }]] = await Promise.all([
      db.select({ id: user.id, email: user.email, name: user.name, banned: user.banned, createdAt: user.createdAt }).from(user).where(where).orderBy(desc(user.createdAt), desc(user.id)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ total: count() }).from(user).where(where),
    ])
    const items = rows.map((operator) => ({ ...operator, banned: Boolean(operator.banned), createdAt: operator.createdAt.toISOString() }))
    return { items, total, page, pageSize }
  })

export const inviteOperator = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(inviteOperatorInput)
  .handler(async ({ data }) => {
    await auth.api.createUser({ headers: getRequestHeaders(), body: { email: data.email, name: data.name, role: OPERATOR_ROLE } })
    await auth.api.requestPasswordReset({ body: { email: data.email, redirectTo: '/reset-password' } })
    return { email: data.email }
  })

export const banOperator = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(userInput.extend({ reason: z.string().trim().max(200).optional() }))
  .handler(async ({ context, data }) => {
    if (data.userId === context.principal.actor) throw new Error('You cannot ban your own account.')
    // Banning also revokes the user's sessions.
    await auth.api.banUser({ headers: getRequestHeaders(), body: { userId: data.userId, banReason: data.reason } })
    return { banned: true }
  })

export const unbanOperator = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(userInput)
  .handler(async ({ data }) => {
    await auth.api.unbanUser({ headers: getRequestHeaders(), body: { userId: data.userId } })
    return { banned: false }
  })

export const revokeOperatorSessions = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(userInput)
  .handler(async ({ data }) => {
    await auth.api.revokeUserSessions({ headers: getRequestHeaders(), body: { userId: data.userId } })
    return { revoked: true }
  })
