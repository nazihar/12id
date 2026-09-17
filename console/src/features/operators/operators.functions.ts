/**
 * Operator accounts (Phase 4 stage 4a), through Better Auth's admin plugin. Calls pass the signed-in
 * operator's own session, so Better Auth re-checks the operator role's permissions as well.
 * A new operator receives a set-password link and must set up an authenticator app at first sign-in.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { z } from 'zod'

import { inviteOperatorInput } from '@/features/operators/operators.schemas'
import { OPERATOR_ROLE } from '@/lib/permissions'
import { auth } from '@/server/auth.server'
import { operatorMiddleware } from '@/server/middleware'

const userInput = z.object({ userId: z.string().min(1).max(100) })

export const listOperators = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .handler(async () => {
    const result = await auth.api.listUsers({
      headers: getRequestHeaders(),
      query: { filterField: 'role', filterValue: OPERATOR_ROLE, limit: 200, sortBy: 'createdAt', sortDirection: 'desc' },
    })
    return result.users.map((operator) => ({
      id: operator.id,
      email: operator.email,
      name: operator.name,
      banned: Boolean(operator.banned),
      createdAt: new Date(operator.createdAt).toISOString(),
    }))
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
