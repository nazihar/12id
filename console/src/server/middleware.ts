/**
 * Server-function middleware: the console's data boundary. Route guards (`beforeLoad`) are UX only
 * (TanStack Start auth guidance); every server function that reads or changes platform data uses
 * `operatorMiddleware` or `tenantMiddleware(...)`, which produce the Principal that `platformFor`
 * requires.
 *
 *   authMiddleware      Better Auth session + 2FA enabled (Better Auth makes 2FA opt-in per user)
 *   operatorMiddleware  platform role `operator`, session younger than 12 h, verified TOTP secret
 *   tenantMiddleware    membership of the session's active organization (never an id from input),
 *                       optional permission check against the member's role
 */
import { redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { getRequestHeaders, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'

import { OPERATOR_ROLE, type TenantRole, hasPlatformRole, operatorSessionExpired, tenantRoles } from '../lib/permissions'
import { auth } from './auth.server'
import { consoleDb } from './db.server'
import { member, organization, twoFactor } from './db/auth-schema'

declare const principalBrand: unique symbol

/** Who is calling platform-api. Only this module creates one. */
export type Principal = {
  readonly [principalBrand]: true
  /** Better Auth user id; sent as `x-console-actor` and recorded in platform-api's audit log. */
  readonly actor: string
  readonly role: typeof OPERATOR_ROLE | TenantRole
  /** Platform tenant id for tenant members; null for operators, who name the tenant per call. */
  readonly tenantId: string | null
}

const principal = (value: Omit<Principal, typeof principalBrand>) => value as Principal

export class ConsoleAuthError extends Error {
  public readonly status: 401 | 403

  public constructor(status: 401 | 403, message: string) {
    super(message)
    this.name = 'ConsoleAuthError'
    this.status = status
  }
}

function refuse(status: 401 | 403, message: string): never {
  setResponseStatus(status)
  throw new ConsoleAuthError(status, message)
}

/**
 * No usable session: the caller must sign in again. Thrown as a router redirect, which the client
 * follows from a loader, and which `followRedirects` in router.tsx follows from a query or mutation;
 * an error message on the page would leave the person stuck with no way forward.
 */
function signInAgain(): never {
  throw redirect({ to: '/login' })
}

type TenantPermissions = Parameters<(typeof tenantRoles)['owner']['authorize']>[0]

export const authMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!session) signInAgain()
  if (!session.user.twoFactorEnabled) refuse(403, 'set up two-factor authentication first')
  // Everything behind this middleware depends on who is asking.
  setResponseHeader('Cache-Control', 'no-store')
  return next({ context: { session } })
})

export const operatorMiddleware = createMiddleware({ type: 'function' })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    const { user, session } = context.session
    if (!hasPlatformRole(user.role, OPERATOR_ROLE)) refuse(403, 'operator role required')
    if (operatorSessionExpired(session.createdAt)) signInAgain()
    const [totp] = await consoleDb().db.select({ verified: twoFactor.verified }).from(twoFactor).where(eq(twoFactor.userId, user.id))
    if (!totp?.verified) refuse(403, 'operators must use an authenticator app')
    return next({ context: { principal: principal({ actor: user.id, role: OPERATOR_ROLE, tenantId: null }) } })
  })

export function tenantMiddleware(permissions?: TenantPermissions) {
  return createMiddleware({ type: 'function' })
    .middleware([authMiddleware])
    .server(async ({ next, context }) => {
      const { user, session } = context.session
      const organizationId = session.activeOrganizationId
      if (!organizationId) refuse(403, 'choose an organization first')
      const [membership] = await consoleDb()
        .db.select({ role: member.role, platformTenantId: organization.platformTenantId, slug: organization.slug })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(and(eq(member.userId, user.id), eq(member.organizationId, organizationId)))
      if (!membership) refuse(403, 'not a member of this organization')

      // Better Auth stores several organization roles as a comma-separated string.
      const roles = membership.role.split(',').map((r) => r.trim()).filter((r): r is TenantRole => r in tenantRoles)
      if (roles.length === 0) refuse(403, 'no console role in this organization')
      if (permissions && !roles.some((r) => tenantRoles[r].authorize(permissions).success)) refuse(403, 'your role does not allow this')
      const strongest = (['owner', 'admin', 'member'] as const).find((r) => roles.includes(r)) as TenantRole

      return next({
        context: {
          principal: principal({ actor: user.id, role: strongest, tenantId: membership.platformTenantId }),
          organization: { id: organizationId, slug: membership.slug },
        },
      })
    })
}
