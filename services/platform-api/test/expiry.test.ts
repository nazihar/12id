/** The stored validity date (`credentials.expires_at`) from the mandatory `expiresOn` attribute (YYYYMMDD, UTC). */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { expiryOf } from '../src/views.ts'

describe('expiryOf', () => {
  it('is the end of the expiry day: the next midnight UTC', () => {
    assert.equal(expiryOf({ expiresOn: '20261006' })?.toISOString(), '2026-10-07T00:00:00.000Z')
    assert.equal(expiryOf({ expiresOn: '20281231' })?.toISOString(), '2029-01-01T00:00:00.000Z')
    assert.equal(expiryOf({ expiresOn: '20280229' })?.toISOString(), '2028-03-01T00:00:00.000Z')
  })

  it('holds dates far past 2038', () => {
    assert.equal(expiryOf({ expiresOn: '20991231' })?.toISOString(), '2100-01-01T00:00:00.000Z')
  })

  it('is null for a missing, malformed or impossible date, and for the retired epoch-seconds attribute', () => {
    for (const attributes of [undefined, null, {}, { expiresOn: '2026-10-06' }, { expiresOn: '20270229' }, { expiresOn: '1789000000' }, { expiresAt: '1789000000' }]) {
      assert.equal(expiryOf(attributes as Record<string, string> | null | undefined), null, JSON.stringify(attributes))
    }
  })
})
