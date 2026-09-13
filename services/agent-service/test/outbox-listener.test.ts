import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CORRELATION_METADATA_KEY, PendingCorrelations } from '../src/events/correlation.ts'
import { toOutboxRow } from '../src/events/outbox-listener.ts'

function record(fields: Record<string, unknown>, metadata: Record<string, Record<string, unknown>> = {}) {
  const store = { ...metadata }
  return {
    id: 'rec-1',
    state: 'offer-sent',
    threadId: 'thread-1',
    ...fields,
    metadata: {
      get: (key: string) => store[key] ?? null,
      set: (key: string, value: Record<string, unknown>) => {
        store[key] = value
      },
    },
  }
}

describe('toOutboxRow', () => {
  it('maps a tenant credential event with its correlation id', () => {
    const mapped = toOutboxRow({
      type: 'DidCommCredentialStateChanged',
      metadata: { contextCorrelationId: 'tenant-584d5806' },
      payload: {
        previousState: null,
        credentialExchangeRecord: record({ connectionId: 'conn-1', protocolVersion: 'v1' }, { [CORRELATION_METADATA_KEY]: { correlationId: 'corr-9' } }),
      },
    })
    assert.deepEqual(mapped?.row, {
      tenantId: '584d5806',
      recordType: 'credential',
      recordId: 'rec-1',
      threadId: 'thread-1',
      state: 'offer-sent',
      previousState: null,
      correlationId: 'corr-9',
      payload: { connectionId: 'conn-1', protocolVersion: 'v1' },
    })
    assert.equal(mapped?.stampedRecord, null)
  })

  it('consumes a pending correlation for the first event and stamps the record', () => {
    const pending = new PendingCorrelations()
    pending.announce('a', 'credential', 'conn-1', 'corr-first')
    const rec = record({ connectionId: 'conn-1' })
    const mapped = toOutboxRow({ type: 'DidCommCredentialStateChanged', metadata: { contextCorrelationId: 'tenant-a' }, payload: { credentialExchangeRecord: rec } }, pending)
    assert.equal(mapped?.row.correlationId, 'corr-first')
    assert.equal(mapped?.stampedRecord, rec)
    assert.deepEqual(rec.metadata.get(CORRELATION_METADATA_KEY), { correlationId: 'corr-first' })
    // Consumed: a second offer on the same connection gets nothing unless announced again.
    const second = toOutboxRow({ type: 'DidCommCredentialStateChanged', metadata: { contextCorrelationId: 'tenant-a' }, payload: { credentialExchangeRecord: record({ id: 'rec-2', connectionId: 'conn-1' }) } }, pending)
    assert.equal(second?.row.correlationId, null)
  })

  it('anchors connection events on the out-of-band id and keeps the id across rapid events', () => {
    const pending = new PendingCorrelations()
    pending.announce('a', 'connection', 'oob-1', 'corr-inv')
    const event = (state: string) => ({
      type: 'ConnectionStateChanged',
      metadata: { contextCorrelationId: 'tenant-a' },
      // A fresh, unstamped record object each time, as Credo hands out before the persist lands.
      payload: { previousState: 'request-received', connectionRecord: record({ id: 'conn-rec', state, outOfBandId: 'oob-1' }) },
    })
    const first = toOutboxRow(event('request-received'), pending)
    const second = toOutboxRow(event('response-sent'), pending)
    const third = toOutboxRow(event('completed'), pending)
    assert.equal(first?.row.recordType, 'connection')
    assert.deepEqual([first?.row.correlationId, second?.row.correlationId, third?.row.correlationId], ['corr-inv', 'corr-inv', 'corr-inv'])
    assert.notEqual(first?.stampedRecord, null)
    assert.equal(second?.stampedRecord, null, 'only the first event needs persisting')
  })

  it('does not map the prefixed connection string that received nothing in T1', () => {
    assert.equal(
      toOutboxRow({ type: 'DidCommConnectionStateChanged', metadata: { contextCorrelationId: 'tenant-a' }, payload: { connectionRecord: record({}) } }),
      null
    )
  })

  it('records the verification result of a proof', () => {
    const mapped = toOutboxRow({
      type: 'DidCommProofStateChanged',
      metadata: { contextCorrelationId: 'tenant-a' },
      payload: { previousState: 'presentation-received', proofRecord: record({ state: 'done', isVerified: true }) },
    })
    assert.equal(mapped?.row.recordType, 'proof')
    assert.deepEqual(mapped?.row.payload, { isVerified: true })
  })

  it('ignores root-context events and unknown types', () => {
    assert.equal(toOutboxRow({ type: 'DidCommCredentialStateChanged', metadata: { contextCorrelationId: 'default' }, payload: { credentialExchangeRecord: record({}) } }), null)
    assert.equal(toOutboxRow({ type: 'DidCommBasicMessageStateChanged', metadata: { contextCorrelationId: 'tenant-a' }, payload: {} }), null)
  })
})

describe('PendingCorrelations', () => {
  it('is FIFO per key and supports cancel', () => {
    const pending = new PendingCorrelations()
    pending.announce('a', 'proof', 'conn', 'one')
    pending.announce('a', 'proof', 'conn', 'two')
    pending.cancel('a', 'proof', 'conn', 'one')
    assert.equal(pending.consume('a', 'proof', 'conn'), 'two')
    assert.equal(pending.consume('a', 'proof', 'conn'), null)
  })
})
