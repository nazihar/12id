/** The audit's change snapshot (review L10): secrets and personal data never reach it. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MAX_SNAPSHOT_BYTES, NOT_RECORDED, PERSONAL_DATA, REDACTED, auditChanges } from '../src/http/audit-changes.ts'

describe('audit change snapshot', () => {
  it('keeps ordinary changes whole, parameters included', () => {
    const body = { url: 'https://hooks.example.com/12id', events: ['credential.state_changed'] }
    assert.deepEqual(auditChanges({ params: { id: 'k-1' }, body, recordBody: true }), { params: { id: 'k-1' }, body })
    // Names are the change itself: a schema's and a template's attribute lists stay.
    const schema = { name: 'employee', version: '1.0', attributes: ['name', 'expiresOn'] }
    assert.deepEqual(auditChanges({ body: schema, recordBody: true }), { body: schema })
  })

  it('replaces secrets at any depth by key name', () => {
    const changes = auditChanges({ body: { label: 'ci', webhookSecret: 'whsec_x', nested: [{ apiKey: '12id_sk_x', token: 't', password: 'p' }] }, recordBody: true })
    assert.deepEqual(changes, { body: { label: 'ci', webhookSecret: REDACTED, nested: [{ apiKey: REDACTED, token: REDACTED, password: REDACTED }] } })
  })

  it('replaces personal data: offer values, disclosed values and face images', () => {
    const changes = auditChanges({
      body: { connectionId: 'c', attributes: { name: 'Ada', expiresAt: '1' }, biometric: { referenceImage: 'base64…' }, values: { a: 'b' }, disclosed: { g: { a: 'b' } } },
      recordBody: true,
    })
    assert.deepEqual(changes, { body: { connectionId: 'c', attributes: PERSONAL_DATA, biometric: { referenceImage: PERSONAL_DATA }, values: PERSONAL_DATA, disclosed: PERSONAL_DATA } })
    assert.ok(!JSON.stringify(changes).includes('Ada'))
  })

  it('records only the parameters of a route that opted out, and nothing for a bodiless call', () => {
    assert.deepEqual(auditChanges({ params: { id: 'p' }, body: { providerId: 'aws', config: { anything: 'x' } }, recordBody: false }), { params: { id: 'p' }, body: NOT_RECORDED })
    assert.equal(auditChanges({ params: {}, body: undefined, recordBody: true }), null)
  })

  it('shortens long strings and replaces an oversized snapshot by its size', () => {
    const long = auditChanges({ body: { definition: 'x'.repeat(2_500) }, recordBody: true }) as { body: { definition: string } }
    assert.ok(long.body.definition.endsWith('…[+500 chars]'))
    const huge = auditChanges({ params: { id: 't' }, body: { items: Array.from({ length: 20 }, () => 'y'.repeat(1_900)) }, recordBody: true })
    assert.equal(huge?.truncated, true)
    assert.ok((huge?.bytes as number) > MAX_SNAPSHOT_BYTES)
    assert.deepEqual(huge?.params, { id: 't' })
  })
})
