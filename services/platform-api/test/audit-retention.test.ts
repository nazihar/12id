/**
 * The audit log's period (implement/22-console-feedback.md C15) against a real Postgres (skipped
 * without one): which rows a pass deletes and which it keeps, the one row it leaves behind, the
 * append-only trigger still refusing everything else, and the console-only setting.
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import { AUDIT_PURGED_EVENT, auditRetentionOnce } from '../src/audit-retention.ts'
import { API_KEY_PREFIX, generateSecret, hashSecret, lookupPrefix } from '../src/auth/tokens.ts'
import { loadConfig } from '../src/config.ts'
import { apiKeys, consoleAudit, erasures, tenants } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

const database = await testDatabase()
const DAY = 86_400_000

describe('audit log period', { skip: database ? false : 'no test database' }, () => {
  const db = database!.db
  const app = buildApp({
    config: testConfig,
    db,
    agent: fakeAgent().client,
    mediator: { createInvitation: async () => ({ outOfBandId: 'oob-x', invitationUrl: 'https://mediator.test?oob=x' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async () => 'requested',
  })
  const token = testConfig.CONSOLE_TOKEN as string
  let tenantId = ''
  let otherTenantId = ''
  let bearer = ''
  const consoleAs = (role: string, actor = `user_${role}`) => ({ 'x-console-token': token, 'x-console-actor': actor, 'x-console-role': role, 'x-console-tenant': tenantId })

  const daysAgo = (days: number) => new Date(Date.now() - days * DAY)
  /** One audit row written `days` ago; `route` names it in the assertions. */
  const row = (route: string, days: number, tenant: string | null) => db.insert(consoleAudit).values({ at: daysAgo(days), actor: 'user_owner', role: 'owner', tenantId: tenant, method: 'PUT', route, statusCode: 200, requestId: 'r' })
  const routes = async () => (await db.select({ route: consoleAudit.route }).from(consoleAudit)).map((r) => r.route).sort()
  const pass = (options: { defaultDays?: number; batch?: number } = {}) => auditRetentionOnce({ db, logger: silentLogger, defaultDays: options.defaultDays ?? 730, batch: options.batch })
  const refused = async (run: () => Promise<unknown>, expected: RegExp) => {
    await assert.rejects(run, (error: Error & { cause?: { message?: string } }) => {
      assert.match(`${error.message} ${error.cause?.message ?? ''}`, expected)
      return true
    })
  }

  before(async () => {
    await app.ready()
  })

  beforeEach(async () => {
    await testDatabase()
    const [tenant, other] = await db
      .insert(tenants)
      .values([
        { name: 'Acme', agentTenantId: 'agent-acme', status: 'ready' },
        { name: 'Other', agentTenantId: 'agent-other', status: 'ready' },
      ])
      .returning()
    tenantId = tenant!.id
    otherTenantId = other!.id
    bearer = generateSecret(API_KEY_PREFIX)
    await db.insert(apiKeys).values({ tenantId, prefix: lookupPrefix(bearer), keyHash: hashSecret(bearer), label: 'backend' })
  })

  it('deletes what is older than the period, keeps the rest, and says so in one row', async () => {
    await row('old', 800, tenantId)
    await row('older', 1200, tenantId)
    await row('recent', 700, tenantId)
    await row('today', 0, tenantId)

    const report = await pass()
    assert.deepEqual(report, { scopes: 1, deleted: 2 })
    assert.deepEqual(await routes(), [AUDIT_PURGED_EVENT, 'recent', 'today'])
    const [left] = await db.select().from(consoleAudit).where(eq(consoleAudit.route, AUDIT_PURGED_EVENT))
    assert.equal(left!.tenantId, tenantId)
    assert.equal(left!.method, 'EVENT')
    assert.equal(left!.actor, 'system')
    assert.equal((left!.changes as { deleted: number; periodDays: number }).deleted, 2)
    assert.equal((left!.changes as { deleted: number; periodDays: number }).periodDays, 730)

    // Nothing left to do: a second pass deletes nothing and writes nothing.
    assert.deepEqual(await pass(), { scopes: 0, deleted: 0 })
    assert.equal((await routes()).length, 3)
  })

  it('a tenant follows its own period, and 0 keeps everything', async () => {
    await db.update(tenants).set({ auditRetentionDays: 365 }).where(eq(tenants.id, tenantId))
    await db.update(tenants).set({ auditRetentionDays: 0 }).where(eq(tenants.id, otherTenantId))
    await row('acme-400', 400, tenantId)
    await row('acme-300', 300, tenantId)
    await row('other-3000', 3000, otherTenantId)

    assert.deepEqual(await pass(), { scopes: 1, deleted: 1 })
    assert.deepEqual(await routes(), ['acme-300', AUDIT_PURGED_EVENT, 'other-3000'].sort())

    // A deployment that keeps everything touches no tenant on the default either.
    await db.update(tenants).set({ auditRetentionDays: null }).where(eq(tenants.id, tenantId))
    await row('acme-2000', 2000, tenantId)
    assert.deepEqual(await pass({ defaultDays: 0 }), { scopes: 0, deleted: 0 })
  })

  it('rows of no tenant, or of a tenant id that names none, follow the deployment period', async () => {
    await db.update(tenants).set({ auditRetentionDays: 3650 }).where(eq(tenants.id, tenantId))
    await row('acme-800', 800, tenantId)
    await row('sign-in-800', 800, null)
    await row('sign-in-10', 10, null)
    await row('unknown-tenant-800', 800, '00000000-0000-4000-8000-000000000001')

    assert.deepEqual(await pass(), { scopes: 1, deleted: 2 })
    assert.deepEqual(await routes(), ['acme-800', AUDIT_PURGED_EVENT, 'sign-in-10'].sort())
    const [left] = await db.select().from(consoleAudit).where(eq(consoleAudit.route, AUDIT_PURGED_EVENT))
    assert.equal(left!.tenantId, null)
  })

  it('works through more rows than one batch holds', async () => {
    for (let i = 0; i < 7; i += 1) await row(`old-${i}`, 800 + i, tenantId)
    await row('recent', 5, tenantId)
    assert.deepEqual(await pass({ batch: 3 }), { scopes: 1, deleted: 7 })
    assert.deepEqual(await routes(), [AUDIT_PURGED_EVENT, 'recent'].sort())
  })

  it('leaves the log append-only for everything else', async () => {
    await row('old', 800, tenantId)
    await pass()
    await row('kept', 1, tenantId)
    await db.insert(erasures).values({ tenantId, recordType: 'proof', recordId: 'proof-1', via: 'console', actor: 'user_owner', role: 'owner', reason: 'requested' })

    // The pass's permission ended with its transaction.
    await refused(() => db.execute(sql`delete from console_audit`), /console_audit is append-only: DELETE refused/)
    // Even with the setting, nothing but a DELETE on the audit log gets through.
    const withSetting = (statement: ReturnType<typeof sql>) => () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.audit_purge', 'on', true)`)
        await tx.execute(statement)
      })
    await refused(withSetting(sql`update console_audit set actor = 'someone-else'`), /console_audit is append-only: UPDATE refused/)
    await refused(withSetting(sql`truncate console_audit`), /console_audit is append-only: TRUNCATE refused/)
    await refused(withSetting(sql`delete from erasures`), /erasures is append-only: DELETE refused/)
    assert.equal((await db.select().from(erasures)).length, 1)
    assert.ok((await routes()).includes('kept'))
  })

  it('the period is a console-only setting of owners, admins and operators, a year at least', async () => {
    const read = await app.inject({ method: 'GET', url: '/v1/audit-retention', headers: consoleAs('member') })
    assert.deepEqual(read.json(), { auditRetentionDays: 730, tenantSetting: null, platformDefault: 730, minimumDays: 365 })
    assert.equal((await app.inject({ method: 'GET', url: '/v1/audit-retention', headers: { authorization: `Bearer ${bearer}` } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/v1/audit-retention', headers: consoleAs('auditor') })).statusCode, 200)

    const put = (role: string, auditRetentionDays: number | null) => app.inject({ method: 'PUT', url: '/v1/audit-retention', headers: consoleAs(role), payload: { auditRetentionDays } })
    assert.equal((await put('member', 400)).statusCode, 403)
    assert.equal((await put('auditor', 400)).statusCode, 403)
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/audit-retention', headers: { authorization: `Bearer ${bearer}` }, payload: { auditRetentionDays: 400 } })).statusCode, 403)
    assert.equal((await put('admin', 364)).statusCode, 400)
    assert.equal((await put('admin', 3651)).statusCode, 400)
    assert.deepEqual((await put('admin', 365)).json(), { auditRetentionDays: 365, tenantSetting: 365, platformDefault: 730, minimumDays: 365 })
    assert.equal((await put('owner', 0)).json().auditRetentionDays, 0)
    assert.deepEqual((await put('operator', null)).json(), { auditRetentionDays: 730, tenantSetting: null, platformDefault: 730, minimumDays: 365 })

    // The change is audited like any other console change, and the other tenant is untouched.
    const audited = await db.select().from(consoleAudit).where(eq(consoleAudit.route, '/v1/audit-retention'))
    assert.ok(audited.some((entry) => entry.statusCode === 200 && (entry.changes as { body?: { auditRetentionDays?: number } } | null)?.body?.auditRetentionDays === 365))
    const [other] = await db.select().from(tenants).where(eq(tenants.id, otherTenantId))
    assert.equal(other!.auditRetentionDays, null)
  })

  it('the deployment period is a year to ten years, or 0', () => {
    // The test configuration as an environment (it listens on port 0, which only a test may).
    const env = (days: string) => ({ ...Object.fromEntries(Object.entries(testConfig).map(([key, value]) => [key, String(value)])), PORT: '3500', SWEEP_INTERVAL_MS: '0', AUDIT_RETENTION_DAYS: days })
    assert.equal(loadConfig(env('0')).AUDIT_RETENTION_DAYS, 0)
    assert.equal(loadConfig(env('365')).AUDIT_RETENTION_DAYS, 365)
    assert.throws(() => loadConfig(env('90')), /AUDIT_RETENTION_DAYS/)
    assert.throws(() => loadConfig(env('4000')), /AUDIT_RETENTION_DAYS/)
  })
})
