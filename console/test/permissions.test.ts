import { describe, expect, it } from 'vitest'

import { AUDITOR_ROLE, OPERATOR_ROLE, hasPlatformRole, platformRoles, sessionExpired, staffRoleOf, tenantRoles } from '../src/lib/permissions'

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
