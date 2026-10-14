import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { ServiceError, decide, decodeReferenceImage } from '../src/biometric.ts'
import type { Database } from '../src/db/client.ts'
import * as schema from '../src/db/schema.ts'
import type { BiometricProvider } from '../src/providers/types.ts'
import { mockProvider } from '../src/providers/mock.ts'
import { capturingLogger, closeTestDatabase, defaultCheck, fakeJpeg, mockTenant, testDatabase, testService } from './helpers.ts'

const thresholds = { minLivenessScore: 90, minMatchScore: 90 }
const ready = (livenessScore: number) => ({ status: 'ready' as const, livenessScore, probeImage: Buffer.alloc(0), raw: {} })

describe('decide', () => {
  it('applies liveness, face presence and match in that order', () => {
    assert.deepEqual(decide(thresholds, ready(95), 95), { decision: 'passed', reason: 'passed' })
    assert.equal(decide(thresholds, ready(80), 95).reason, 'liveness_below_threshold')
    assert.equal(decide(thresholds, ready(95), null).reason, 'no_face')
    assert.equal(decide(thresholds, ready(95), 89.9).reason, 'match_below_threshold')
    assert.equal(decide(thresholds, { status: 'failed', reason: 'vendor_expired', raw: {} }, null).reason, 'vendor_expired')
  })
})

describe('reference image validation', () => {
  it('accepts JPEG and PNG base64 only, up to 5 MB', () => {
    assert.equal(decodeReferenceImage(fakeJpeg().toString('base64')).length, 404)
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10)])
    assert.ok(decodeReferenceImage(png.toString('base64')))
    assert.throws(() => decodeReferenceImage(Buffer.from('GIF89a....').toString('base64')), ServiceError)
    assert.throws(() => decodeReferenceImage('not base64!!'), ServiceError)
    assert.throws(() => decodeReferenceImage(fakeJpeg(5 * 1024 * 1024).toString('base64')), ServiceError)
  })
})

