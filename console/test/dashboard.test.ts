/** Dashboard rules (Phase 4 C8): the range schema, the outcome buckets and the getting-started derivation. */
import { describe, expect, it } from 'vitest'

import { outcomeRow } from '@/components/dashboard/charts'
import { dashboardRangeInput, parseDashboardSearch, rangeOf } from '@/features/dashboard/dashboard.schemas'
import { gettingStartedSteps, isGettingStartedComplete } from '@/features/dashboard/getting-started'
import { CONNECTION_OUTCOMES, EXCHANGE_OUTCOMES } from '@/features/dashboard/tenant-dashboard'

describe('dashboard range', () => {
  it('defaults to 30 days and accepts only the presets', () => {
    expect(dashboardRangeInput.parse({})).toEqual({ days: 30 })
    expect(dashboardRangeInput.parse({ days: 7 })).toEqual({ days: 7 })
    expect(dashboardRangeInput.safeParse({ days: 14 }).success).toBe(false)
    expect(dashboardRangeInput.safeParse({ days: '30' }).success).toBe(false)
  })

  it('parses the route search leniently, falling back to the default', () => {
    expect(parseDashboardSearch({})).toEqual({})
    expect(parseDashboardSearch({ days: '90' })).toEqual({ days: 90 })
    expect(parseDashboardSearch({ days: 7 })).toEqual({ days: 7 })
    expect(parseDashboardSearch({ days: 'lots' })).toEqual({})
    expect(parseDashboardSearch({ days: '365' })).toEqual({})
    expect(rangeOf({})).toBe(30)
    expect(rangeOf({ days: 7 })).toBe(7)
  })
})

describe('outcome buckets', () => {
  it('splits exchange states into done, in flight and abandoned', () => {
    expect(outcomeRow('Credentials', { done: 4, 'offer-sent': 2, 'request-received': 1, abandoned: 1, declined: 2 }, EXCHANGE_OUTCOMES)).toEqual({ kind: 'Credentials', done: 4, inFlight: 3, abandoned: 3 })
    expect(outcomeRow('Connections', { completed: 5, invitation: 1, 'request-received': 1 }, CONNECTION_OUTCOMES)).toEqual({ kind: 'Connections', done: 5, inFlight: 2, abandoned: 0 })
    expect(outcomeRow('Proofs', {}, EXCHANGE_OUTCOMES)).toEqual({ kind: 'Proofs', done: 0, inFlight: 0, abandoned: 0 })
  })
})

describe('getting started', () => {
  it('is incomplete for a fresh tenant and complete once every step is done', () => {
    const fresh = gettingStartedSteps({ schemas: 0, credentialDefinitions: 0, apiKeys: 0, webhookConfigured: false, connections: 0 })
    expect(fresh.map((step) => step.done)).toEqual([false, false, false, false, false])
    expect(isGettingStartedComplete(fresh)).toBe(false)
    const done = gettingStartedSteps({ schemas: 1, credentialDefinitions: 1, apiKeys: 2, webhookConfigured: true, connections: 3 })
    expect(isGettingStartedComplete(done)).toBe(true)
  })

  it('does not count the catalogue steps while the catalogue is still loading', () => {
    const loading = gettingStartedSteps({ schemas: null, credentialDefinitions: null, apiKeys: 1, webhookConfigured: true, connections: 1 })
    expect(loading.filter((step) => !step.known).map((step) => step.key)).toEqual(['schema', 'credential-definition'])
    expect(isGettingStartedComplete(loading)).toBe(false)
  })
})
