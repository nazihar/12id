import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { signPayload, signingSecrets, verifySignature } from '../src/webhooks/signer.ts'

describe('webhook signatures', () => {
  const secret = 'whsec_test'
  const body = '{"id":"1","type":"proof.state_changed"}'

  it('round-trips and includes the timestamp', () => {
    const header = signPayload(secret, body, 1_700_000_000)
    assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/)
    assert.equal(verifySignature(secret, body, header, 1_700_000_010), true)
  })

  it('rejects a changed body, a wrong secret and a stale timestamp', () => {
    const header = signPayload(secret, body, 1_700_000_000)
    assert.equal(verifySignature(secret, `${body} `, header, 1_700_000_010), false)
    assert.equal(verifySignature('other', body, header, 1_700_000_010), false)
    assert.equal(verifySignature(secret, body, header, 1_700_000_000 + 301), false)
    assert.equal(verifySignature(secret, body, 'garbage', 1_700_000_000), false)
  })

  it('signs with both secrets during a rotation, newest first, and verifies against either (review M9)', () => {
    const header = signPayload(['whsec_new', 'whsec_old'], body, 1_700_000_000)
    assert.match(header, /^t=1700000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/)
    assert.equal(header.split(',')[1], signPayload('whsec_new', body, 1_700_000_000).split(',')[1], 'the first v1 is the new secret')
    assert.equal(verifySignature('whsec_new', body, header, 1_700_000_010), true)
    assert.equal(verifySignature('whsec_old', body, header, 1_700_000_010), true)
    assert.equal(verifySignature('whsec_other', body, header, 1_700_000_010), false)
  })

  it('keeps the replaced secret for 24 hours after a rotation only', () => {
    const rotatedAt = new Date('2026-09-22T00:00:00Z')
    const endpoint = { secret: 'new', previousSecret: 'old', rotatedAt }
    assert.deepEqual(signingSecrets(endpoint, new Date('2026-09-22T23:59:00Z')), ['new', 'old'])
    assert.deepEqual(signingSecrets(endpoint, new Date('2026-09-23T00:00:01Z')), ['new'])
    assert.deepEqual(signingSecrets({ secret: 'only', previousSecret: null, rotatedAt: null }, rotatedAt), ['only'])
  })
})
