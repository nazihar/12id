/**
 * Roles and permissions, shared by the Better Auth server and client plugins (Phase 4).
 *
 *   tenant roles (organization plugin, one tenant)   owner, admin, member
 *   platform role (admin plugin, every tenant)       operator
 *
 * The console's server middleware checks these before it calls platform-api; platform-api only
 * receives the resulting role header. Client-safe: no secrets, no server imports.
 */
import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc as platformAdminAc, defaultStatements as platformStatements, userAc } from 'better-auth/plugins/admin/access'
import { memberAc, ownerAc, defaultStatements as organizationStatements } from 'better-auth/plugins/organization/access'

export const OPERATOR_ROLE = 'operator'

/** What a tenant member may change in the tenant portal. Reads need no permission beyond membership. */
export const tenantStatements = {
  ...organizationStatements,
  apiKey: ['create', 'revoke'],
  webhook: ['update', 'rotate', 'retry'],
  catalogue: ['publish', 'deprecate'],
  template: ['create', 'update', 'delete'],
  // Phase 7 H1: erase an exchange's or a connection's personal data.
  exchange: ['create', 'erase'],
  // Phase 6: the biometric provider, the switch and every biometric policy (default, cred def, template).
  biometrics: ['update'],
  // Phase 7 H1: the tenant's retention period.
  retention: ['update'],
} as const

export const tenantAc = createAccessControl(tenantStatements)

const consoleResources = {
  apiKey: ['create', 'revoke'],
  webhook: ['update', 'rotate', 'retry'],
  catalogue: ['publish', 'deprecate'],
  template: ['create', 'update', 'delete'],
  // Phase 7 H1: erase an exchange's or a connection's personal data.
  exchange: ['create', 'erase'],
  // Phase 6: the biometric provider, the switch and every biometric policy (default, cred def, template).
  biometrics: ['update'],
  // Phase 7 H1: the tenant's retention period.
  retention: ['update'],
} as const

export const tenantRoles = {
  owner: tenantAc.newRole({ ...ownerAc.statements, ...consoleResources }),
  // Manages the tenant's integration, not its people: member and invitation actions are the owner's.
  admin: tenantAc.newRole({ organization: ['update'], member: [], invitation: [], team: [], ac: ['read'], ...consoleResources }),
  member: tenantAc.newRole({ ...memberAc.statements }),
}

export type TenantRole = keyof typeof tenantRoles

/** For hiding actions in the UI. The server functions enforce the same rules. */
export function tenantCan(role: TenantRole, request: Parameters<(typeof tenantRoles)['owner']['authorize']>[0]) {
  return tenantRoles[role].authorize(request).success
}

export const platformAc = createAccessControl(platformStatements)

export const platformRoles = {
  // Impersonation stays off (plan C0): an operator acts as itself, through the audited console scope.
  [OPERATOR_ROLE]: platformAc.newRole({
    user: ['create', 'list', 'set-role', 'ban', 'delete', 'set-password', 'get', 'update'],
    session: ['list', 'revoke', 'delete'],
  }),
  user: platformAc.newRole({ ...userAc.statements }),
}

/**
 * Session caps, measured from sign-in and never extended by activity: operators 12 h (plan C2, no
 * trusted devices), everyone else 24 h (Phase 7 review L11, owner 2026-09-28; it was 7 days sliding).
 * The caps are ours, not Better Auth's, so the route guards and `authMiddleware` measure them from
 * these constants, and a session issued before a change is cut too. Better Auth's own expiry is
 * `SESSION_MAX_AGE_MS` with refresh disabled (`auth.server.ts`).
 */
export const OPERATOR_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function sessionExpired(role: string | null | undefined, createdAt: Date | string | number, now = Date.now()) {
  const cap = hasPlatformRole(role, OPERATOR_ROLE) ? OPERATOR_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS
  return now - new Date(createdAt).getTime() > cap
}

/** Better Auth stores roles as a comma-separated string. */
export function hasPlatformRole(role: string | null | undefined, wanted: string) {
  return (role ?? '').split(',').map((r) => r.trim()).includes(wanted)
}

// Referenced so the admin plugin's default admin role is never registered by accident.
void platformAdminAc
