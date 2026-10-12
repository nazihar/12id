/**
 * The operators' system health (implement/22-console-feedback.md C16) against a real Postgres
 * (skipped without one): Alertmanager's webhook and what it stores, the heartbeat, alerts that are
 * never resolved, and the health route with its allow-list of settings.
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import { ALERT_KEEP_MS, ALERT_STALE_MS, alertOverview, sweepAlerts } from '../src/alerts.ts'
import type { PlatformConfig } from '../src/config.ts'
import { platformAlerts } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { runningSettings } from '../src/http/routes/health.ts'
import { fakeAgent, silentLogger, testConfig, testDatabase } from './helpers.ts'

const database = await testDatabase()
const SECRET = 'alert-webhook-'.padEnd(40, 'x')

describe('system health', { skip: database ? false : 'no test database' }, () => {
  const db = database!.db
  const config: PlatformConfig = { ...testConfig, ALERT_WEBHOOK_SECRET: SECRET, PLATFORM_VERSION: '0.5.0-test', PLATFORM_ENVIRONMENT: 'test' }
  const build = (appConfig: PlatformConfig) =>
    buildApp({
      config: appConfig,
      db,
      agent: fakeAgent().client,
      mediator: { createInvitation: async () => ({ outOfBandId: 'oob-x', invitationUrl: 'https://mediator.test?oob=x' }) },
      logger: silentLogger,
      readiness: async () => ({ ready: true, draining: false, checks: { database: true, agent: false, mediatorDatabase: true } }),
      wake: async () => 'requested',
    })
  const app = build(config)
  const unconnected = build(testConfig)

  const token = testConfig.CONSOLE_TOKEN as string
  const staff = (role: string) => ({ 'x-console-token': token, 'x-console-actor': `user_${role}`, 'x-console-role': role })
  const bearer = { authorization: `Bearer ${SECRET}` }

  const STARTED = '2026-10-12T06:00:00.123456789Z'
  const alert = (name: string, status: 'firing' | 'resolved', extra: { fingerprint?: string; startsAt?: string; endsAt?: string; severity?: string } = {}) => ({
    status,
    labels: { alertname: name, severity: extra.severity ?? 'warning', instance: 'api.test:443' },
    annotations: { summary: `${name} on api.test`, description: 'A longer explanation.' },
    startsAt: extra.startsAt ?? STARTED,
    endsAt: extra.endsAt ?? '0001-01-01T00:00:00Z',
    generatorURL: 'http://127.0.0.1:9090/graph',
    fingerprint: extra.fingerprint ?? `fp-${name}`,
  })
  const notify = (alerts: unknown[], headers: Record<string, string> = bearer, target = app) =>
    target.inject({ method: 'POST', url: '/internal/alerts', headers, payload: { version: '4', status: 'firing', receiver: 'console', groupLabels: {}, alerts } })
  const rows = () => db.select().from(platformAlerts).orderBy(platformAlerts.id)

  before(async () => {
    await app.ready()
    await unconnected.ready()
  })

  beforeEach(async () => {
    await testDatabase()
  })

  it('the webhook needs its secret, and does not exist without one', async () => {
    assert.equal((await notify([alert('EndpointDown', 'firing')], bearer, unconnected)).statusCode, 404)
    assert.equal((await notify([alert('EndpointDown', 'firing')], {})).statusCode, 401)
    assert.equal((await notify([alert('EndpointDown', 'firing')], { authorization: `Bearer ${'wrong'.padEnd(40, 'x')}` })).statusCode, 401)
    assert.equal((await notify([alert('EndpointDown', 'firing')], { authorization: `Bearer ${testConfig.CONSOLE_TOKEN}` })).statusCode, 401)
    assert.equal((await rows()).length, 0)
    assert.equal((await notify([{ status: 'firing' }])).statusCode, 400)

    const accepted = await notify([alert('EndpointDown', 'firing', { severity: 'critical' })])
    assert.equal(accepted.statusCode, 200)
    assert.deepEqual(accepted.json(), { received: 1 })
    const [stored] = await rows()
    assert.equal(stored!.name, 'EndpointDown')
    assert.equal(stored!.severity, 'critical')
    assert.equal(stored!.status, 'firing')
    assert.equal(stored!.summary, 'EndpointDown on api.test')
    assert.equal(stored!.labels.instance, 'api.test:443')
    assert.equal(stored!.endsAt, null)
  })

  it('a repeated notification updates its row; a resolve ends it; a new start is a new occurrence', async () => {
    await notify([alert('DiskSpaceLow', 'firing')])
    const [first] = await rows()
    await notify([alert('DiskSpaceLow', 'firing')])
    const again = await rows()
    assert.equal(again.length, 1)
    assert.ok(again[0]!.lastReceivedAt.getTime() >= first!.lastReceivedAt.getTime())
    assert.equal(again[0]!.firstReceivedAt.getTime(), first!.firstReceivedAt.getTime())

    await notify([alert('DiskSpaceLow', 'resolved', { endsAt: '2026-10-12T07:30:00Z' })])
    const [ended] = await rows()
    assert.equal(ended!.status, 'resolved')
    assert.equal(ended!.endsAt!.toISOString(), '2026-10-12T07:30:00.000Z')

    // The resolve is repeated (Alertmanager retries): still one row, still ended.
    await notify([alert('DiskSpaceLow', 'resolved', { endsAt: '2026-10-12T07:30:00Z' })])
    assert.deepEqual((await rows()).map((r) => r.status), ['resolved'])

    // A resolve that names a slightly different start still ends what is firing.
    await notify([alert('OutboxLag', 'firing', { startsAt: '2026-10-12T08:00:00Z' })])
    await notify([alert('OutboxLag', 'resolved', { startsAt: '2026-10-12T08:00:07Z', endsAt: '2026-10-12T08:20:00Z' })])
    const lag = (await rows()).filter((r) => r.name === 'OutboxLag')
    assert.deepEqual(lag.map((r) => [r.status, r.startsAt.toISOString(), r.endsAt?.toISOString()]), [['resolved', '2026-10-12T08:00:00.000Z', '2026-10-12T08:20:00.000Z']])
    await db.delete(platformAlerts).where(eq(platformAlerts.name, 'OutboxLag'))

    // It fires again later: the earlier occurrence stays in the history.
    await notify([alert('DiskSpaceLow', 'firing', { startsAt: '2026-10-12T09:00:00Z' })])
    assert.deepEqual((await rows()).map((r) => r.status), ['resolved', 'firing'])
    // Prometheus restarted and the same alert comes with a new start while the old one never resolved.
    await notify([alert('DiskSpaceLow', 'firing', { startsAt: '2026-10-12T10:00:00Z' })])
    assert.deepEqual((await rows()).map((r) => r.status), ['resolved', 'resolved', 'firing'])
  })

  it('the Watchdog is the heartbeat and is never listed', async () => {
    const empty = await alertOverview(db)
    assert.deepEqual(empty, { lastSignalAt: null, silent: true, firing: [], resolved: [] })

    await notify([alert('Watchdog', 'firing', { severity: 'none' })])
    const now = new Date()
    const overview = await alertOverview(db, now)
    assert.equal(overview.silent, false)
    assert.ok(overview.lastSignalAt)
    assert.deepEqual(overview.firing, [])
    // Twenty minutes with nothing: monitoring is silent.
    assert.equal((await alertOverview(db, new Date(now.getTime() + 20 * 60_000))).silent, true)
    // The heartbeat itself is never closed as stale.
    await sweepAlerts(db, new Date(now.getTime() + 2 * ALERT_STALE_MS))
    assert.equal((await rows())[0]!.status, 'firing')
  })

  it('an alert that is no longer repeated is closed, and old resolved ones are deleted', async () => {
    await notify([alert('OutboxLag', 'firing'), alert('MemoryLow', 'firing')])
    const now = Date.now()
    await sweepAlerts(db, new Date(now + ALERT_STALE_MS - 60_000))
    assert.deepEqual((await rows()).map((r) => r.status), ['firing', 'firing'])

    // MemoryLow keeps being repeated; OutboxLag is not.
    await db.update(platformAlerts).set({ lastReceivedAt: new Date(now + ALERT_STALE_MS) }).where(eq(platformAlerts.name, 'MemoryLow'))
    await sweepAlerts(db, new Date(now + ALERT_STALE_MS + 60_000))
    const byName = Object.fromEntries((await rows()).map((r) => [r.name, r]))
    assert.equal(byName.MemoryLow!.status, 'firing')
    assert.equal(byName.OutboxLag!.status, 'resolved')
    assert.equal(byName.OutboxLag!.endsAt!.getTime(), byName.OutboxLag!.lastReceivedAt.getTime())

    await sweepAlerts(db, new Date(now + ALERT_KEEP_MS + 60_000))
    assert.deepEqual((await rows()).map((r) => r.name), ['MemoryLow'])
  })

  it('operators and auditors read the health; nobody else does', async () => {
    await notify([alert('Watchdog', 'firing'), alert('EndpointDown', 'firing', { severity: 'critical' }), alert('DiskSpaceLow', 'resolved', { endsAt: new Date(Date.now() - 3_600_000).toISOString(), startsAt: new Date(Date.now() - 7_200_000).toISOString() })])

    assert.equal((await app.inject({ method: 'GET', url: '/admin/health' })).statusCode, 401)
    assert.equal((await app.inject({ method: 'GET', url: '/admin/health', headers: staff('owner') })).statusCode, 403)
    const auditor = await app.inject({ method: 'GET', url: '/admin/health', headers: staff('auditor') })
    assert.equal(auditor.statusCode, 200)

    const response = await app.inject({ method: 'GET', url: '/admin/health', headers: staff('operator') })
    assert.equal(response.statusCode, 200)
    const health = response.json()
    assert.equal(health.version, '0.5.0-test')
    assert.equal(health.environment, 'test')
    assert.deepEqual(health.checks, { database: true, agent: false, mediatorDatabase: true })
    assert.equal(health.monitoring.connected, true)
    assert.equal(health.monitoring.silent, false)
    assert.deepEqual(health.alerts.firing.map((a: { name: string; severity: string }) => [a.name, a.severity]), [['EndpointDown', 'critical']])
    assert.deepEqual(health.alerts.resolved.map((a: { name: string }) => a.name), ['DiskSpaceLow'])
    assert.ok(health.settings.some((s: { label: string; value: string }) => s.label === 'Audit log' && s.value === '730 days'))

    // The dashboard carries the count.
    const stats = await app.inject({ method: 'GET', url: '/admin/stats', headers: staff('operator') })
    assert.equal(stats.json().health.alertsFiring, 1)

    // A deployment without the secret says so, whatever the table holds.
    const other = (await unconnected.inject({ method: 'GET', url: '/admin/health', headers: staff('operator') })).json()
    assert.deepEqual([other.monitoring.connected, other.monitoring.silent, other.version], [false, true, null])
  })

  it('no secret reaches the settings', () => {
    // Every secret, and every URL that carries a password, set to a value that can be searched for.
    const marker = (name: string) => `SECRETMARK-${name}-`.padEnd(40, 'z')
    const secretKeys = Object.keys(testConfig).filter((key) => /TOKEN|SECRET|PASSWORD/.test(key))
    assert.ok(secretKeys.length >= 5, 'the test configuration names the secrets')
    const marked = { ...config, ...Object.fromEntries(secretKeys.map((key) => [key, marker(key)])), ALERT_WEBHOOK_SECRET: marker('ALERT'), BIOMETRIC_SERVICE_TOKEN: marker('BIOMETRIC'), BIOMETRIC_SERVICE_URL: 'http://biometric.test', DATABASE_URL: 'postgresql://user:SECRETMARK-db@host/db', MEDIATOR_DRIZZLE_URL: 'postgresql://ro:SECRETMARK-ro@host/drizzle' } as PlatformConfig
    const text = JSON.stringify(runningSettings(marked))
    assert.ok(!text.includes('SECRETMARK'), 'a secret value is in the settings')
    assert.ok(text.includes('connected'))
  })
})
