import { describe, expect, it } from 'vitest'

import { attemptsSummary, checkColumns, decidedChecks, finishedProofs, percent, proofColumns } from '../src/features/verification/verification-format'
import { checkQueryParams, customerSearch, reasonLabel, verificationSearch } from '../src/features/verification/verification.schemas'
import { parseListSearch } from '../src/lib/list-search'

describe('verification figures', () => {
  it('gives a whole percentage, and a dash when there is nothing to divide by', () => {
    expect(percent(1, 3)).toBe('33%')
    expect(percent(2, 3)).toBe('67%')
    expect(percent(0, 5)).toBe('0%')
    expect(percent(0, 0)).toBe('—')
  })

  it('counts only finished requests and decided checks as the base of a rate', () => {
    expect(finishedProofs({ verified: 4, failed: 1, abandoned: 2 })).toBe(7)
    expect(decidedChecks({ passed: 5, failed: 1, expired: 2 })).toBe(8)
  })

  it('folds the two unsuccessful outcomes into one chart segment, and keeps the day', () => {
    expect(proofColumns([{ day: '2026-10-11', verified: 3, failed: 1, abandoned: 2, inFlight: 4 }])).toEqual([{ day: '2026-10-11', verified: 3, inFlight: 4, notVerified: 3 }])
    expect(checkColumns([{ day: '2026-10-11', passed: 3, failed: 1, expired: 2, open: 4, cancelled: 5 }])).toEqual([{ day: '2026-10-11', passed: 3, open: 4, notPassed: 3, cancelled: 5 }])
  })

  it('says how many attempts a pass took', () => {
    expect(attemptsSummary([{ attempts: 1, checks: 12 }, { attempts: 2, checks: 3 }])).toBe('1 attempt: 12 · 2 attempts: 3')
    expect(attemptsSummary([])).toBeNull()
  })

  it('names the known rejection reasons and shows an unknown one as stored', () => {
    expect(reasonLabel('no_face')).toBe('No face found')
    expect(reasonLabel('vendor_rate_limited')).toBe('vendor_rate_limited')
  })
})

describe('verification search', () => {
  const parse = parseListSearch(verificationSearch)

  it('keeps the window, the tab and the list filters, and drops what it does not know', () => {
    expect(parse({ tab: 'checks', days: 7, status: ['failed', 'expired'], recordType: 'proof', reason: 'no_face', q: 'user-1', page: '2' })).toEqual({
      tab: 'checks',
      days: 7,
      status: ['failed', 'expired'],
      recordType: 'proof',
      reason: 'no_face',
      q: 'user-1',
      page: 2,
    })
    expect(parse({ tab: 'graphs', days: 14, status: 'won', recordType: 'wallet' })).toEqual({})
    expect(parse({ status: 'passed' })).toEqual({ status: ['passed'] })
  })

  it('maps the list search to the platform query, with the connection when the page is one customer', () => {
    expect(checkQueryParams({ status: ['passed'], from: '2026-10-01', to: '2026-10-01' })).toEqual({
      page: 1,
      pageSize: 25,
      q: undefined,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      status: ['passed'],
      recordType: undefined,
      reason: undefined,
      connectionId: undefined,
    })
    expect(checkQueryParams({}, 'conn-1').connectionId).toBe('conn-1')
  })

  it('has no free-text search on the customer page: the list is one person already', () => {
    expect(parseListSearch(customerSearch)({ tab: 'proofs', q: 'x', state: 'done' })).toEqual({ tab: 'proofs', state: ['done'] })
  })
})
