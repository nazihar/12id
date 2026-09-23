import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { backoffMs, deliverOnce } from '../src/webhooks/dispatcher.ts'
import { verifySignature } from '../src/webhooks/signer.ts'

describe('webhook dispatcher (pure parts)', () => {
  it('backs off exponentially from 5 s, capped at one hour, with bounded jitter', () => {
    const noJitter = () => 0.5
    assert.equal(backoffMs(1, noJitter), 5_000)
    assert.equal(backoffMs(2, noJitter), 10_000)
    assert.equal(backoffMs(5, noJitter), 80_000)
    assert.equal(backoffMs(20, noJitter), 3_600_000)
    assert.equal(backoffMs(1, () => 0), 4_000)
    assert.equal(backoffMs(1, () => 1), 6_000)
  })

  it('signs each attempt and treats only 2xx as delivered', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) })
      return new Response('ok', { status: seen.length === 1 ? 200 : 500 })
    }) as typeof fetch
    const delivery = { url: 'https://customer.test/hook', body: '{"a":1}', eventType: 'proof.state_changed', eventId: 'ev-1', secrets: 'whsec_x' }
    const first = await deliverOnce(fetchMock, delivery, 1000, 1_700_000_000)
    assert.deepEqual(first, { ok: true, statusCode: 200 })
    assert.equal(seen[0].headers['x-12id-event'], 'proof.state_changed')
    assert.equal(seen[0].headers['x-12id-delivery'], 'ev-1')
    assert.equal(verifySignature('whsec_x', '{"a":1}', seen[0].headers['x-12id-signature'], 1_700_000_000), true)
    const second = await deliverOnce(fetchMock, delivery, 1000, 1_700_000_000)
    assert.deepEqual(second, { ok: false, statusCode: 500 })
  })

  it('reports network failures without throwing', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const result = await deliverOnce(failing, { url: 'https://x', body: '{}', eventType: 't', eventId: 'e', secrets: 's' }, 1000, 1)
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /ECONNREFUSED/)
  })
})
