/**
 * Console feedback sets 1 and 2 (implement/22-console-feedback.md), the checks a deployed platform-api can
 * answer without creating anything: the Verification routes, the face-checks list, one connection's
 * activity, the headline numbers on the dashboard, the read-only auditor role, the audit log's period
 * and the system health (set 2: it expects monitoring to be connected, with a fresh heartbeat). Reads only, plus
 * changes that must be refused; nothing is written, not even to the audit log (a refused auditor
 * request is not audited, and reads of these routes are not either).
 *
 * The browser side (sign-ins in the audit log, the pages, the export) is covered by the console's
 * `e2e:staging` and by a look at the audit log afterwards.
 *
 * Env as smoke:biometric-credo: PLATFORM_API, PLATFORM_API_KEY, PLATFORM_TENANT_ID. Any tenant will
 * do; one that has run face checks (the biometric smoke tenant) makes the numbers non-zero.
 */
import { consoleClient, env, platformClient } from './platform-common.ts'

const api = platformClient(env('PLATFORM_API', 'https://api.12id.naziharitsolution.com'), env('PLATFORM_API_KEY'))
const owner = consoleClient()
const auditor = consoleClient(undefined, 'auditor')

const checks: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const sum = (values: number[]) => values.reduce((total, n) => total + n, 0)

interface Verification {
  days: number
  proofs: { requested: number; verified: number; failed: number; abandoned: number; inFlight: number; series: Array<{ day: string; verified: number; failed: number; abandoned: number; inFlight: number }> }
  faceChecks: { total: number; byStatus: Record<string, number>; series: unknown[]; attempts: { total: number; passed: number; rejected: number }; reasons: Array<{ reason: string; attempts: number }>; scores: { liveness: number[]; match: number[] }; thresholds: { minLivenessScore: number; minMatchScore: number } }
}
interface Page<T> {
  items: T[]
  total: number
}
interface Check {
  id: string
  recordType: string
  recordId: string
  connectionId: string | null
  biometric: { status: string }
}

// --- console only ---------------------------------------------------------------------------
for (const path of ['/v1/stats/verification', '/v1/biometrics/checks']) {
  const byKey = await api.call('GET', path)
  check(`an API key is refused on ${path}`, byKey.status === 403, `${byKey.status}`)
}

// --- the Verification aggregates ------------------------------------------------------------
const stats = await owner.must<Verification>('GET', '/v1/stats/verification?days=30')
const p = stats.proofs
check('the window is 30 days, with every day present in both series', stats.days === 30 && p.series.length === 30 && stats.faceChecks.series.length === 30)
check('proof outcomes add up to the requests', p.requested === p.verified + p.failed + p.abandoned + p.inFlight && p.requested === sum(p.series.map((d) => d.verified + d.failed + d.abandoned + d.inFlight)), `${p.requested} requested, ${p.verified} verified, ${p.failed} failed, ${p.abandoned} abandoned, ${p.inFlight} in flight`)
const f = stats.faceChecks
check('face-check outcomes add up to the checks', f.total === sum(Object.values(f.byStatus)), `${f.total} checks: ${JSON.stringify(f.byStatus)}`)
check('attempts are the passed and the rejected, and every rejection has a reason', f.attempts.total === f.attempts.passed + f.attempts.rejected && f.attempts.rejected === sum(f.reasons.map((r) => r.attempts)), `${f.attempts.total} attempts, ${JSON.stringify(f.reasons)}`)
check('the score distributions have ten buckets and hold no more than the attempts', f.scores.liveness.length === 10 && f.scores.match.length === 10 && sum(f.scores.liveness) <= f.attempts.total, `liveness ${JSON.stringify(f.scores.liveness)}`)
const tooShort = await owner.call('GET', '/v1/stats/verification?days=5')
check('a window outside 7 to 90 days is refused', tooShort.status === 400, `${tooShort.status}`)

const wide = await owner.must<Verification>('GET', '/v1/stats/verification?days=90')
const dashboard = await owner.must<{ verification: { proofsRequested: number; proofsVerified: number; faceChecks: number; faceChecksPassed: number } }>('GET', '/v1/stats?days=90')
check('the dashboard carries the same headline numbers', dashboard.verification.proofsRequested === wide.proofs.requested && dashboard.verification.proofsVerified === wide.proofs.verified && dashboard.verification.faceChecks === wide.faceChecks.total && dashboard.verification.faceChecksPassed === wide.faceChecks.byStatus.passed, JSON.stringify(dashboard.verification))

