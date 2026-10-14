/**
 * Server-function middleware: the console's data boundary. Route guards (`beforeLoad`) are UX only
 * (TanStack Start auth guidance); every server function that reads or changes platform data uses
 * `operatorMiddleware` or `tenantMiddleware(...)`, which produce the Principal that `platformFor`
 * requires.
 *
 *   authMiddleware      Better Auth session + 2FA enabled (Better Auth makes 2FA opt-in per user)
 *   staffMiddleware(action) a platform role that holds the operator-area action (lib/permissions.ts,
 *                           implement/26), session younger than 12 h, verified TOTP secret
 *   operatorReadMiddleware  `view-tenants`: operators and auditors. For reads only (implement/22 C14)
 *   operatorMiddleware      `operate`: operators. Everything that changes something uses this
 *   tenantMiddleware    an enabled membership of the session's active organization (never an id from
 *                       input), optional permission check against the member's roles, custom roles
 *                       included (implement/26)
 */
import { redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { getRequestHeaders, setResponseHeader, setResponseStatus } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'

import { type PermissionRequest, type Permissions, type StaffAction, type StaffRole, type TenantRole, baseRoleFor, canDo, sessionExpired, staffCan, staffRoleOf } from '../lib/permissions'
import { membershipDisabled, passwordExpired, sessionIdle } from '../lib/sign-in-rules'
import { auth } from './auth.server'
import { consoleDb } from './db.server'
import { member, organization, twoFactor } from './db/auth-schema'
import { serverEnv } from './env.server'
import { effectivePermissions, memberRoleNames } from './permissions.server'
import { endIdleSession } from './sign-in-rules.server'

declare const principalBrand: unique symbol

/** Who is calling platform-api. Only this module creates one. */
export type Principal = {
  readonly [principalBrand]: true
  /** Better Auth user id; sent as `x-console-actor` and recorded in platform-api's audit log. */
  readonly actor: string
  /** The account's email; sent as `x-console-actor-label` so an audit row stays readable after the account is deleted. */
  readonly email: string
  /** For tenant members, the built-in role nearest to their roles (`baseRoleFor`): platform-api knows no custom role. */
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

export const authMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!session) signInAgain()
  // Operators 12 h, everyone else 24 h from sign-in (lib/permissions.ts, review L11).
  if (sessionExpired(session.user.role, session.session.createdAt)) signInAgain()
  // No activity for CONSOLE_IDLE_TIMEOUT_MINUTES (implement/24). Only touchSession extends it: a call
  // made by a page in the background is not activity, or a page left open would never time out.
  const env = serverEnv()
  if (sessionIdle(session.session.lastActiveAt, session.session.createdAt, env.CONSOLE_IDLE_TIMEOUT_MINUTES)) {
    await endIdleSession(session.session.token, session.user)
    signInAgain()
  }
  if (!session.user.twoFactorEnabled) refuse(403, 'set up two-factor authentication first')
  // An old password must be changed first (implement/24); the change itself goes to Better Auth, not here.
  if (passwordExpired(session.user.passwordChangedAt, env.CONSOLE_PASSWORD_MAX_AGE_DAYS)) refuse(403, 'your password has expired; change it first')
  // Everything behind this middleware depends on who is asking.
  setResponseHeader('Cache-Control', 'no-store')
  return next({ context: { session } })
})

export const staffMiddleware = (action: StaffAction) =>
  createMiddleware({ type: 'function' })
    .middleware([authMiddleware])
    .server(async ({ next, context }) => {
      const { user } = context.session
      const role = staffRoleOf(user.role)
      if (!role) refuse(403, 'operator role required')
      if (!staffCan(role, action)) refuse(403, role === 'auditor' ? 'auditors are read-only' : 'your role does not allow this')
      const [totp] = await consoleDb().db.select({ verified: twoFactor.verified }).from(twoFactor).where(eq(twoFactor.userId, user.id))
      if (!totp?.verified) refuse(403, 'operators must use an authenticator app')
      return next({ context: { principal: principal({ actor: user.id, email: user.email, role, tenantId: null }) } })
    })

/** Reads of the operator area: operators and auditors. Never on a function that changes something. */
export const operatorReadMiddleware = staffMiddleware('view-tenants')
export const operatorMiddleware = staffMiddleware('operate')

export function tenantMiddleware(permissions?: PermissionRequest) {
  return createMiddleware({ type: 'function' })
    .middleware([authMiddleware])
    .server(async ({ next, context }) => {
      const { user, session } = context.session
      const organizationId = session.activeOrganizationId
      if (!organizationId) refuse(403, 'choose an organization first')
      const [membership] = await consoleDb()
        .db.select({ role: member.role, disabledAt: member.disabledAt, disabledUntil: member.disabledUntil, platformTenantId: organization.platformTenantId, slug: organization.slug })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(and(eq(member.userId, user.id), eq(member.organizationId, organizationId)))
      if (!membership) refuse(403, 'not a member of this organization')
      if (membershipDisabled(membership)) refuse(403, 'your membership of this organization is disabled')

      // Better Auth stores several organization roles as a comma-separated string; custom roles count too.
      const granted: Permissions = await effectivePermissions(organizationId, memberRoleNames(membership.role))
      if (Object.keys(granted).length === 0) refuse(403, 'no console role in this organization')
      if (permissions && !canDo(granted, permissions)) refuse(403, 'your role does not allow this')

      return next({
        context: {
          principal: principal({ actor: user.id, email: user.email, role: baseRoleFor(granted), tenantId: membership.platformTenantId }),
          organization: { id: organizationId, slug: membership.slug },
          permissions: granted,
        },
      })
    })
}
