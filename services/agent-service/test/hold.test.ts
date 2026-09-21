/**
 * Biometric gate hold points (Phase 6 B2) against a fake tenant agent: per-record auto-accept
 * override, release only from the hold state, and local abandonment with an outbox row.
 */
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'

import { DidCommAutoAcceptCredential, DidCommAutoAcceptProof } from '@credo-ts/didcomm'
import { pino } from 'pino'

import { PendingCorrelations } from '../src/events/correlation.ts'
import { type ExchangeDeps, abandonExchange, acceptPresentation, issueCredential, requestProof } from '../src/exchanges/exchanges.ts'

const silent = pino({ level: 'silent' }, new Writable({ write: (_c, _e, cb) => cb() }))

type FakeRecord = { id: string; state: string; threadId: string; connectionId: string; errorMessage?: string; metadata: { get: () => null } }

function fakeDeps(initial: { credentials?: FakeRecord[]; proofs?: FakeRecord[]; problemReportFails?: boolean } = {}) {
  const calls: { name: string; options: any }[] = []
  const outboxRows: any[] = []
  const store = { credentials: new Map((initial.credentials ?? []).map((r) => [r.id, r])), proofs: new Map((initial.proofs ?? []).map((r) => [r.id, r])) }
  const api = (kind: 'credentials' | 'proofs') => ({
    findById: async (id: string) => store[kind].get(id) ?? null,
    update: async (record: FakeRecord) => void store[kind].set(record.id, record),
    sendProblemReport: async (options: any) => {
      calls.push({ name: `${kind}.sendProblemReport`, options })
      if (initial.problemReportFails) throw new Error('holder unreachable')
    },
  })
  const tenantAgent = {
    modules: {
      didcomm: {
        credentials: {
          ...api('credentials'),
          acceptRequest: async (options: any) => {
            calls.push({ name: 'acceptRequest', options })
            const r = store.credentials.get(options.credentialExchangeRecordId)!
            return { ...r, state: 'credential-issued' }
          },
        },
        proofs: {
          ...api('proofs'),
          acceptPresentation: async (options: any) => {
            calls.push({ name: 'acceptPresentation', options })
            const r = store.proofs.get(options.proofExchangeRecordId)!
            return { ...r, state: 'done' }
          },
          requestProof: async (options: any) => {
            calls.push({ name: 'requestProof', options })
            return { id: 'proof-1', threadId: 'thread-p', state: 'request-sent' }
          },
        },
      },
    },
  }
  const deps = {
    agent: { modules: { tenants: { withTenantAgent: async (_: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tenantAgent) } } },
    db: {
      select: () => ({ from: () => ({ where: async () => [{ status: 'ready', label: 'x' }] }) }),
      insert: () => ({ values: async (row: unknown) => void outboxRows.push(row) }),
    },
    didcommEndpoint: 'https://agent.test',
    logger: silent,
    pendingCorrelations: new PendingCorrelations(),
  } as unknown as ExchangeDeps
  return { deps, calls, outboxRows, store }
}

const record = (id: string, state: string): FakeRecord => ({ id, state, threadId: `thread-${id}`, connectionId: 'conn-1', metadata: { get: () => null } })
const group = { key: 'badge', attributes: ['name'], credentialDefinitionIds: ['EAHqZgP3xBtmKuCMe57eWu:3:CL:12:default'] }

describe('biometric hold points (Phase 6 B2)', () => {
  it('a held proof request overrides auto-accept for that record only', async () => {
    const held = fakeDeps()
    await requestProof(held.deps, 't', { connectionId: 'c', name: 'p', groups: [group], hold: true })
    assert.equal(held.calls[0]!.options.autoAcceptProof, DidCommAutoAcceptProof.Never)

    const normal = fakeDeps()
    await requestProof(normal.deps, 't', { connectionId: 'c', name: 'p', groups: [group] })
    assert.equal('autoAcceptProof' in normal.calls[0]!.options, false)
    // The credential override uses the same spread; its constant must exist in this Credo version.
    assert.equal(DidCommAutoAcceptCredential.Never, 'never')
  })

  it('issues a held credential only from request-received', async () => {
    const { deps, calls } = fakeDeps({ credentials: [record('a', 'request-received'), record('b', 'offer-sent')] })
    assert.deepEqual(await issueCredential(deps, 't', 'a'), { id: 'a', state: 'credential-issued' })
    assert.equal(calls.filter((c) => c.name === 'acceptRequest').length, 1)
    await assert.rejects(issueCredential(deps, 't', 'b'), { status: 409 })
    await assert.rejects(issueCredential(deps, 't', 'missing'), { status: 404 })
  })

  it('accepts a held presentation only from presentation-received', async () => {
    const { deps } = fakeDeps({ proofs: [record('p', 'presentation-received'), record('q', 'request-sent')] })
    assert.equal((await acceptPresentation(deps, 't', 'p')).state, 'done')
    await assert.rejects(acceptPresentation(deps, 't', 'q'), { status: 409 })
  })

  it('abandons with a problem report and an outbox row, even when the holder is unreachable', async () => {
    const { deps, calls, outboxRows, store } = fakeDeps({ credentials: [record('a', 'request-received')], problemReportFails: true })
    assert.deepEqual(await abandonExchange(deps, 't', 'credential', 'a', 'biometric check failed'), { id: 'a', state: 'abandoned' })
    assert.equal(calls[0]!.name, 'credentials.sendProblemReport')
    assert.equal(store.credentials.get('a')!.errorMessage, 'biometric check failed')
    assert.deepEqual(
      { recordType: outboxRows[0].recordType, state: outboxRows[0].state, previousState: outboxRows[0].previousState, reason: outboxRows[0].payload.reason },
      { recordType: 'credential', state: 'abandoned', previousState: 'request-received', reason: 'biometric check failed' }
    )
  })

  it('abandon is a no-op on final states', async () => {
    const { deps, calls, outboxRows } = fakeDeps({ proofs: [record('p', 'done')] })
    assert.deepEqual(await abandonExchange(deps, 't', 'proof', 'p', 'late'), { id: 'p', state: 'done' })
    assert.equal(calls.length, 0)
    assert.equal(outboxRows.length, 0)
  })
})
