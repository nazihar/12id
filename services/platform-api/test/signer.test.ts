import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { signPayload, verifySignature } from '../src/webhooks/signer.ts'

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
})
