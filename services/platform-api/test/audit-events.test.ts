/**
 * The audit beyond platform-api's own routes (implement/22-console-feedback.md C13), against a real
 * Postgres (skipped without one): events the console reports, the actor's label on every row, the
 * `kind` filter, and the triggers that keep the audit and the erasure log append-only.
 */
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import { consoleAudit, erasures, tenants } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { auditDetail } from '../src/http/audit-changes.ts'
import { cleanActorLabel } from '../src/http/auth.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

const db = await testDatabase()

describe('audit detail and actor label', () => {
  it('replaces secrets and personal data in an event detail and caps its size', () => {
    assert.deepEqual(auditDetail({ ip: '203.0.113.7', resetToken: 'abc', filters: { state: ['done'] } }), { ip: '203.0.113.7', resetToken: '[redacted]', filters: { state: ['done'] } })
    assert.equal(auditDetail({}), null)
    assert.equal(auditDetail(undefined), null)
    const huge = auditDetail({ note: 'x'.repeat(1900), more: 'y'.repeat(1900) })
    assert.equal(huge?.truncated, true)
    assert.equal(Object.keys(huge ?? {}).includes('note'), false)
  })

  it('decodes a label, drops control characters and never fails on a bad one', () => {
    assert.equal(cleanActorLabel(encodeURIComponent('ada+ops@example.com')), 'ada+ops@example.com')
    assert.equal(cleanActorLabel('plain@example.com'), 'plain@example.com')
    assert.equal(cleanActorLabel('%E0%A4%A'), '%E0%A4%A', 'malformed encoding is kept as sent')
    assert.equal(cleanActorLabel(encodeURIComponent('a\r\nb@example.com')), 'ab@example.com')
    assert.equal(cleanActorLabel('   '), undefined)
    assert.equal(cleanActorLabel(undefined), undefined)
    assert.equal(cleanActorLabel('x'.repeat(500))?.length, 320)
  })
})