// --- the face-checks list -------------------------------------------------------------------
const all = await owner.must<Page<Check>>('GET', '/v1/biometrics/checks?pageSize=100')
check('the list holds at least the checks of the last 90 days', all.total >= wide.faceChecks.total, `${all.total} in all, ${wide.faceChecks.total} in 90 days`)
const passed = await owner.must<Page<Check>>('GET', '/v1/biometrics/checks?status=passed&pageSize=100')
check('the outcome filter keeps only that outcome', passed.items.every((item) => item.biometric.status === 'passed') && passed.total <= all.total, `${passed.total} passed`)
const badSize = await owner.call('GET', '/v1/biometrics/checks?pageSize=10')
check('a page size other than 25, 50 or 100 is refused', badSize.status === 400, `${badSize.status}`)

// --- one connection ---------------------------------------------------------------------------
const connections = await owner.must<Page<{ id: string }>>('GET', '/v1/connections?pageSize=25')
// A connection that has a face check, when there is one: its three counts are all worth comparing.
const connectionId = all.items.find((item) => item.connectionId)?.connectionId ?? connections.items[0]?.id
if (connectionId) {
  const activity = await owner.must<{ connection: { id: string }; credentials: { total: number }; proofs: { total: number; verified: number; failed: number }; faceChecks: { total: number }; wallets: unknown[] }>('GET', `/v1/connections/${connectionId}/activity`)
  const [credentials, proofs, connectionChecks] = await Promise.all([
    owner.must<Page<unknown>>('GET', `/v1/credentials?connectionId=${connectionId}`),
    owner.must<Page<unknown>>('GET', `/v1/proofs?connectionId=${connectionId}`),
    owner.must<Page<unknown>>('GET', `/v1/biometrics/checks?connectionId=${connectionId}`),
  ])
  check(
    "a connection's activity matches the lists narrowed to it",
    activity.connection.id === connectionId && activity.credentials.total === credentials.total && activity.proofs.total === proofs.total && activity.faceChecks.total === connectionChecks.total,
    `${activity.credentials.total} credentials, ${activity.proofs.total} proofs (${activity.proofs.verified} verified), ${activity.faceChecks.total} face checks, ${activity.wallets.length} wallets`
  )
  const byKey = await api.call('GET', `/v1/connections/${connectionId}/activity`)
  check('an API key is refused on the activity route', byKey.status === 403, `${byKey.status}`)
} else {
  check('the tenant has a connection to look at', false, 'none')
}
const unknown = await owner.call('GET', '/v1/connections/no-such-connection/activity')
check('an unknown connection is not found', unknown.status === 404, `${unknown.status}`)

// --- the auditor: every read, no change, no reveal ------------------------------------------
const read = await auditor.call<Page<{ theirLabel: string | null }>>('GET', '/v1/connections?pageSize=25')
check('an auditor reads the lists, with holder labels masked', read.status === 200 && read.json.items.every((item) => item.theirLabel === null || /^•+$/.test(item.theirLabel)), `${read.status}`)
const seen = await auditor.call('GET', '/v1/stats/verification')
check('an auditor reads the Verification aggregates', seen.status === 200, `${seen.status}`)
const keysBefore = (await owner.must<Page<unknown>>('GET', '/v1/api-keys')).total
const minted = await auditor.call<{ reason?: string }>('POST', '/v1/api-keys', { label: 'auditor must not be able to create this' })
const keysAfter = (await owner.must<Page<unknown>>('GET', '/v1/api-keys')).total
check('an auditor cannot create an API key', minted.status === 403 && minted.json.reason === 'auditors are read-only' && keysAfter === keysBefore, `${minted.status} ${minted.json.reason}; keys ${keysBefore} -> ${keysAfter}`)
const revealed = await auditor.call<{ reason?: string }>('GET', '/v1/connections?pageSize=25', undefined, { 'x-console-reveal-reason': 'check' })
check('an auditor cannot reveal masked data', revealed.status === 403, `${revealed.status} ${revealed.json.reason}`)

