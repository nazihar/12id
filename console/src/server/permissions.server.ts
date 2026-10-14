/**
 * A member's permissions in one organization (implement/26): the built-in roles from
 * lib/permissions.ts plus the organization's custom roles in `organization_role`, merged the way
 * Better Auth's `hasPermission` merges them (organization/has-permission.mjs), so the console's
 * checks and Better Auth's own endpoints agree. Relative imports only (the Better Auth CLI loads
 * the auth chain outside Vite).
 */
import { and, eq, inArray } from 'drizzle-orm'

import { type Permissions, builtInPermissions, isBuiltInTenantRole, mergePermissions } from '../lib/permissions'
import { consoleDb } from './db.server'
import { organizationRole } from './db/auth-schema'

/** Better Auth keeps several roles as one comma-separated string. */
export const memberRoleNames = (value: string) =>
  value
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean)

/** A stored role's permissions; a malformed row allows nothing rather than failing the request. */
export function parseStoredPermissions(value: string): Permissions {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((action) => typeof action === 'string'))
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

/**
 * Everything the roles allow together. Unknown names allow nothing: a custom role deleted under a
 * member (refused by the Roles page, but possible in the database) leaves them with view only if
 * they hold another role, or nothing.
 */
export async function effectivePermissions(organizationId: string, roles: readonly string[]): Promise<Permissions> {
  const custom = roles.filter((role) => !isBuiltInTenantRole(role))
  const rows = custom.length
    ? await consoleDb()
        .db.select({ role: organizationRole.role, permission: organizationRole.permission })
        .from(organizationRole)
        .where(and(eq(organizationRole.organizationId, organizationId), inArray(organizationRole.role, custom)))
    : []
  const sets = roles.flatMap((role) => {
    const stored = rows.filter((row) => row.role === role).map((row) => parseStoredPermissions(row.permission))
    if (isBuiltInTenantRole(role)) return [builtInPermissions(role), ...stored]
    return stored
  })
  return mergePermissions(...sets)
}

/** The organization's custom roles by name, with what people see. */
export async function customRoles(organizationId: string) {
  const rows = await consoleDb()
    .db.select({ id: organizationRole.id, role: organizationRole.role, label: organizationRole.label, description: organizationRole.description, permission: organizationRole.permission, createdAt: organizationRole.createdAt, updatedAt: organizationRole.updatedAt })
    .from(organizationRole)
    .where(eq(organizationRole.organizationId, organizationId))
  return rows.map((row) => ({ id: row.id, role: row.role, label: row.label ?? row.role, description: row.description ?? '', permissions: parseStoredPermissions(row.permission), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null }))
}
