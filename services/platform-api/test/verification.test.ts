/**
 * The Verification page's routes and the customer activity route (implement/22-console-feedback.md
 * C10, C11) against a real Postgres (skipped without one): proof and face-check outcomes over a
 * window, rejection reasons and score distributions from the attempts, the face-checks list with its
 * filters, the counts of one connection, and the headline numbers on both dashboards.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, describe, it } from 'node:test'

import { biometricSettings, connections, consoleAudit, credentials, exchangeGateEvents, exchangeGates, proofTemplates, proofs, tenants, wallets } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { MASK } from '../src/http/personal-data.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

const db = await testDatabase()

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)
const day = (date: Date) => date.toISOString().slice(0, 10)
const thresholds = { minLivenessScore: 90, minMatchScore: 90 }

describe('verification statistics, face checks and customer activity', { skip: db ? false : 'no test database' }, () => {
  const app = buildApp({
    config: testConfig,
    db: db!.db,
    agent: fakeAgent().client,
    mediator: { createInvitation: async () => ({ outOfBandId: 'oob-v', invitationUrl: 'https://mediator.test?oob=v' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async () => 'requested',
  })
  const token = testConfig.CONSOLE_TOKEN as string
  const operator = { 'x-console-token': token, 'x-console-actor': 'user_op1', 'x-console-role': 'operator' }
  const member = (tenantId: string, role = 'member') => ({ 'x-console-token': token, 'x-console-actor': 'user_m1', 'x-console-role': role, 'x-console-tenant': tenantId })
  let acme = ''
  let globex = ''
  let apiKey = ''
  let template = ''
  const gate: Record<string, string> = {}

  /** A gate with its attempts; every attempt is made on the day the gate was created. */
  async function seedGate(tenantId: string, name: string, input: { recordType: 'credential' | 'proof'; recordId: string; status: 'pending' | 'passed' | 'failed' | 'expired'; createdAt: Date; attempts: Array<{ decision: 'passed' | 'failed'; reason: string; liveness: number | null; match: number | null }> }) {
    const last = input.attempts.at(-1)
    const [row] = await db!.db
      .insert(exchangeGates)
      .values({
        tenantId,
        recordType: input.recordType,
        recordId: input.recordId,
        threadId: `thread-${name}`,
        checkId: randomUUID(),
        providerId: 'mock',
        status: input.status,
        attempts: input.attempts.length,
        maxAttempts: 3,
        thresholds,
        livenessScore: last?.liveness ?? null,
        matchScore: last?.match ?? null,
        reason: input.status === 'expired' ? 'expired' : (last?.reason ?? null),
        expiresAt: new Date(input.createdAt.getTime() + 30 * 60 * 1000),
        decidedAt: input.status === 'pending' ? null : input.createdAt,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning()
    gate[name] = row.id
    await db!.db.insert(exchangeGateEvents).values([
      { gateId: row.id, tenantId, at: input.createdAt, type: 'gate_created' as const },
      ...input.attempts.map((attempt, index) => ({ gateId: row.id, tenantId, at: input.createdAt, type: 'attempt_completed' as const, attempt: index + 1, providerId: 'mock', livenessScore: attempt.liveness, matchScore: attempt.match, thresholds, decision: attempt.decision, reason: attempt.reason })),
    ])
  }

  before(async () => {
    await app.ready()
    const [a] = await db!.db.insert(tenants).values({ name: 'Acme', agentTenantId: 'agent-acme-v', status: 'ready' }).returning()
    const [g] = await db!.db.insert(tenants).values({ name: 'Globex', agentTenantId: 'agent-globex-v', status: 'ready' }).returning()
    acme = a.id
    globex = g.id
    apiKey = (await app.inject({ method: 'POST', url: '/v1/api-keys', headers: member(acme, 'owner'), payload: { label: 'backend' } })).json().apiKey
    const [t] = await db!.db.insert(proofTemplates).values({ tenantId: acme, name: 'Approve transfer', definition: { groups: [] } }).returning()
    template = t.id
    await db!.db.insert(biometricSettings).values({ tenantId: acme, enabled: true, defaultPolicy: { required: false, minMatchScore: 80, minLivenessScore: 85, maxAttempts: 3, ttlMinutes: 30 } })

    await db!.db.insert(connections).values([
      { tenantId: acme, recordId: 'conn-1', state: 'completed', externalId: 'user-001', theirLabel: 'Ada phone', createdAt: daysAgo(50), updatedAt: daysAgo(50) },
      { tenantId: acme, recordId: 'conn-2', state: 'completed', externalId: 'user-002', createdAt: daysAgo(5), updatedAt: daysAgo(5) },
      { tenantId: globex, recordId: 'conn-g', state: 'completed', externalId: 'user-001', createdAt: daysAgo(1), updatedAt: daysAgo(1) },
    ])
    await db!.db.insert(wallets).values([
      { tenantId: acme, externalId: 'user-001', tokenHash: 'hash-w1', createdAt: daysAgo(50), connectedAt: daysAgo(50) },
      { tenantId: acme, externalId: 'user-001', tokenHash: 'hash-w2', createdAt: daysAgo(2), revokedAt: daysAgo(1) },
      { tenantId: acme, externalId: 'user-002', tokenHash: 'hash-w3', createdAt: daysAgo(5) },
      { tenantId: globex, externalId: 'user-001', tokenHash: 'hash-w4', createdAt: daysAgo(1) },
    ])
    await db!.db.insert(credentials).values([
      { tenantId: acme, recordId: 'k1', connectionId: 'conn-1', state: 'done', externalId: 'user-001', createdAt: daysAgo(0), updatedAt: daysAgo(0) },
      { tenantId: acme, recordId: 'k2', connectionId: 'conn-2', state: 'offer-sent', externalId: 'user-002', createdAt: daysAgo(0), updatedAt: daysAgo(0) },
    ])
    const rule = (required: boolean) => ({ match: 'any' as const, required, conditions: [{ param: 'amount', op: 'gte' as const, value: 5000, input: required ? 7200 : 100, met: required }] })
    await db!.db.insert(proofs).values([
      { tenantId: acme, recordId: 'p1', connectionId: 'conn-1', state: 'done', verified: true, templateId: template, externalId: 'user-001', biometricCondition: rule(true), createdAt: daysAgo(0), updatedAt: daysAgo(0) },
      { tenantId: acme, recordId: 'p2', connectionId: 'conn-1', state: 'done', verified: false, templateId: template, biometricCondition: rule(false), createdAt: daysAgo(0), updatedAt: daysAgo(0) },
      { tenantId: acme, recordId: 'p3', connectionId: 'conn-2', state: 'abandoned', templateId: template, createdAt: daysAgo(3), updatedAt: daysAgo(3) },
      { tenantId: acme, recordId: 'p4', connectionId: 'conn-1', state: 'request-sent', createdAt: daysAgo(3), updatedAt: daysAgo(3) },
      { tenantId: acme, recordId: 'p5', connectionId: 'conn-1', state: 'done', verified: true, templateId: template, createdAt: daysAgo(40), updatedAt: daysAgo(40) },
      { tenantId: globex, recordId: 'pg', connectionId: 'conn-g', state: 'done', verified: true, createdAt: daysAgo(0), updatedAt: daysAgo(0) },
    ])

    await seedGate(acme, 'g1', { recordType: 'proof', recordId: 'p1', status: 'passed', createdAt: daysAgo(0), attempts: [{ decision: 'failed', reason: 'match_below_threshold', liveness: 95, match: 12 }, { decision: 'passed', reason: 'passed', liveness: 97, match: 99 }] })
    await seedGate(acme, 'g2', { recordType: 'credential', recordId: 'k1', status: 'passed', createdAt: daysAgo(0), attempts: [{ decision: 'passed', reason: 'passed', liveness: 100, match: 91 }] })
    // The second attempt's scores were erased (Phase 7 H1): its reason still counts, its scores do not.
    await seedGate(acme, 'g3', { recordType: 'proof', recordId: 'p3', status: 'failed', createdAt: daysAgo(3), attempts: [{ decision: 'failed', reason: 'liveness_below_threshold', liveness: 45, match: null }, { decision: 'failed', reason: 'match_below_threshold', liveness: null, match: null }, { decision: 'failed', reason: 'no_face', liveness: 96, match: null }] })
    await seedGate(acme, 'g4', { recordType: 'credential', recordId: 'k2', status: 'pending', createdAt: daysAgo(0), attempts: [] })
    await seedGate(acme, 'g5', { recordType: 'proof', recordId: 'p5', status: 'expired', createdAt: daysAgo(40), attempts: [] })
    await seedGate(globex, 'gg', { recordType: 'proof', recordId: 'pg', status: 'failed', createdAt: daysAgo(0), attempts: [{ decision: 'failed', reason: 'vendor_failed', liveness: 5, match: 5 }] })
  })

  const stats = async (tenantId: string, query = '') => (await app.inject({ method: 'GET', url: `/v1/stats/verification${query}`, headers: member(tenantId) })).json()
  const checks = async (query = '', headers: Record<string, string> = member(acme)) => (await app.inject({ method: 'GET', url: `/v1/biometrics/checks${query}`, headers })).json() as { total: number; items: Array<{ id: string; recordType: string; recordId: string; externalId: string | null; connectionId: string | null; thresholds: unknown; biometric: { status: string; attempts: number } }> }
  const ids = (page: { items: Array<{ id: string }> }) => page.items.map((item) => Object.entries(gate).find(([, id]) => id === item.id)?.[0])

  it('is served to the console only, within the window bounds', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/stats/verification', headers: { authorization: `Bearer ${apiKey}` } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/biometrics/checks', headers: { authorization: `Bearer ${apiKey}` } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections/conn-1/activity', headers: { authorization: `Bearer ${apiKey}` } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/stats/verification?days=5', headers: member(acme) })).statusCode, 400)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/stats/verification?days=200', headers: member(acme) })).statusCode, 400)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/stats/verification', headers: member(acme) })).statusCode, 200)
  })

  it('counts proof requests on the day they started, by their outcome today', async () => {
    const { days, proofs: p } = await stats(acme)
    assert.equal(days, 30)
    assert.deepEqual([p.requested, p.verified, p.failed, p.abandoned, p.inFlight], [4, 1, 1, 1, 1])
    assert.equal(p.series.length, 30, 'every day of the window is present')
    assert.equal(p.series.at(-1).day, day(new Date()))
    assert.deepEqual(p.series.at(-1), { day: day(new Date()), verified: 1, failed: 1, abandoned: 0, inFlight: 0 })
    assert.deepEqual(p.series.find((point: { day: string }) => point.day === day(daysAgo(3))), { day: day(daysAgo(3)), verified: 0, failed: 0, abandoned: 1, inFlight: 1 })
    assert.deepEqual(p.series.find((point: { day: string }) => point.day === day(daysAgo(10))), { day: day(daysAgo(10)), verified: 0, failed: 0, abandoned: 0, inFlight: 0 })
    assert.deepEqual(p.templates, [
      { templateId: template, name: 'Approve transfer', requested: 3, verified: 1, failed: 1 },
      { templateId: null, name: null, requested: 1, verified: 0, failed: 0 },
    ])
    assert.deepEqual(p.conditional, { required: 1, notRequired: 1 })

    const wide = (await stats(acme, '?days=90')).proofs
    assert.deepEqual([wide.requested, wide.verified, wide.series.length], [5, 2, 90])
  })

  it('counts face checks by outcome and by what they guarded', async () => {
    const { faceChecks: f } = await stats(acme)
    assert.equal(f.enabled, true)
    assert.deepEqual(f.thresholds, { minLivenessScore: 85, minMatchScore: 80 })
    assert.equal(f.total, 4)
    assert.deepEqual(f.byStatus, { pending: 1, passed: 2, failed: 1, expired: 0, cancelled: 0 })
    assert.deepEqual(f.issuance, { pending: 1, passed: 1, failed: 0, expired: 0, cancelled: 0 })
    assert.deepEqual(f.proofs, { pending: 0, passed: 1, failed: 1, expired: 0, cancelled: 0 })
    assert.equal(f.series.length, 30)
    assert.deepEqual(f.series.at(-1), { day: day(new Date()), passed: 2, failed: 0, expired: 0, open: 1, cancelled: 0 })
    assert.deepEqual(f.series.find((point: { day: string }) => point.day === day(daysAgo(3))), { day: day(daysAgo(3)), passed: 0, failed: 1, expired: 0, open: 0, cancelled: 0 })
    assert.deepEqual(f.attemptsToPass, [{ attempts: 1, checks: 1 }, { attempts: 2, checks: 1 }])

    const wide = (await stats(acme, '?days=90')).faceChecks
    assert.equal(wide.total, 5)
    assert.equal(wide.byStatus.expired, 1)
  })

  it('reports why attempts were turned down and how the scores spread, ignoring erased scores', async () => {
    const { faceChecks: f } = await stats(acme)
    assert.deepEqual(f.attempts, { total: 6, passed: 2, rejected: 4 })
    assert.deepEqual(f.reasons, [
      { reason: 'match_below_threshold', attempts: 2 },
      { reason: 'liveness_below_threshold', attempts: 1 },
      { reason: 'no_face', attempts: 1 },
    ])
    // Liveness 45, 95, 96, 97, 100; the erased attempt has none. A score of 100 belongs to the last bucket.
    assert.deepEqual(f.scores.liveness, [0, 0, 0, 0, 1, 0, 0, 0, 0, 4])
    // Match 12, 91, 99.
    assert.deepEqual(f.scores.match, [0, 1, 0, 0, 0, 0, 0, 0, 0, 2])
  })

  it('keeps tenants apart and answers a tenant without checks with zeros and the default thresholds', async () => {
    const other = await stats(globex)
    assert.deepEqual([other.proofs.requested, other.faceChecks.total, other.faceChecks.byStatus.failed], [1, 1, 1])
    assert.deepEqual(other.faceChecks.reasons, [{ reason: 'vendor_failed', attempts: 1 }])
    assert.equal(other.faceChecks.enabled, false)
    assert.deepEqual(other.faceChecks.thresholds, { minLivenessScore: 90, minMatchScore: 90 })
    assert.equal((await checks('', member(globex))).total, 1)
  })

  it('lists face checks newest first, with the exchange they guard', async () => {
    const all = await checks()
    assert.equal(all.total, 5)
    assert.equal(ids(all).at(-1), 'g5', 'the oldest check comes last')
    assert.deepEqual(new Set(ids(all).slice(0, 3)), new Set(['g1', 'g2', 'g4']), 'the three of today come first')
    const first = all.items.find((item) => item.id === gate.g1)
    assert.deepEqual([first?.recordType, first?.recordId, first?.externalId, first?.connectionId], ['proof', 'p1', 'user-001', 'conn-1'])
    assert.deepEqual(first?.thresholds, thresholds)
    assert.deepEqual([first?.biometric.status, first?.biometric.attempts], ['passed', 2])
    assert.equal(all.items.find((item) => item.id === gate.g2)?.externalId, 'user-001', 'a credential check takes the reference of its credential')

    // The log of a listed check is readable on a deployment without biometric-service, as this app is.
    const log = (await app.inject({ method: 'GET', url: '/v1/proofs/p3/biometric-log', headers: member(acme) })).json()
    assert.equal(log.biometric.status, 'failed')
    assert.deepEqual(log.events.map((event: { type: string; reason: string | null }) => [event.type, event.reason]), [
      ['gate_created', null],
      ['attempt_completed', 'liveness_below_threshold'],
      ['attempt_completed', 'match_below_threshold'],
      ['attempt_completed', 'no_face'],
    ])
    assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/credentials/k2/biometric-log', headers: member(acme) })).json().events.length, 1)
  })

  it('filters the list by status, kind, rejection reason, connection, reference and day', async () => {
    assert.deepEqual(new Set(ids(await checks('?status=passed'))), new Set(['g1', 'g2']))
    assert.deepEqual(new Set(ids(await checks('?status=failed&status=expired'))), new Set(['g3', 'g5']))
    assert.deepEqual(new Set(ids(await checks('?recordType=credential'))), new Set(['g2', 'g4']))
    assert.deepEqual(ids(await checks('?reason=no_face')), ['g3'])
    assert.deepEqual(new Set(ids(await checks('?reason=match_below_threshold'))), new Set(['g1', 'g3']), 'any unsuccessful attempt with the reason counts, also when a later one passed')
    assert.deepEqual(ids(await checks('?reason=passed')), [], 'a successful attempt is not a rejection')
    assert.deepEqual(new Set(ids(await checks('?connectionId=conn-1'))), new Set(['g1', 'g2', 'g5']))
    assert.deepEqual(new Set(ids(await checks('?q=USER-001'))), new Set(['g1', 'g2']))
    assert.deepEqual(ids(await checks(`?to=${encodeURIComponent(daysAgo(20).toISOString())}`)), ['g5'])
    assert.deepEqual(ids(await checks('?status=passed&recordType=proof&connectionId=conn-1')), ['g1'])
    assert.equal((await app.inject({ method: 'GET', url: '/v1/biometrics/checks?pageSize=10', headers: member(acme) })).statusCode, 400)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/biometrics/checks?recordType=wallet', headers: member(acme) })).statusCode, 400)
  })

  it('sums one connection: its exchanges, its face checks, and the wallets with the same reference', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/connections/conn-1/activity', headers: member(acme) })
    assert.equal(response.statusCode, 200, response.body)
    const activity = response.json()
    assert.deepEqual([activity.connection.id, activity.connection.externalId, activity.connection.theirLabel], ['conn-1', 'user-001', 'Ada phone'])
    assert.deepEqual(activity.credentials, { total: 1, byState: { done: 1 } })
    assert.deepEqual(activity.proofs, { total: 4, byState: { done: 3, 'request-sent': 1 }, verified: 2, failed: 1 })
    assert.deepEqual(activity.faceChecks, { total: 3, byStatus: { passed: 2, expired: 1 } })
    assert.equal(activity.wallets.length, 2, 'only this tenant\'s wallets with the same external id')
    assert.ok(activity.wallets[0].revokedAt !== null && activity.wallets[1].revokedAt === null, 'newest first')
    assert.ok(new Date(activity.lastActivityAt) > daysAgo(1), 'the latest exchange, not the connection itself')

    const quiet = (await app.inject({ method: 'GET', url: '/v1/connections/conn-2/activity', headers: member(acme) })).json()
    assert.deepEqual([quiet.credentials.total, quiet.proofs.total, quiet.proofs.verified, quiet.faceChecks.total, quiet.wallets.length], [1, 1, 0, 2, 1])
  })

  it('masks the holder label for operators and auditors, and does not find another tenant\'s connection', async () => {
    for (const role of ['operator', 'auditor']) {
      const seen = await app.inject({ method: 'GET', url: '/v1/connections/conn-1/activity', headers: { ...operator, 'x-console-role': role, 'x-console-tenant': acme } })
      assert.equal(seen.statusCode, 200, seen.body)
      assert.equal(seen.json().connection.theirLabel, MASK)
      assert.equal(seen.json().proofs.total, 4)
    }
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections/conn-g/activity', headers: member(acme) })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/connections/nope/activity', headers: member(acme) })).statusCode, 404)
  })

  it('puts the headline numbers on both dashboards and audits only the reads of a log', async () => {
    const tenant = (await app.inject({ method: 'GET', url: '/v1/stats', headers: member(acme) })).json()
    assert.deepEqual(tenant.verification, { proofsRequested: 4, proofsVerified: 1, proofsFailed: 1, faceChecks: 4, faceChecksPassed: 2, faceChecksFailed: 1 })
    const platform = await app.inject({ method: 'GET', url: '/admin/stats', headers: operator })
    assert.equal(platform.statusCode, 200, platform.body)
    assert.deepEqual(platform.json().verification, { proofsRequested: 5, proofsVerified: 2, proofsFailed: 1, faceChecks: 5, faceChecksPassed: 2, faceChecksFailed: 2 })
    const wide = (await app.inject({ method: 'GET', url: '/v1/stats?days=90', headers: member(acme) })).json()
    assert.deepEqual([wide.verification.proofsRequested, wide.verification.faceChecksFailed], [5, 2], 'a check that ran out of time counts as failed')

    await new Promise((resolve) => setTimeout(resolve, 150))
    const audited = await db!.db.select().from(consoleAudit)
    // Only the two log reads above are audited (they show one person's scores); the aggregates and lists are not.
    assert.deepEqual(audited.filter((row) => row.method === 'GET').map((row) => row.route).sort(), ['/v1/credentials/:id/biometric-log', '/v1/proofs/:id/biometric-log'])
  })
})
