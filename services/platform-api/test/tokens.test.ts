import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { API_KEY_PREFIX, WALLET_TOKEN_PREFIX, bearerToken, generateSecret, hashSecret, hashesMatch, lookupPrefix } from '../src/auth/tokens.ts'

describe('tokens', () => {
  it('generates prefixed, distinct secrets with stable hashes', () => {
    const a = generateSecret(API_KEY_PREFIX)
    const b = generateSecret(API_KEY_PREFIX)
    assert.ok(a.startsWith(API_KEY_PREFIX) && b.startsWith(API_KEY_PREFIX))
    assert.notEqual(a, b)
    assert.equal(hashSecret(a), hashSecret(a))
    assert.notEqual(hashSecret(a), hashSecret(b))
    assert.equal(lookupPrefix(a).length, 12)
  })

  it('parses bearer headers only with the expected prefix', () => {
    const key = generateSecret(API_KEY_PREFIX)
    assert.equal(bearerToken(`Bearer ${key}`, API_KEY_PREFIX), key)
    assert.equal(bearerToken(`bearer ${key}`, API_KEY_PREFIX), key)
    assert.equal(bearerToken(`Bearer ${key}`, WALLET_TOKEN_PREFIX), null)
    assert.equal(bearerToken(key, API_KEY_PREFIX), null)
    assert.equal(bearerToken('Bearer 12id_sk_short', API_KEY_PREFIX), null)
    assert.equal(bearerToken(undefined, API_KEY_PREFIX), null)
  })

  it('compares hashes without throwing on length mismatches', () => {
    assert.equal(hashesMatch('abc', 'abc'), true)
    assert.equal(hashesMatch('abc', 'abd'), false)
    assert.equal(hashesMatch('abc', 'abcd'), false)
  })
})
