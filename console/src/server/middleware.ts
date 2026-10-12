/**
 * Server-function middleware: the console's data boundary. Route guards (`beforeLoad`) are UX only
 * (TanStack Start auth guidance); every server function that reads or changes platform data uses
 * `operatorMiddleware` or `tenantMiddleware(...)`, which produce the Principal that `platformFor`
 * requires.
 *
 *   authMiddleware      Better Auth session + 2FA enabled (Better Auth makes 2FA opt-in per user)
 *   operatorReadMiddleware  platform role `operator` or `auditor`, session younger than 12 h, verified
 *                           TOTP secret. For reads only: an auditor changes nothing (implement/22 C14)
 *   operatorMiddleware      the same, `operator` only. Everything that changes something uses this
 *   tenantMiddleware    membership of the session's active organization (never an id from input),
 *                       optional permission check against the member's role
 */
import { redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { getRequestHeaders, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'

import { AUDITOR_ROLE, OPERATOR_ROLE, type StaffRole, type TenantRole, sessionExpired, staffRoleOf, tenantRoles } from '../lib/permissions'
import { auth } from './auth.server'
import { consoleDb } from './db.server'
import { member, organization, twoFactor } from './db/auth-schema'

declare const principalBrand: unique symbol

/** Who is calling platform-api. Only this module creates one. */
export type Principal = {
  readonly [principalBrand]: true
  /** Better Auth user id; sent as `x-console-actor` and recorded in platform-api's audit log. */
  readonly actor: string
  /** The account's email; sent as `x-console-actor-label` so an audit row stays readable after the account is deleted. */
  readonly email: string
  readonly role: StaffRole | TenantRole
  /** Platform tenant id for tenant members; null for operators and auditors, who name the tenant per call. */
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
  // Operators 12 h, everyone else 24 h from sign-in (lib/permissions.ts, review L11).
  if (sessionExpired(session.user.role, session.session.createdAt)) signInAgain()
  if (!session.user.twoFactorEnabled) refuse(403, 'set up two-factor authentication first')
  // Everything behind this middleware depends on who is asking.
  setResponseHeader('Cache-Control', 'no-store')
  return next({ context: { session } })
})

const staffMiddleware = (allowed: readonly StaffRole[]) =>
  createMiddleware({ type: 'function' })
    .middleware([authMiddleware])
    .server(async ({ next, context }) => {
      const { user } = context.session
      const role = staffRoleOf(user.role)
      if (!role) refuse(403, 'operator role required')
      if (!allowed.includes(role)) refuse(403, 'auditors are read-only')
      const [totp] = await consoleDb().db.select({ verified: twoFactor.verified }).from(twoFactor).where(eq(twoFactor.userId, user.id))
      if (!totp?.verified) refuse(403, 'operators must use an authenticator app')
      return next({ context: { principal: principal({ actor: user.id, email: user.email, role, tenantId: null }) } })
    })

/** Reads of the operator area: operators and auditors. Never on a function that changes something. */
export const operatorReadMiddleware = staffMiddleware([OPERATOR_ROLE, AUDITOR_ROLE])
export const operatorMiddleware = staffMiddleware([OPERATOR_ROLE])

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
          principal: principal({ actor: user.id, email: user.email, role: strongest, tenantId: membership.platformTenantId }),
          organization: { id: organizationId, slug: membership.slug },
        },
      })
    })
}