describe('biometric service (database)', async () => {
  let db: Database | null = null
  beforeEach(async () => {
    db = await testDatabase()
  })
  after(closeTestDatabase)

  const skip = () => {
    if (!db) {
      console.log('# skipped: TEST_DATABASE_URL unreachable')
      return true
    }
    return false
  }

  it('creates an external id per tenant and never returns the config ciphertext', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const first = await service.getTenantProvider('tenant-a')
    const again = await service.getTenantProvider('tenant-a')
    assert.match(first.externalId, /^12id-[0-9a-f-]{36}$/)
    assert.equal(first.externalId, again.externalId)
    assert.notEqual((await service.getTenantProvider('tenant-b')).externalId, first.externalId)
    assert.equal(first.provider, null)

    const configured = await service.putTenantProvider('tenant-a', 'mock', {})
    assert.deepEqual(Object.keys(configured.provider!).sort(), ['id', 'lastError', 'lastTestedAt', 'publicConfig', 'status', 'updatedAt'])
    assert.equal(configured.provider!.status, 'untested')
  })

  it('refuses unknown providers, invalid config, and checks before a successful test', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    await assert.rejects(service.putTenantProvider('tenant-a', 'facetec', {}), { code: 'unknown_provider' })
    await assert.rejects(service.putTenantProvider('tenant-a', 'mock', { extra: 1 }), { code: 'invalid_provider_config' })
    await assert.rejects(service.createCheck(defaultCheck('tenant-a')), { code: 'provider_not_configured' })
    await service.putTenantProvider('tenant-a', 'mock', {})
    await assert.rejects(service.createCheck(defaultCheck('tenant-a')), { code: 'provider_not_tested' })
  })

  it('keeps a configuration that waits for approval apart from the active one', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const active = await service.getTenantProvider(tenantId)
    assert.equal(active.provider!.status, 'ok')

    // Waiting: validated and encrypted like an active one, and nothing uses it.
    await assert.rejects(service.putPendingProvider(tenantId, 'facetec', {}), { code: 'unknown_provider' })
    await assert.rejects(service.putPendingProvider(tenantId, 'mock', { extra: 1 }), { code: 'invalid_provider_config' })
    assert.deepEqual(await service.putPendingProvider(tenantId, 'mock', {}), { providerId: 'mock', publicConfig: {} })
    const [waiting] = await db!.select().from(schema.providerConfigsPending)
    assert.ok(waiting!.configCiphertext.length > 0)
    assert.deepEqual((await service.getTenantProvider(tenantId)).provider, active.provider, 'the active configuration is untouched')
    assert.ok((await service.createCheck(defaultCheck(tenantId))).checkId, 'checks still run on the active configuration')

    // Dropped: nothing to activate.
    await service.deletePendingProvider(tenantId)
    await assert.rejects(service.activatePendingProvider(tenantId), { code: 'no_pending_provider' })

    // Activated: it replaces the active one and must pass a connection test like any new configuration.
    await service.putPendingProvider(tenantId, 'mock', {})
    const activated = await service.activatePendingProvider(tenantId)
    assert.equal(activated.provider!.status, 'untested')
    assert.equal((await db!.select().from(schema.providerConfigsPending)).length, 0)
    await assert.rejects(service.createCheck(defaultCheck(tenantId)), { code: 'provider_not_tested' })
    assert.deepEqual(await service.testTenantProvider(tenantId), { status: 'ok', error: null })
    // One tenant's waiting configuration is not another's.
    await service.putPendingProvider('tenant-b', 'mock', {})
    await assert.rejects(service.activatePendingProvider(tenantId), { code: 'no_pending_provider' })
  })

  it('passes on the first attempt and wipes the reference image', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))

    const [stored] = await db!.select().from(schema.checks).where(eq(schema.checks.id, checkId))
    assert.ok(stored!.referenceCiphertext && stored!.referenceCiphertext.length > 400, 'reference is stored encrypted')

    const session = await service.startSession(checkId)
    assert.equal(session.attempt, 1)
    assert.equal(session.attemptsRemaining, 2)
    assert.deepEqual(session.captureModule, { provider: 'mock', minVersion: 1 })

    const done = await service.completeSession(session.sessionId, { live: true, face: 'same' })
    assert.deepEqual(done.result, { decision: 'passed', reason: 'passed', livenessScore: 97, matchScore: 99 })
    assert.deepEqual(done.check, { status: 'passed', attemptsRemaining: 0 })

    const [after] = await db!.select().from(schema.checks).where(eq(schema.checks.id, checkId))
    assert.equal(after!.referenceCiphertext, null)
    assert.ok(after!.decidedAt)

    const view = await service.getCheck(checkId)
    assert.equal(view.sessions.length, 1)
    assert.equal(view.sessions[0]!.result!.decision, 'passed')
  })

  it('erases a decided check: the decision stays, scores, hashes, vendor values and session ids go', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))
    const session = await service.startSession(checkId)
    await service.completeSession(session.sessionId, { live: true, face: 'same' })

    assert.deepEqual(await service.eraseCheck(checkId), { erased: true })
    const [check] = await db!.select().from(schema.checks).where(eq(schema.checks.id, checkId))
    assert.equal(check!.status, 'passed')
    assert.equal(check!.referenceSha256, null)
    assert.ok(check!.erasedAt)
    const [stored] = await db!.select().from(schema.sessions).where(eq(schema.sessions.checkId, checkId))
    assert.equal(stored!.vendorSessionId, null)
    const [result] = await db!.select().from(schema.results).where(eq(schema.results.checkId, checkId))
    assert.deepEqual([result!.decision, result!.livenessScore, result!.matchScore, result!.probeSha256, result!.raw], ['passed', null, null, null, {}])

    const view = await service.getCheck(checkId)
    assert.equal(view.sessions[0]!.vendorSessionId, null)
    assert.deepEqual(await service.eraseCheck(checkId), { erased: true }, 'idempotent')
    assert.deepEqual(await service.eraseCheck('00000000-0000-4000-8000-000000000000'), { erased: false })
  })

  it('erasing a pending check cancels it', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))
    await service.eraseCheck(checkId)
    const [check] = await db!.select().from(schema.checks).where(eq(schema.checks.id, checkId))
    assert.equal(check!.status, 'cancelled')
    assert.equal(check!.referenceCiphertext, null)
  })

  it('keeps the check pending after a failed attempt, fails it when attempts run out', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId, { maxAttempts: 2 }))

    const s1 = await service.startSession(checkId)
    const r1 = await service.completeSession(s1.sessionId, { live: true, face: 'other' })
    assert.deepEqual([r1.result.reason, r1.check.status, r1.check.attemptsRemaining], ['match_below_threshold', 'pending', 1])

    const s2 = await service.startSession(checkId)
    const r2 = await service.completeSession(s2.sessionId, { live: false, face: 'same' })
    assert.deepEqual([r2.result.reason, r2.check.status], ['liveness_below_threshold', 'failed'])

    await assert.rejects(service.startSession(checkId), { code: 'check_failed' })
    const [row] = await db!.select().from(schema.checks).where(eq(schema.checks.id, checkId))
    assert.equal(row!.referenceCiphertext, null)
  })

  it('counts abandoned sessions as attempts', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId, { maxAttempts: 2 }))
    await service.startSession(checkId)
    await service.startSession(checkId)
    await assert.rejects(service.startSession(checkId), { code: 'attempts_exhausted' })
  })

  it('completes a session only once; an unfinished vendor result can be retried', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))
    const s = await service.startSession(checkId)

    // The mock answers "pending" to output it cannot parse, like AWS while the device still streams.
    await assert.rejects(service.completeSession(s.sessionId, { streaming: true }), { code: 'result_not_ready' })
    await service.completeSession(s.sessionId, { live: true, face: 'same' })
    await assert.rejects(service.completeSession(s.sessionId, { live: true, face: 'same' }), { code: 'session_already_completed' })
  })

  it('concurrent completes of one session: exactly one wins', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))
    const s = await service.startSession(checkId)
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => service.completeSession(s.sessionId, { live: true, face: 'same' })))
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1)
    assert.equal((await db!.select().from(schema.results).where(eq(schema.results.checkId, checkId))).length, 1)
  })

  it('reports no face in the probe as no_face', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))
    const s = await service.startSession(checkId)
    assert.equal((await service.completeSession(s.sessionId, { live: true, face: 'none' })).result.reason, 'no_face')
  })

  it('expires overdue checks and wipes their images', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId, { ttlSeconds: 60 }))
    await db!.update(schema.checks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.checks.id, checkId))

    assert.deepEqual(await service.expireDue(), [checkId])
    const [row] = await db!.select().from(schema.checks).where(eq(schema.checks.id, checkId))
    assert.deepEqual([row!.status, row!.referenceCiphertext], ['expired', null])
    await assert.rejects(service.startSession(checkId), { code: 'check_expired' })
  })

  it('refuses to start on an overdue check even before the sweep ran', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId, { ttlSeconds: 60 }))
    await db!.update(schema.checks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.checks.id, checkId))
    await assert.rejects(service.startSession(checkId), { code: 'check_expired' })
    const [row] = await db!.select().from(schema.checks).where(eq(schema.checks.id, checkId))
    assert.equal(row!.referenceCiphertext, null)
  })

  it('cancels a pending check and wipes it', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))
    await service.cancelCheck(checkId)
    const [row] = await db!.select().from(schema.checks).where(eq(schema.checks.id, checkId))
    assert.deepEqual([row!.status, row!.referenceCiphertext], ['cancelled', null])
  })

  it('keeps the tested status when only options change, directly or after approval', async (t) => {
    if (skip()) return t.skip()
    const optioned: BiometricProvider = {
      ...mockProvider,
      id: 'optioned',
      configSchema: z.object({ account: z.string(), option: z.string().default('a') }).strict(),
      connectionKeys: ['account'],
      publicConfig: (config) => config,
    }
    const service = testService(db!, [mockProvider, optioned])
    const tenantId = 'tenant-a'
    await service.putTenantProvider(tenantId, 'optioned', { account: '1' })
    await service.testTenantProvider(tenantId)
    const tested = (await service.getTenantProvider(tenantId)).provider!
    assert.equal(tested.status, 'ok')

    const changed = await service.putTenantProvider(tenantId, 'optioned', { account: '1', option: 'b' })
    assert.deepEqual([changed.provider!.status, changed.provider!.lastTestedAt, changed.provider!.publicConfig.option], ['ok', tested.lastTestedAt, 'b'])
    await service.putPendingProvider(tenantId, 'optioned', { account: '1', option: 'c' })
    assert.equal((await service.activatePendingProvider(tenantId)).provider!.status, 'ok')
    assert.ok((await service.createCheck(defaultCheck(tenantId))).checkId, 'face checks keep running')

    // A new connection, approved or not, needs a new test.
    await service.putPendingProvider(tenantId, 'optioned', { account: '2', option: 'c' })
    assert.equal((await service.activatePendingProvider(tenantId)).provider!.status, 'untested')
    await service.testTenantProvider(tenantId)
    assert.equal((await service.putTenantProvider(tenantId, 'optioned', { account: '3' })).provider!.status, 'untested')
    // Providers that do not name their connection keys: every change needs a test, as before.
    await mockTenant(service)
    assert.equal((await service.putTenantProvider(tenantId, 'mock', {})).provider!.status, 'untested')
  })

  it('refuses a session when the tenant switched provider after the check was created', async (t) => {
    if (skip()) return t.skip()
    const other: BiometricProvider = { ...mockProvider, id: 'mock-2', captureModule: { provider: 'mock-2', minVersion: 1 } }
    const service = testService(db!, [mockProvider, other])
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))
    await service.putTenantProvider(tenantId, 'mock-2', {})
    await assert.rejects(service.startSession(checkId), { code: 'provider_changed' })
  })

  it('does not consume an attempt when the vendor fails to create a session', async (t) => {
    if (skip()) return t.skip()
    let fail = true
    const flaky: BiometricProvider = {
      ...mockProvider,
      async createSession(ctx, input) {
        if (fail) throw new Error('vendor down')
        return mockProvider.createSession(ctx, input)
      },
    }
    const service = testService(db!, [flaky])
    const tenantId = await mockTenant(service)
    const { checkId } = await service.createCheck(defaultCheck(tenantId))
    await assert.rejects(service.startSession(checkId))
    fail = false
    assert.equal((await service.startSession(checkId)).attempt, 1)
  })

  it('never logs image bytes or capture output', async (t) => {
    if (skip()) return t.skip()
    const { logger, lines } = capturingLogger()
    const service = testService(db!, [mockProvider], logger)
    const tenantId = await mockTenant(service)
    const body = defaultCheck(tenantId)
    const { checkId } = await service.createCheck(body)
    const s = await service.startSession(checkId)
    await service.completeSession(s.sessionId, { live: true, face: 'same' })
    const all = lines.join('\n')
    assert.ok(all.length > 0)
    assert.equal(all.includes(body.referenceImage.slice(0, 40)), false)
    assert.equal(all.includes('mock-probe'), false)
  })
})
