import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'

import { KeyRing, aad, open, seal } from '../src/crypto.ts'

describe('envelope encryption', () => {
  const key = randomBytes(32)

  it('round-trips', () => {
    const plain = randomBytes(1000)
    assert.deepEqual(open(key, seal(key, plain, 'a'), 'a'), plain)
  })

  it('refuses a ciphertext moved to another row or tenant (associated data)', () => {
    const sealed = seal(key, Buffer.from('face'), aad.referenceImage('tenant-a', 'check-1'))
    assert.throws(() => open(key, sealed, aad.referenceImage('tenant-a', 'check-2')))
    assert.throws(() => open(key, sealed, aad.referenceImage('tenant-b', 'check-1')))
  })

  it('refuses a tampered ciphertext and the wrong key', () => {
    const sealed = seal(key, Buffer.from('face'), 'x')
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] ^= 1
    assert.throws(() => open(key, tampered, 'x'))
    assert.throws(() => open(randomBytes(32), sealed, 'x'))
  })

  it('wraps data keys per tenant under the master key', () => {
    const ring = new KeyRing(randomBytes(32).toString('base64'))
    const { dataKey, wrapped } = ring.newWrappedDataKey('tenant-a')
    assert.deepEqual(ring.unwrap('tenant-a', wrapped), dataKey)
    assert.throws(() => ring.unwrap('tenant-b', wrapped))
    assert.throws(() => new KeyRing(randomBytes(32).toString('base64')).unwrap('tenant-a', wrapped))
  })

  it('rejects a master key of the wrong size', () => {
    assert.throws(() => new KeyRing(randomBytes(16).toString('base64')))
  })
})
