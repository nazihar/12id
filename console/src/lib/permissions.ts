/**
 * Roles and permissions, shared by the Better Auth server and client plugins (Phase 4).
 *
 *   tenant roles (organization plugin, one tenant)   owner, admin, member
 *   platform roles (admin plugin, every tenant)      operator, auditor
 *
 * An auditor (implement/22-console-feedback.md C14) opens everything an operator opens and changes
 * nothing: the operator area's read functions accept it, the mutating ones do not, and platform-api
 * refuses anything but a read from it as well.
 *
 * The console's server middleware checks these before it calls platform-api; platform-api only
 * receives the resulting role header. Client-safe: no secrets, no server imports.
 */
import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc as platformAdminAc, defaultStatements as platformStatements, userAc } from 'better-auth/plugins/admin/access'
import { memberAc, ownerAc, defaultStatements as organizationStatements } from 'better-auth/plugins/organization/access'

export const OPERATOR_ROLE = 'operator'
export const AUDITOR_ROLE = 'auditor'
/** The roles of the operator area. */
export const STAFF_ROLES = [OPERATOR_ROLE, AUDITOR_ROLE] as const
export type StaffRole = (typeof STAFF_ROLES)[number]

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
  // implement/22 C12: take a list out of the console as a file.
  export: ['run'],
  // implement/22 C19: decide a change another person asked for, and switch the requirement on or off.
  approval: ['decide', 'configure'],
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
  // implement/22 C12: take a list out of the console as a file.
  export: ['run'],
  // implement/22 C19: decide a change another person asked for, and switch the requirement on or off.
  approval: ['decide', 'configure'],
} as const

export const tenantRoles = {
  owner: tenantAc.newRole({ ...ownerAc.statements, ...consoleResources }),
  // Manages the tenant's integration, not its people: member and invitation actions are the owner's.
  admin: tenantAc.newRole({ organization: ['update'], member: [], invitation: [], team: [], ac: ['read'], ...consoleResources }),
  member: tenantAc.newRole({ ...memberAc.statements }),
}

export type TenantRole = keyof typeof tenantRoles

/** The built-in organization roles, strongest first. They cannot be changed; custom roles sit beside them. */
export const BUILT_IN_TENANT_ROLES = ['owner', 'admin', 'member'] as const satisfies readonly TenantRole[]

export const isBuiltInTenantRole = (role: string): role is TenantRole => (BUILT_IN_TENANT_ROLES as readonly string[]).includes(role)

/**
 * What a role allows, as plain data: resource → actions. It crosses to the browser (the viewer's
 * permissions hide buttons) and is what Better Auth stores for a custom role (implement/26).
 */
export type Permissions = Record<string, readonly string[]>

export type PermissionRequest = Parameters<(typeof tenantRoles)['owner']['authorize']>[0]

/** True when every action asked for is in the permissions (Better Auth's AND). */
export function canDo(permissions: Permissions, request: PermissionRequest): boolean {
  return Object.entries(request).every(([resource, asked]) => {
    const held = (action: string) => Boolean(permissions[resource]?.includes(action))
    if (!asked) return true
    if (Array.isArray(asked)) return (asked as readonly string[]).every(held)
    const { actions, connector } = asked as { actions: readonly string[]; connector: 'OR' | 'AND' }
    return connector === 'OR' ? actions.some(held) : actions.every(held)
  })
}

/** Several sets as one: a person holding several roles may do what any of them allows. */
export function mergePermissions(...sets: Permissions[]): Permissions {
  const merged: Record<string, string[]> = {}
  for (const set of sets) for (const [resource, actions] of Object.entries(set)) merged[resource] = [...new Set([...(merged[resource] ?? []), ...actions])]
  return merged
}

/** What comes with membership: every page of the organization opens. Changing anything needs an action below. */
export const VIEW_PERMISSIONS = { ac: ['read'] } as const satisfies Permissions

/**
 * The portal's actions, in the order the role editor shows them (implement/26). Every check in the
 * portal asks for a statement below; a role is a name for a set of these actions.
 */
export const PORTAL_ACTIONS = [
  { key: 'people', label: 'Manage people', help: 'Invite, change roles, disable, remove and unlock members; manage roles.', statements: { member: ['create', 'update', 'delete'], invitation: ['create', 'cancel'], ac: ['create', 'update', 'delete'] } },
  { key: 'integration', label: 'Manage integration', help: 'API keys, the webhook and connection invitations.', statements: { apiKey: ['create', 'revoke'], webhook: ['update', 'rotate', 'retry'], exchange: ['create'] } },
  { key: 'setup', label: 'Manage setup', help: 'Catalogue, proof templates, face checks, data periods and the approvals switch.', statements: { organization: ['update'], catalogue: ['publish', 'deprecate'], template: ['create', 'update', 'delete'], biometrics: ['update'], retention: ['update'], approval: ['configure'] } },
  { key: 'erase', label: 'Erase personal data', help: "Erase an exchange's or a connection's personal data.", statements: { exchange: ['erase'] } },
  { key: 'export', label: 'Export', help: 'Take lists out of the console as Excel or CSV.', statements: { export: ['run'] } },
  { key: 'approve', label: 'Approve changes', help: 'Decide a change another person asked for.', statements: { approval: ['decide'] } },
] as const satisfies readonly { key: string; label: string; help: string; statements: Permissions }[]