// --- set 2: the audit log's period (C15) ----------------------------------------------------------
interface AuditRetention {
  auditRetentionDays: number
  tenantSetting: number | null
  platformDefault: number
  minimumDays: number
}
const period = await owner.call<AuditRetention>('GET', '/v1/audit-retention')
check('the audit log has a period of its own, a year at least', period.status === 200 && period.json.minimumDays === 365 && (period.json.auditRetentionDays === 0 || period.json.auditRetentionDays >= 365), JSON.stringify(period.json))
const periodByKey = await api.call('GET', '/v1/audit-retention')
check('an API key is refused on the audit log period', periodByKey.status === 403, `${periodByKey.status}`)
const periodByAuditor = await auditor.call('PUT', '/v1/audit-retention', { auditRetentionDays: 365 })
const periodAfter = await owner.must<AuditRetention>('GET', '/v1/audit-retention')
check('an auditor cannot set the period, and nothing changed', periodByAuditor.status === 403 && periodAfter.tenantSetting === period.json.tenantSetting, `${periodByAuditor.status}`)
const dataPeriod = await api.must<Record<string, unknown>>('GET', '/v1/data-retention')
check('the customer route for the data period says nothing about the audit log', !Object.keys(dataPeriod).some((key) => /audit/i.test(key)), Object.keys(dataPeriod).join(', '))

// --- set 2: system health (C16) -------------------------------------------------------------------
interface Health {
  version: string | null
  environment: string | null
  checks: Record<string, boolean>
  monitoring: { connected: boolean; lastSignalAt: string | null; silent: boolean }
  alerts: { firing: Array<{ name: string; severity: string | null }>; resolved: Array<{ name: string }> }
  settings: Array<{ group: string; label: string; value: string }>
}
const operator = consoleClient(undefined, 'operator')
const health = await operator.call<Health>('GET', '/admin/health')
check('an operator reads the system health, with the version it runs', health.status === 200 && Boolean(health.json.version) && Boolean(health.json.environment), `${health.status} ${health.json.version} ${health.json.environment}`)
check('every service platform-api calls is answering', health.status === 200 && Object.keys(health.json.checks).length >= 3 && Object.values(health.json.checks).every(Boolean), JSON.stringify(health.json.checks))
check('monitoring is connected and its heartbeat is fresh', health.status === 200 && health.json.monitoring.connected && !health.json.monitoring.silent && health.json.monitoring.lastSignalAt !== null, JSON.stringify(health.json.monitoring))
check('the heartbeat is not listed as an alert', health.status === 200 && ![...health.json.alerts.firing, ...health.json.alerts.resolved].some((alert) => alert.name === 'Watchdog'), `${health.json.alerts?.firing.length} firing: ${health.json.alerts?.firing.map((alert) => alert.name).join(', ')}`)
// A secret here would be a long random token; the longest honest value is a URL.
const settings = health.json.settings ?? []
check('the settings read as settings, none as a secret', settings.length >= 15 && settings.every((s) => !/[A-Za-z0-9_-]{32,}/.test(s.value) && !/password|token|secret/i.test(s.label)), `${settings.length} settings`)
const healthByAuditor = await auditor.call('GET', '/admin/health')
const healthByOwner = await owner.call('GET', '/admin/health')
check('an auditor reads it too, and an organization owner does not', healthByAuditor.status === 200 && healthByOwner.status === 403, `${healthByAuditor.status}, ${healthByOwner.status}`)
const platformStats = await operator.must<{ health: { alertsFiring: number } }>('GET', '/admin/stats')
check('the dashboard carries the same count of firing alerts', platformStats.health.alertsFiring === health.json.alerts?.firing.length, `${platformStats.health.alertsFiring}`)
// From outside: the edge answers 404 for /internal/* whatever is sent.
const fromOutside = await fetch(`${env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')}/internal/alerts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(64)}` }, body: JSON.stringify({ alerts: [] }) })
check('the alerts webhook is not reachable from the internet', fromOutside.status === 404, `${fromOutside.status}`)

const ok = checks.every(([, passedCheck]) => passedCheck)
console.log(`\n=== console-feedback-check ${ok ? 'PASSED' : 'FAILED'} (${checks.filter(([, passedCheck]) => passedCheck).length}/${checks.length}) ===`)
process.exit(ok ? 0 : 1)
