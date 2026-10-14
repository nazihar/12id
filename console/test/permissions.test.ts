import { describe, expect, it } from 'vitest'

import { AUDITOR_ROLE, OPERATOR_ROLE, PORTAL_ACTION_KEYS, STAFF_ACTIONS, actionsOf, baseRoleFor, builtInPermissions, canDo, hasPlatformRole, mergePermissions, permissionsForActions, platformRoles, sessionExpired, staffCan, staffRoleOf, tenantRoles } from '../src/lib/permissions'

type TenantRequest = Parameters<(typeof tenantRoles)['member']['authorize']>[0]

describe('tenant roles', () => {
  it('lets owners manage people and admins manage only the integration', () => {
    expect(tenantRoles.owner.authorize({ member: ['create', 'delete'], invitation: ['create'] }).success).toBe(true)
    expect(tenantRoles.admin.authorize({ invitation: ['create'] }).success).toBe(false)
    expect(tenantRoles.admin.authorize({ member: ['update'] }).success).toBe(false)
    expect(tenantRoles.admin.authorize({ apiKey: ['create'], webhook: ['rotate'], catalogue: ['publish'], template: ['delete'], exchange: ['create'] }).success).toBe(true)
  })

  it('lets owners and admins erase personal data and set the retention period (Phase 7 H1)', () => {
    for (const role of ['owner', 'admin'] as const) expect(tenantRoles[role].authorize({ exchange: ['erase'], retention: ['update'] }).success).toBe(true)
  })

  it('keeps members read-only', () => {
    const requests: TenantRequest[] = [{ apiKey: ['create'] }, { webhook: ['update'] }, { catalogue: ['publish'] }, { template: ['create'] }, { exchange: ['create'] }, { exchange: ['erase'] }, { retention: ['update'] }, { member: ['delete'] }, { invitation: ['create'] }]
    for (const request of requests) expect(tenantRoles.member.authorize(request).success).toBe(false)
  })
})

describe('platform roles', () => {
  it('gives operators user and session management without impersonation', () => {
    expect(platformRoles[OPERATOR_ROLE].authorize({ user: ['ban', 'set-role', 'create'], session: ['revoke'] }).success).toBe(true)
    expect(platformRoles[OPERATOR_ROLE].authorize({ user: ['impersonate'] }).success).toBe(false)
    expect(platformRoles.user.authorize({ user: ['list'] }).success).toBe(false)
  })

  it('reads comma-separated role strings exactly', () => {
    expect(hasPlatformRole('user, operator', OPERATOR_ROLE)).toBe(true)
    expect(hasPlatformRole('operators', OPERATOR_ROLE)).toBe(false)
    expect(hasPlatformRole(null, OPERATOR_ROLE)).toBe(false)
  })
})

describe('session caps (review L11)', () => {
  const hour = 60 * 60 * 1000
  const now = Date.parse('2026-09-28T12:00:00Z')
  const signedIn = (hoursAgo: number) => new Date(now - hoursAgo * hour)

  it('ends every session 24 h after sign-in, and an operator session after 12 h', () => {
    expect(sessionExpired('user', signedIn(23.9), now)).toBe(false)
    expect(sessionExpired('user', signedIn(24.1), now)).toBe(true)
    expect(sessionExpired(null, signedIn(24.1), now)).toBe(true)
    expect(sessionExpired(OPERATOR_ROLE, signedIn(11.9), now)).toBe(false)
    expect(sessionExpired(OPERATOR_ROLE, signedIn(12.1), now)).toBe(true)
    expect(sessionExpired('user,operator', signedIn(12.1), now)).toBe(true)
  })

  it('cuts sessions issued under the old 7-day setting', () => {
    expect(sessionExpired('user', signedIn(6 * 24).toISOString(), now)).toBe(true)
  })
})