export type PortalAction = (typeof PORTAL_ACTIONS)[number]['key']

export const PORTAL_ACTION_KEYS = PORTAL_ACTIONS.map((action) => action.key) as [PortalAction, ...PortalAction[]]

/** The permissions a custom role gets for these actions: membership's view plus each action's statements. */
export function permissionsForActions(actions: readonly PortalAction[]): Permissions {
  return mergePermissions(VIEW_PERMISSIONS, ...PORTAL_ACTIONS.filter((action) => actions.includes(action.key)).map((action) => action.statements))
}

/** The actions a set of permissions holds in full. */
export function actionsOf(permissions: Permissions): PortalAction[] {
  return PORTAL_ACTIONS.filter((action) => canDo(permissions, action.statements)).map((action) => action.key)
}

/** The built-in roles' permissions, as data. */
export const builtInPermissions = (role: TenantRole): Permissions => tenantRoles[role].statements as Permissions

/**
 * The built-in role platform-api is told about (`x-console-role`). platform-api knows only the
 * built-in names; its own checks are the ceiling and the console checks the exact actions first.
 * Anyone who manages people counts as owner, anyone who may change anything else as admin, the rest as member.
 */
export function baseRoleFor(permissions: Permissions): TenantRole {
  if (actionsOf(permissions).includes('people')) return 'owner'
  const changes = Object.entries(permissions).some(([resource, actions]) => actions.some((action) => !(resource === 'ac' && action === 'read')))
  return changes ? 'admin' : 'member'
}

export const platformAc = createAccessControl(platformStatements)

export const platformRoles = {
  // Impersonation stays off (plan C0): an operator acts as itself, through the audited console scope.
  [OPERATOR_ROLE]: platformAc.newRole({
    user: ['create', 'list', 'set-role', 'ban', 'delete', 'set-password', 'get', 'update'],
    session: ['list', 'revoke', 'delete'],
  }),
  // Read-only: no user or session permission, so Better Auth's admin endpoints refuse an auditor too.
  [AUDITOR_ROLE]: platformAc.newRole({ user: [], session: [] }),
  user: platformAc.newRole({ ...userAc.statements }),
}

/**
 * Session caps, measured from sign-in and never extended by activity: operators and auditors 12 h
 * (plan C2, no trusted devices), everyone else 24 h (Phase 7 review L11, owner 2026-09-28; it was 7 days sliding).
 * The caps are ours, not Better Auth's, so the route guards and `authMiddleware` measure them from
 * these constants, and a session issued before a change is cut too. Better Auth's own expiry is
 * `SESSION_MAX_AGE_MS` with refresh disabled (`auth.server.ts`).
 */
export const OPERATOR_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function sessionExpired(role: string | null | undefined, createdAt: Date | string | number, now = Date.now()) {
  const cap = staffRoleOf(role) ? OPERATOR_SESSION_MAX_AGE_MS : SESSION_MAX_AGE_MS
  return now - new Date(createdAt).getTime() > cap
}

/** Better Auth stores roles as a comma-separated string. */
export function hasPlatformRole(role: string | null | undefined, wanted: string) {
  return (role ?? '').split(',').map((r) => r.trim()).includes(wanted)
}

/**
 * The operator area's actions (implement/26). Its two roles stay fixed for now; the checks ask for an
 * action so that custom staff roles can be added later without touching them.
 *   view-tenants   read every organization (personal data masked), the audit log and health
 *   operate        create organizations and owners, change setup, retry
 *   manage-staff   staff accounts: invite, role, disable, unlock, sessions, delete
 *   reveal         show personal data, with an audited reason
 */
export const STAFF_ACTIONS = ['view-tenants', 'operate', 'manage-staff', 'reveal'] as const
export type StaffAction = (typeof STAFF_ACTIONS)[number]

const STAFF_ROLE_ACTIONS: Record<StaffRole, readonly StaffAction[]> = {
  [OPERATOR_ROLE]: STAFF_ACTIONS,
  [AUDITOR_ROLE]: ['view-tenants'],
}

export const staffCan = (role: StaffRole | null | undefined, action: StaffAction) => Boolean(role && STAFF_ROLE_ACTIONS[role].includes(action))

/** The role an account has in the operator area: operator wins over auditor; null for everyone else. */
export function staffRoleOf(role: string | null | undefined): StaffRole | null {
  return hasPlatformRole(role, OPERATOR_ROLE) ? OPERATOR_ROLE : hasPlatformRole(role, AUDITOR_ROLE) ? AUDITOR_ROLE : null
}

// Referenced so the admin plugin's default admin role is never registered by accident.
void platformAdminAc
