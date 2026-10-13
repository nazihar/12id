/**
 * Approval by a second person (implement/22-console-feedback.md C17) on a deployed platform-api: one
 * tenant is switched to "a second person is required", two console users ask and decide a few
 * changes, and the tenant is put back as it was (requirement off, retention period as before).
 *
 * It writes: four change requests and their audit rows stay on the tenant. No exchange is made, so it
 * needs no webhook receiver and no holder. Use a smoke tenant: while the check runs, that tenant's
 * console changes are held, and a check that dies in the middle leaves the requirement on until it is
 * run again (it starts by clearing what it left).
 *
 * Env as smoke:biometric-credo: PLATFORM_API, PLATFORM_API_KEY, PLATFORM_TENANT_ID.
 */
import { consoleClient, env, platformClient } from './platform-common.ts'

const api = platformClient(env('PLATFORM_API', 'https://api.12id.naziharitsolution.com'), env('PLATFORM_API_KEY'))
/** Two people of the organization and an auditor; the role and the account id travel as console headers. */
const person = (role: string, actor: string) => {
  const client = consoleClient(undefined, role)
  const who = { 'x-console-actor': actor, 'x-console-actor-label': encodeURIComponent(`${actor}@smoke.12id.test`) }
  return <T>(method: string, path: string, body?: unknown) => client.call<T>(method, path, body, who)
}
const ada = person('owner', 'smoke-approvals-ada')
const bob = person('admin', 'smoke-approvals-bob')
const auditor = person('auditor', 'smoke-approvals-auditor')
const operator = consoleClient(undefined, 'operator')

const checks: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok])
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

interface Request {
  id: string
  type: string
  status: string
  summary: string
  apply: string
  before: unknown
  applyError: string | null
  decisionReason: string | null
}
interface Held {
  approval: Request
}
interface Retention {
  retentionDays: number
  tenantSetting: number | null
}

/** Asks as Ada, approves as Bob. Used for the steps that put the tenant back. */
async function askAndApprove(method: string, path: string, body: unknown): Promise<Request | null> {
  const held = await ada<Held>(method, path, body)
  if (held.status !== 202) return null
  return (await bob<Request>('POST', `/v1/change-requests/${held.json.approval.id}/approve`)).json
}

// --- start clean: a run that died may have left the requirement on, with requests open ------------
const startedRequired = (await ada<{ required: boolean }>('GET', '/v1/approvals')).json.required
if (startedRequired) {
  const open = (await ada<{ items: Request[] }>('GET', '/v1/change-requests?status=pending&status=approved&pageSize=100')).json.items
  for (const request of open) {
    // Each person cancels their own; the other's cancel is refused and changes nothing.
    await ada('POST', `/v1/change-requests/${request.id}/cancel`)
    await bob('POST', `/v1/change-requests/${request.id}/cancel`)
  }
  console.log(`  note: the requirement was on when the check started; ${open.length} open request(s) cancelled`)
}
const original = (await ada<Retention>('GET', '/v1/data-retention')).json
const proposed = original.tenantSetting === 61 ? 62 : 61
const keysBefore = (await ada<{ total: number }>('GET', '/v1/api-keys')).json.total

