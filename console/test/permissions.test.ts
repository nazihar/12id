import { describe, expect, it } from 'vitest'

import { OPERATOR_ROLE, hasPlatformRole, platformRoles, tenantRoles } from '../src/lib/permissions'

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
