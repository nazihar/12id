/**
 * An organization's custom roles (implement/26). Anyone in the organization may read the roles (the
 * Members page names them); creating, changing and deleting them is "Manage people". Better Auth
 * re-checks each change under the person's own session, including that nobody grants an action
 * they do not hold themselves.
 *
 * Where the organization requires a second person (implement/22 C18), a role change is stored as a
 * request (`role.change`) and answers `{ held }`.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { PORTAL_ACTIONS } from '@/lib/permissions'
import { performAccountChange } from '@/server/account-changes.server'
import { askForAccountChange } from '@/server/approvals.server'
import { tenantMiddleware } from '@/server/middleware'
import { customRole, listRoleRows } from '@/server/roles.server'

import { assertSameOrganization, organizationInput } from './organization-input'
import { roleInput, roleName, roleSlug } from './roles.schemas'

const actionLabels = (keys: readonly string[]) => PORTAL_ACTIONS.filter((action) => keys.includes(action.key)).map((action) => action.label)

export const listRoles = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => listRoleRows(context.organization.id))

async function change(context: { principal: Parameters<typeof performAccountChange>[0]; organization: { id: string } }, payload: Record<string, unknown>) {
  const held = await askForAccountChange(context.principal, context.principal.tenantId, 'role.change', payload)
  if (held) return held
  await performAccountChange(context.principal, 'role.change', payload, { organizationId: context.organization.id })
  return null
}

export const createCustomRole = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ ac: ['create'] })])
  .validator(organizationInput.and(roleInput))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const role = roleSlug(data.label)
    if (await customRole(data.organizationId, role)) throw new Error('This organization already has a role by that name.')
    const held = await change(context, { organizationId: data.organizationId, action: 'create', role, label: data.label, description: data.description, keys: data.actions, actions: actionLabels(data.actions) })
    return held ?? { role }
  })

export const updateCustomRole = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ ac: ['update'] })])
  .validator(organizationInput.and(roleInput).and(z.object({ role: roleName })))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    // The stored name stays: members and invitations refer to it. Only what people see changes.
    if (!(await customRole(data.organizationId, data.role))) throw new Error('This organization has no such role.')
    const held = await change(context, { organizationId: data.organizationId, action: 'update', role: data.role, label: data.label, description: data.description, keys: data.actions, actions: actionLabels(data.actions) })
    return held ?? { role: data.role }
  })

export const deleteCustomRole = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ ac: ['delete'] })])
  .validator(organizationInput.extend({ role: roleName }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const rows = await listRoleRows(data.organizationId)
    const row = rows.find((candidate) => candidate.role === data.role && !candidate.builtIn)
    if (!row) throw new Error('This organization has no such role.')
    if (row.members > 0) throw new Error(`${row.members === 1 ? 'One member holds' : `${row.members} members hold`} this role. Give them another role first.`)
    if (row.invitations > 0) throw new Error('A pending invitation names this role. Cancel it first.')
    const held = await change(context, { organizationId: data.organizationId, action: 'delete', role: data.role, label: row.label })
    return held ?? { deleted: true }
  })