try {
  // --- switching on takes effect at once ----------------------------------------------------------
  if (!startedRequired) {
    const on = await ada<{ required: boolean }>('PUT', '/v1/approvals', { required: true })
    check('the requirement is switched on at once', on.status === 200 && on.json.required === true, `${on.status}`)
  }
  const setting = await bob<{ required: boolean; types: Array<{ id: string }> }>('GET', '/v1/approvals')
  check('the setting lists what is held, and nothing about operator accounts', setting.json.required && setting.json.types.some((t) => t.id === 'webhook.set') && !setting.json.types.some((t) => t.id.startsWith('operator.')), `${setting.json.types?.length} kinds`)
  const byKey = await api.call('GET', '/v1/change-requests')
  check('an API key is refused on the requests', byKey.status === 403, `${byKey.status}`)

  // --- a held change: not made, shown with what is in force, decided by another -------------------
  const held = await ada<Held>('PUT', '/v1/data-retention', { retentionDays: proposed })
  const request = held.json.approval
  check('a change of the retention period is held', held.status === 202 && request?.status === 'pending' && request.type === 'retention.data', `${held.status} ${request?.summary}`)
  const unchanged = (await ada<Retention>('GET', '/v1/data-retention')).json
  check('nothing changed yet, and the request shows the value in force', unchanged.tenantSetting === original.tenantSetting && JSON.stringify(request?.before) === JSON.stringify({ retentionDays: original.tenantSetting }), JSON.stringify(request?.before))
  const again = await bob<{ error: string }>('PUT', '/v1/data-retention', { retentionDays: 5 })
  check('a second request for the same thing is refused', again.status === 409 && again.json.error === 'approval_pending', `${again.status} ${again.json.error}`)

  const own = await ada<{ error: string }>('POST', `/v1/change-requests/${request.id}/approve`)
  check('the person who asked cannot approve', own.status === 403 && own.json.error === 'same_person', `${own.status} ${own.json.error}`)
  const read = await auditor<{ total: number }>('GET', '/v1/change-requests?status=pending')
  const byAuditor = await auditor('POST', `/v1/change-requests/${request.id}/approve`)
  check('an auditor reads the requests and decides nothing', read.status === 200 && read.json.total >= 1 && byAuditor.status === 403, `${read.status}, ${byAuditor.status}`)

  const approved = await bob<Request>('POST', `/v1/change-requests/${request.id}/approve`)
  const after = (await ada<Retention>('GET', '/v1/data-retention')).json
  check('approved by another person, it takes effect at once', approved.status === 200 && approved.json.status === 'applied' && after.tenantSetting === proposed, `${approved.json.status}, now ${after.tenantSetting}`)

  // --- a new API key: rejected with a reason, and no key exists -------------------------------------
  const key = await ada<Held>('POST', '/v1/api-keys', { label: `approvals-check-${Date.now()}` })
  check('a new API key is held, to be applied by the person who asked', key.status === 202 && key.json.approval.apply === 'by_requester', `${key.status}`)
  const noReason = await bob('POST', `/v1/change-requests/${key.json.approval.id}/reject`, { reason: '' })
  const rejected = await bob<Request>('POST', `/v1/change-requests/${key.json.approval.id}/reject`, { reason: 'Rejected by the approvals check.' })
  const keysAfter = (await ada<{ total: number }>('GET', '/v1/api-keys')).json.total
  check('rejecting needs a reason, and a rejected key was never made', noReason.status === 400 && rejected.json.status === 'rejected' && keysAfter === keysBefore, `${noReason.status}, ${rejected.json.status}, keys ${keysBefore} -> ${keysAfter}`)
  // Revoking never waits; there is nothing to revoke here, so the route is only asked for a key that does not exist.
  const revoke = await ada('DELETE', '/v1/api-keys/00000000-0000-4000-8000-000000000000')
  check('revoking a key is not held', revoke.status === 404, `${revoke.status}`)

  // --- the audit log tells it ----------------------------------------------------------------------
  const audit = await operator.call<{ items: Array<{ route: string; statusCode: number; actorLabel: string | null; changes: { approval?: { approvedBy?: string } } | null }> }>('GET', `/admin/audit?kind=approval&tenantId=${env('PLATFORM_TENANT_ID')}&pageSize=100`)
  const made = audit.json.items?.find((entry) => entry.route === '/v1/data-retention' && entry.statusCode === 200 && entry.changes?.approval?.approvedBy)
  check('the audit names who asked and who approved', audit.status === 200 && made?.actorLabel === 'smoke-approvals-ada@smoke.12id.test' && made.changes?.approval?.approvedBy === 'smoke-approvals-bob@smoke.12id.test', `${made?.actorLabel} / ${made?.changes?.approval?.approvedBy}`)
} finally {
  // --- put the tenant back: the period, then the requirement (switching off is itself held) -------
  const restored = await askAndApprove('PUT', '/v1/data-retention', { retentionDays: original.tenantSetting })
  const period = (await ada<Retention>('GET', '/v1/data-retention')).json
  check('the retention period is back as it was', period.tenantSetting === original.tenantSetting, `${restored?.status ?? 'not held'}, now ${period.tenantSetting}`)
  const off = await ada<Held>('PUT', '/v1/approvals', { required: false })
  check('switching the requirement off is itself held', off.status === 202 && off.json.approval?.type === 'approvals.disable', `${off.status}`)
  if (off.status === 202) await bob('POST', `/v1/change-requests/${off.json.approval.id}/approve`)
  const end = (await ada<{ required: boolean }>('GET', '/v1/approvals')).json
  const direct = await ada('GET', '/v1/change-requests?status=pending&status=approved')
  check('the tenant is as it was: no requirement, nothing open', end.required === false && (direct.json as { total: number }).total === 0, `required ${end.required}`)
}

const ok = checks.every(([, passed]) => passed)
console.log(`\n=== approvals-check ${ok ? 'PASSED' : 'FAILED'} (${checks.filter(([, passed]) => passed).length}/${checks.length}) ===`)
process.exit(ok ? 0 : 1)