describe('auditor role (implement/22 C14)', () => {
  it('carries no user or session permission, so the admin plugin refuses every change', () => {
    const auditor = platformRoles[AUDITOR_ROLE]
    for (const action of ['create', 'list', 'set-role', 'ban', 'delete', 'set-password', 'get', 'update'] as const) expect(auditor.authorize({ user: [action] }).success).toBe(false)
    for (const action of ['list', 'revoke', 'delete'] as const) expect(auditor.authorize({ session: [action] }).success).toBe(false)
    expect(platformRoles[OPERATOR_ROLE].authorize({ user: ['delete', 'set-role', 'update'] }).success).toBe(true)
  })

  it('is staff next to the operator, which wins when an account has both', () => {
    expect(staffRoleOf('auditor')).toBe('auditor')
    expect(staffRoleOf('operator')).toBe('operator')
    expect(staffRoleOf('auditor,operator')).toBe('operator')
    expect(staffRoleOf('user')).toBeNull()
    expect(staffRoleOf(null)).toBeNull()
  })

  it('has the operator session cap of 12 hours', () => {
    const signedIn = Date.now() - 13 * 60 * 60 * 1000
    expect(sessionExpired('auditor', signedIn)).toBe(true)
    expect(sessionExpired('user', signedIn)).toBe(false)
    expect(sessionExpired('auditor', Date.now() - 11 * 60 * 60 * 1000)).toBe(false)
  })
})

describe('roles by action (implement/26)', () => {
  it('gives the built-in roles exactly their actions', () => {
    expect(actionsOf(builtInPermissions('owner'))).toEqual(PORTAL_ACTION_KEYS)
    expect(actionsOf(builtInPermissions('admin'))).toEqual(PORTAL_ACTION_KEYS.filter((action) => action !== 'people'))
    expect(actionsOf(builtInPermissions('member'))).toEqual([])
  })

  it('tells platform-api the nearest built-in role', () => {
    expect(baseRoleFor(builtInPermissions('owner'))).toBe('owner')
    expect(baseRoleFor(builtInPermissions('admin'))).toBe('admin')
    expect(baseRoleFor(builtInPermissions('member'))).toBe('member')
    expect(baseRoleFor(permissionsForActions(['people']))).toBe('owner')
    expect(baseRoleFor(permissionsForActions(['export']))).toBe('admin')
    expect(baseRoleFor(permissionsForActions([]))).toBe('member')
  })

  it('builds a custom role from actions, view included', () => {
    const integrations = permissionsForActions(['integration'])
    expect(canDo(integrations, { webhook: ['rotate'], apiKey: ['create'] })).toBe(true)
    expect(canDo(integrations, { catalogue: ['publish'] })).toBe(false)
    expect(canDo(integrations, { ac: ['read'] })).toBe(true)
    expect(actionsOf(integrations)).toEqual(['integration'])
  })

  it('checks every action asked for, or any with OR', () => {
    const exportOnly = permissionsForActions(['export'])
    expect(canDo(exportOnly, { export: ['run'], exchange: ['erase'] })).toBe(false)
    expect(canDo(exportOnly, { exchange: { actions: ['erase', 'create'], connector: 'OR' } })).toBe(false)
    expect(canDo(builtInPermissions('admin'), { exchange: { actions: ['erase', 'create'], connector: 'OR' } })).toBe(true)
  })

  it('merges several roles into what any of them allows', () => {
    const both = mergePermissions(permissionsForActions(['export']), permissionsForActions(['erase']))
    expect(actionsOf(both)).toEqual(['erase', 'export'])
  })

  it('keeps the operator area on actions: operators do everything, auditors only read', () => {
    for (const action of STAFF_ACTIONS) expect(staffCan(OPERATOR_ROLE, action)).toBe(true)
    expect(staffCan(AUDITOR_ROLE, 'view-tenants')).toBe(true)
    for (const action of ['operate', 'manage-staff', 'reveal'] as const) expect(staffCan(AUDITOR_ROLE, action)).toBe(false)
    expect(staffCan(null, 'view-tenants')).toBe(false)
  })
})
