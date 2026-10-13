import { describe, expect, it } from 'vitest'

import { approvalSearch, decisionInput, statusText } from '../src/features/approvals/approvals.schemas'
import { isHeld } from '../src/lib/held'
import { tenantRoles } from '../src/lib/permissions'

describe('approval by a second person (implement/22 C17–C19)', () => {
  it('owners and admins decide and switch the requirement; members do neither', () => {
    for (const role of ['owner', 'admin'] as const) expect(tenantRoles[role].authorize({ approval: ['decide', 'configure'] }).success).toBe(true)
    expect(tenantRoles.member.authorize({ approval: ['decide'] }).success).toBe(false)
    expect(tenantRoles.member.authorize({ approval: ['configure'] }).success).toBe(false)
  })

  it('tells a held change from one that was made', () => {
    expect(isHeld({ held: { id: 'r1', type: 'webhook.set', label: 'Set the webhook endpoint', summary: 'Send events to https://x.test', apply: 'by_requester' } })).toBe(true)
    // What the same functions answer when the change was made.
    for (const made of [{ secret: 'whsec_x' }, { deleted: true }, { email: 'a@b.test' }, { held: null }, { held: {} }, null, undefined, 'held']) expect(isHeld(made)).toBe(false)
  })

  it('says what a state means for the reader', () => {
    const base = { apply: 'by_requester' as const, requestedByLabel: 'ada@acme.test' }
    expect(statusText({ ...base, status: 'pending', mine: true })).toBe('waiting for a second person')
    expect(statusText({ ...base, status: 'approved', mine: true })).toBe('approved: apply it now')
    expect(statusText({ ...base, status: 'approved', mine: false })).toBe('approved: waiting for ada@acme.test to apply it')
    expect(statusText({ ...base, requestedByLabel: null, status: 'approved', mine: false })).toContain('the person who asked')
    expect(statusText({ ...base, status: 'failed', mine: false })).toContain('could not be applied')
    expect(statusText({ ...base, status: 'expired', mine: false })).toContain('in time')
  })

  it('a rejection carries a reason of at least three characters; the tab lives in the URL', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    expect(decisionInput.safeParse({ id, action: 'approve' }).success).toBe(true)
    expect(decisionInput.safeParse({ id, action: 'reject', reason: 'no' }).success).toBe(false)
    expect(decisionInput.safeParse({ id, action: 'reject', reason: 'Wrong account.' }).success).toBe(true)
    expect(decisionInput.safeParse({ id: 'not-a-uuid', action: 'approve' }).success).toBe(false)
    expect(approvalSearch.safeParse({ tab: 'history', page: 2 }).success).toBe(true)
    expect(approvalSearch.safeParse({ tab: 'everything' }).success).toBe(false)
  })
})