describe('console audit events', { skip: db ? false : 'no test database' }, () => {
  const app = buildApp({
    config: testConfig,
    db: db!.db,
    agent: fakeAgent().client,
    mediator: { createInvitation: async () => ({ outOfBandId: 'oob-e', invitationUrl: 'https://mediator.test?oob=e' }) },
    logger: silentLogger,
    readiness: async () => ({ ready: true, draining: false, checks: {} }),
    wake: async () => 'requested',
  })
  const token = testConfig.CONSOLE_TOKEN as string
  const consoleOnly = { 'x-console-token': token }
  const operator = { ...consoleOnly, 'x-console-actor': 'user_op1', 'x-console-role': 'operator', 'x-console-actor-label': encodeURIComponent('op1@example.com') }
  const event = (payload: Record<string, unknown>, headers: Record<string, string> = consoleOnly) => app.inject({ method: 'POST', url: '/admin/audit/events', headers, payload })
  const audit = async (query = '') => (await app.inject({ method: 'GET', url: `/admin/audit${query}`, headers: operator })).json() as { total: number; items: Array<Record<string, unknown>> }
  /** Rows written by the response hook land after the response; wait for the expected count. */
  async function rowCount(atLeast: number) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [{ n }] = (await db!.db.execute<{ n: number }>(sql`select count(*)::int as n from console_audit`)).rows
      if (Number(n) >= atLeast) return Number(n)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return -1
  }

  before(async () => {
    await app.ready()
  })

  it('accepts the console token alone and nothing else', async () => {
    const body = { type: 'auth.sign_in_failed', outcome: 'failure', actorLabel: 'nobody@example.com', detail: { ip: '203.0.113.7' } }
    assert.equal((await event(body, {})).statusCode, 401)
    assert.equal((await event(body, { 'x-console-token': 'x'.repeat(40) })).statusCode, 401)
    assert.equal((await event(body, { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN })).statusCode, 401, 'the break-glass token cannot write events')
    const recorded = await event(body)
    assert.equal(recorded.statusCode, 201, recorded.body)
    assert.deepEqual(recorded.json(), { recorded: true })
  })

  it('refuses an unknown type, a malformed actor and an unknown field of the wrong shape', async () => {
    assert.equal((await event({ type: 'auth.made_up', outcome: 'success' })).statusCode, 400)
    assert.equal((await event({ type: 'auth.sign_in', outcome: 'maybe' })).statusCode, 400)
    assert.equal((await event({ type: 'auth.sign_in', outcome: 'success', actor: 'has spaces' })).statusCode, 400)
    assert.equal((await event({ type: 'auth.sign_in', outcome: 'success', tenantId: 'not-a-uuid' })).statusCode, 400)
    assert.equal((await event({ type: 'auth.sign_in', outcome: 'success', role: 'Robert"); drop' })).statusCode, 400)
  })

  it('stores an event as an audit row: type as route, outcome as status, detail redacted', async () => {
    const [tenant] = await db!.db.insert(tenants).values({ name: 'Acme', agentTenantId: 'agent-events-1', status: 'ready' }).returning()
    assert.equal((await event({ type: 'auth.sign_in', outcome: 'success', actor: 'user_op1', actorLabel: 'op1@example.com', role: 'operator', detail: { ip: '198.51.100.4', userAgent: 'Firefox' } })).statusCode, 201)
    assert.equal((await event({ type: 'account.member_invited', outcome: 'success', actor: 'user_owner', actorLabel: 'owner@acme.test', role: 'owner', tenantId: tenant.id, detail: { email: 'new@acme.test', role: 'member', inviteToken: 'secret-value' } })).statusCode, 201)
    assert.equal((await event({ type: 'export.run', outcome: 'success', actor: 'user_op1', actorLabel: 'op1@example.com', role: 'operator', tenantId: tenant.id, detail: { list: 'proofs', format: 'xlsx', rows: 312, filters: { state: ['done'] } } })).statusCode, 201)

    const rows = await db!.db.select().from(consoleAudit).orderBy(consoleAudit.id)
    const failed = rows.find((row) => row.route === 'auth.sign_in_failed')
    assert.deepEqual([failed?.method, failed?.actor, failed?.actorLabel, failed?.role, failed?.statusCode], ['EVENT', 'anonymous', 'nobody@example.com', 'none', 401])
    const signedIn = rows.find((row) => row.route === 'auth.sign_in')
    assert.deepEqual([signedIn?.actor, signedIn?.statusCode, signedIn?.changes], ['user_op1', 200, { ip: '198.51.100.4', userAgent: 'Firefox' }])
    const invited = rows.find((row) => row.route === 'account.member_invited')
    assert.equal(invited?.tenantId, tenant.id)
    assert.deepEqual(invited?.changes, { email: 'new@acme.test', role: 'member', inviteToken: '[redacted]' })
    assert.equal(rows.filter((row) => row.route === '/admin/audit/events').length, 0, 'the events route itself is not audited a second time')
  })

  it('keeps the actor label on rows written by the response hook, and finds rows by it', async () => {
    const before = await rowCount(0)
    const created = await app.inject({ method: 'POST', url: '/admin/tenants', headers: operator, payload: { name: 'Globex' } })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(await rowCount(before + 1), before + 1)
    const [row] = await db!.db.select().from(consoleAudit).where(eq(consoleAudit.route, '/admin/tenants'))
    assert.equal(row.actorLabel, 'op1@example.com')

    const byLabel = await audit('?q=OP1%40example')
    assert.ok(byLabel.total >= 2, 'the search matches the label, case-insensitively')
    assert.ok(byLabel.items.every((item) => item.actorLabel === 'op1@example.com'))
    assert.equal((await audit('?q=nobody%40')).total, 1)
  })

  it('filters by kind', async () => {
    const kinds = { change: await audit('?kind=change'), signIn: await audit('?kind=sign-in'), account: await audit('?kind=account'), exported: await audit('?kind=export') }
    assert.ok(kinds.change.items.every((item) => item.method !== 'EVENT'))
    assert.equal(kinds.change.total, 1)
    assert.deepEqual(kinds.signIn.items.map((item) => item.route).sort(), ['auth.sign_in', 'auth.sign_in_failed'])
    assert.deepEqual(kinds.account.items.map((item) => item.route), ['account.member_invited'])
    assert.deepEqual(kinds.exported.items.map((item) => item.route), ['export.run'])
    assert.equal((await app.inject({ method: 'GET', url: '/admin/audit?kind=everything', headers: operator })).statusCode, 400)
    const all = await audit()
    assert.equal(all.total, kinds.change.total + kinds.signIn.total + kinds.account.total + kinds.exported.total)
  })

  it('refuses to change, delete or truncate the audit and the erasure log', async () => {
    const [tenant] = await db!.db.select().from(tenants).limit(1)
    await db!.db.insert(erasures).values({ tenantId: tenant.id, recordType: 'proof', recordId: 'proof-1', via: 'console', actor: 'user_owner', role: 'owner', reason: 'requested' })
    const refused = async (statement: ReturnType<typeof sql>, table: string, operation: string) => {
      await assert.rejects(
        () => db!.db.execute(statement),
        (error: Error & { cause?: { message?: string; code?: string } }) => {
          const message = `${error.message} ${error.cause?.message ?? ''}`
          assert.match(message, new RegExp(`${table} is append-only: ${operation} refused`))
          return true
        }
      )
    }
    await refused(sql`update console_audit set actor = 'someone-else'`, 'console_audit', 'UPDATE')
    await refused(sql`delete from console_audit`, 'console_audit', 'DELETE')
    await refused(sql`truncate console_audit`, 'console_audit', 'TRUNCATE')
    await refused(sql`update erasures set reason = 'rewritten'`, 'erasures', 'UPDATE')
    await refused(sql`delete from erasures`, 'erasures', 'DELETE')
    await refused(sql`truncate erasures`, 'erasures', 'TRUNCATE')
    assert.ok((await rowCount(0)) > 0, 'nothing was removed')
    const [kept] = await db!.db.select().from(erasures)
    assert.equal(kept.reason, 'requested')
  })

  it('accepts the sign-in rule events (implement/24)', async () => {
    for (const type of ['auth.locked', 'auth.idle_sign_out', 'auth.session_replaced', 'auth.password_changed', 'auth.password_expired', 'account.unlocked', 'account.reenabled', 'account.disabled_inactive', 'account.password_link_sent']) {
      assert.equal((await event({ type, outcome: 'success', actorLabel: 'someone@example.com' })).statusCode, 201, type)
    }
  })
})
