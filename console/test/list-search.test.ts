import { describe, expect, it } from 'vitest'

import { exchangeQueryParams } from '../src/features/tenant-data/list.params'
import { CONNECTION_STATES, CREDENTIAL_STATES, PROOF_STATES, exchangeSearch } from '../src/features/tenant-data/list.schemas'
import { allPages, cleanSearch, createdParams, likeContains, pageParams, parseListSearch } from '../src/lib/list-search'

describe('list search (Phase 4 C9)', () => {
  const parse = parseListSearch(exchangeSearch)

  it('keeps valid values, drops invalid ones instead of failing the page', () => {
    expect(parse({ page: '3', pageSize: 50, q: ' order-1 ', tab: 'proofs', from: '2026-09-01', to: '2026-09-24' })).toEqual({ page: 3, pageSize: 50, q: 'order-1', tab: 'proofs', from: '2026-09-01', to: '2026-09-24' })
    expect(parse({ page: 0, pageSize: 30, tab: 'wallets', from: 'yesterday', q: '' })).toEqual({})
    expect(parse({ state: 'done' })).toEqual({ state: ['done'] })
    expect(parse({ state: ['done', 'abandoned'] })).toEqual({ state: ['done', 'abandoned'] })
  })

  it('keeps defaults and empty values out of the URL', () => {
    expect(cleanSearch({ page: 1, pageSize: 25, q: undefined, state: [], tab: 'credentials' })).toEqual({ tab: 'credentials' })
    expect(cleanSearch({ page: 2, pageSize: 100 })).toEqual({ page: 2, pageSize: 100 })
  })

  it('maps the search to platform-api parameters with UTC day bounds, the end day inclusive', () => {
    expect(pageParams({})).toEqual({ page: 1, pageSize: 25, q: undefined })
    expect(createdParams({ from: '2026-09-01', to: '2026-09-30' })).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })
    expect(exchangeQueryParams({ tab: 'credentials', q: 'abc', state: ['done'], page: 2 })).toEqual({ page: 2, pageSize: 25, q: 'abc', state: ['done'], from: undefined, to: undefined })
  })

  it('escapes LIKE wildcards in a contains search', () => {
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%')
  })

  it('reads every page of a small list', async () => {
    const rows = Array.from({ length: 230 }, (_, i) => i)
    const pages: number[] = []
    const all = await allPages(async (page) => {
      pages.push(page)
      return { items: rows.slice((page - 1) * 100, page * 100), total: rows.length, page, pageSize: 100 }
    })
    expect(all).toEqual(rows)
    expect(pages).toEqual([1, 2, 3])
  })

  it('offers the issuer and verifier states Credo reports', () => {
    for (const states of [CONNECTION_STATES, CREDENTIAL_STATES, PROOF_STATES]) expect(states).toContain('abandoned')
    expect(CONNECTION_STATES).toContain('completed')
    expect(CREDENTIAL_STATES).toContain('credential-issued')
    expect(PROOF_STATES).toContain('presentation-received')
  })
})
