/**
 * Approval by a second person (implement/22-console-feedback.md C17) against a real Postgres (skipped
 * without one): what is held and what is not, who may decide, what happens when a request is
 * applied, where a secret goes, and what is never stored.
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import { REPLAY_HEADER } from '../src/approvals/gate.ts'
import { REQUEST_TTL_MS, expireDue, purgeClosed } from '../src/approvals/requests.ts'
import { APPROVAL_TYPES } from '../src/approvals/types.ts'
import { API_KEY_PREFIX, generateSecret, hashSecret, lookupPrefix } from '../src/auth/tokens.ts'
import { createGateEngine } from '../src/biometric/gate.ts'
import { apiKeys, changeRequests, consoleAudit, proofTemplates, tenants, webhookEndpoints } from '../src/db/schema.ts'
import { buildApp } from '../src/http/app.ts'
import { endpointLookup } from '../src/webhooks/events.ts'
import { fakeAgent, fakeBiometric, silentLogger, testConfig, testDatabase } from './helpers.ts'

const database = await testDatabase()

describe('approval by a second person', { skip: database ? false : 'no test database' }, () => {
  const db = database!.db
  const agent = fakeAgent()
  const biometric = fakeBiometric()
  const gates = createGateEngine({ db, agent: agent.client, biometric: biometric.client, endpoints: endpointLookup(db), logger: silentLogger })
  const build = (operatorApprovals: 'on' | 'off') =>
    buildApp({
      config: { ...testConfig, OPERATOR_APPROVALS: operatorApprovals },
      db,
      agent: agent.client,
      mediator: { createInvitation: async () => ({ outOfBandId: 'oob-x', invitationUrl: 'https://mediator.test?oob=x' }) },
      logger: silentLogger,
      readiness: async () => ({ ready: true, draining: false, checks: {} }),
      wake: async () => 'requested',
      biometric: { client: biometric.client, gates },
    })
  const app = build('off')
  const strict = build('on')

  const token = testConfig.CONSOLE_TOKEN as string
  let tenantId = ''
  let otherTenantId = ''
  let bearer = ''
  /** A console user of the tenant: `as('owner', 'ada')` is the owner whose account id is `ada`. */
  const as = (role: string, actor: string, tenant = tenantId) => ({ 'x-console-token': token, 'x-console-actor': actor, 'x-console-role': role, 'x-console-tenant': tenant, 'x-console-actor-label': encodeURIComponent(`${actor}@acme.test`) })
  const staff = (actor: string, role = 'operator') => ({ 'x-console-token': token, 'x-console-actor': actor, 'x-console-role': role, 'x-console-actor-label': encodeURIComponent(`${actor}@12id.test`) })
  const apiKey = () => ({ authorization: `Bearer ${bearer}` })

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: object, target = app) => target.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) })
  const decide = (id: string, action: 'approve' | 'reject' | 'cancel' | 'apply', headers: Record<string, string>, payload?: object) => call('POST', `/v1/change-requests/${id}/${action}`, headers, payload)
  const requestRow = async (id: string) => (await db.select().from(changeRequests).where(eq(changeRequests.id, id)))[0]!
  const template = (name: string) => ({ name, groups: [{ key: 'employee', attributes: ['name'], credentials: [{ schemaName: 'employee-badge' }] }] })

  before(async () => {
    await app.ready()
    await strict.ready()
  })

  beforeEach(async () => {
    await testDatabase()
    agent.calls.length = 0
    biometric.calls.length = 0
    const [tenant, other] = await db
      .insert(tenants)
      .values([
        { name: 'Acme', agentTenantId: 'agent-acme', status: 'ready', approvalsRequired: true },
        { name: 'Other', agentTenantId: 'agent-other', status: 'ready', approvalsRequired: true },
      ])
      .returning()
    tenantId = tenant!.id
    otherTenantId = other!.id
    bearer = generateSecret(API_KEY_PREFIX)
    await db.insert(apiKeys).values({ tenantId, prefix: lookupPrefix(bearer), keyHash: hashSecret(bearer), label: 'backend' })
  })

  it('off: every change is made directly; on: switched on at once, with the list of what is held', async () => {
    await db.update(tenants).set({ approvalsRequired: false }).where(eq(tenants.id, tenantId))
    const setting = await call('GET', '/v1/approvals', as('owner', 'ada'))
    assert.equal(setting.json().required, false)
    assert.ok(setting.json().types.some((t: { id: string; apply: string }) => t.id === 'api_key.create' && t.apply === 'by_requester'))
    assert.ok(!setting.json().types.some((t: { id: string }) => t.id.startsWith('operator.')), 'operator accounts are not an organisation matter')

    const direct = await call('PUT', '/v1/webhook', as('owner', 'ada'), { url: 'https://hooks.acme.test/12id' })
    assert.equal(direct.statusCode, 200)
    assert.match(direct.json().secret, /^whsec_/)
    assert.equal((await db.select().from(changeRequests)).length, 0)

    assert.equal((await call('PUT', '/v1/approvals', as('member', 'mia'), { required: true })).statusCode, 403)
    assert.equal((await call('GET', '/v1/approvals', apiKey())).statusCode, 403)
    const on = await call('PUT', '/v1/approvals', as('owner', 'ada'), { required: true })
    assert.equal(on.statusCode, 200)
    assert.equal(on.json().required, true)
    assert.equal((await call('PUT', '/v1/webhook', as('owner', 'ada'), { url: 'https://elsewhere.test/hook' })).statusCode, 202)
  })

  it('holds a change, shows it to the others, and lets neither the asker nor an unfit role decide', async () => {
    const held = await call('PUT', '/v1/webhook', as('owner', 'ada'), { url: 'https://hooks.acme.test/12id', events: ['proof.state_changed'] })
    assert.equal(held.statusCode, 202)
    const request = held.json().approval
    assert.equal(request.status, 'pending')
    assert.equal(request.type, 'webhook.set')
    assert.equal(request.label, 'Set the webhook endpoint')
    assert.equal(request.summary, 'Send events to https://hooks.acme.test/12id')
    assert.equal(request.apply, 'by_requester')
    assert.deepEqual(request.roles, ['owner', 'admin'])
    assert.deepEqual(request.change, { url: 'https://hooks.acme.test/12id', events: ['proof.state_changed'] })
    assert.equal(request.before, null)
    assert.equal(request.requestedByLabel, 'ada@acme.test')
    assert.equal((await db.select().from(webhookEndpoints)).length, 0, 'the change was not made')

    // The audit has the held call, with the request it became.
    const [audited] = await db.select().from(consoleAudit).where(eq(consoleAudit.route, '/v1/webhook'))
    assert.equal(audited!.statusCode, 202)
    assert.deepEqual((audited!.changes as { approval: unknown }).approval, { request: request.id, waiting: true })

    const list = await call('GET', '/v1/change-requests?status=pending', as('member', 'mia'))
    assert.deepEqual(list.json().items.map((item: { id: string }) => item.id), [request.id])
    assert.equal((await call('GET', '/v1/change-requests?status=nonsense', as('owner', 'ada'))).statusCode, 400)
    assert.equal((await call('GET', '/v1/change-requests', apiKey())).statusCode, 403)

    const same = await decide(request.id, 'approve', as('owner', 'ada'))
    assert.deepEqual([same.statusCode, same.json().error], [403, 'same_person'])
    assert.equal((await decide(request.id, 'approve', as('member', 'mia'))).statusCode, 403)
    assert.equal((await decide(request.id, 'approve', as('auditor', 'aud'))).statusCode, 403)
    // An operator cannot change a tenant's webhook in the console, so it cannot approve that change either.
    assert.equal((await decide(request.id, 'approve', as('operator', 'ops'))).statusCode, 403)
    // Another tenant does not see it at all.
    assert.equal((await call('GET', `/v1/change-requests/${request.id}`, as('owner', 'eve', otherTenantId))).statusCode, 404)
    assert.equal((await decide(request.id, 'approve', as('owner', 'eve', otherTenantId))).statusCode, 404)
    assert.equal((await requestRow(request.id)).status, 'pending')
  })

  it('one open request per thing; any number for things that are new each time', async () => {
    const first = await call('PUT', '/v1/webhook', as('owner', 'ada'), { url: 'https://one.test/hook' })
    const second = await call('PUT', '/v1/webhook', as('admin', 'bob'), { url: 'https://two.test/hook' })
    assert.equal(second.statusCode, 409)
    assert.equal(second.json().error, 'approval_pending')
    assert.match(second.json().reason, /asked by ada@acme\.test/)
    // Removing the endpoint is about the same thing; rotating its secret is not.
    assert.equal((await call('DELETE', '/v1/webhook', as('admin', 'bob'))).statusCode, 409)
    assert.equal((await call('POST', '/v1/webhook/rotate-secret', as('admin', 'bob'))).statusCode, 202)

    // Two new API keys and two new templates wait side by side.
    for (const label of ['backend-a', 'backend-b']) assert.equal((await call('POST', '/v1/api-keys', as('admin', 'bob'), { label })).statusCode, 202)
    for (const name of ['kyc', 'transfer']) assert.equal((await call('POST', '/v1/proof-templates', as('admin', 'bob'), template(name))).statusCode, 202)

    // Once the first is closed, the thing is free again.
    assert.equal((await decide(first.json().approval.id, 'cancel', as('owner', 'ada'))).json().status, 'cancelled')
    assert.equal((await call('PUT', '/v1/webhook', as('admin', 'bob'), { url: 'https://two.test/hook' })).statusCode, 202)
    assert.equal((await call('GET', '/v1/change-requests?status=pending', as('owner', 'ada'))).json().total, 6)
  })

  it('an approved change takes effect at once, as the person who asked, and the audit names both', async () => {
    await db.update(tenants).set({ retentionDays: 60 }).where(eq(tenants.id, tenantId))
    const held = await call('PUT', '/v1/data-retention', as('admin', 'bob'), { retentionDays: 30 })
    assert.equal(held.statusCode, 202)
    assert.deepEqual(held.json().approval.before, { retentionDays: 60 })
    assert.equal(held.json().approval.summary, 'Keep personal data of finished exchanges for 30 days')
    assert.equal((await db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]!.retentionDays, 60)

    // An operator may set a tenant's period in the console, so an operator may approve this one.
    const approved = await decide(held.json().approval.id, 'approve', as('operator', 'ops'))
    assert.equal(approved.statusCode, 200)
    assert.equal(approved.json().status, 'applied')
    assert.equal(approved.json().decidedByLabel, 'ops@acme.test')
    assert.ok(approved.json().appliedAt)
    assert.equal((await db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]!.retentionDays, 30)

    const rows = (await db.select().from(consoleAudit).where(eq(consoleAudit.route, '/v1/data-retention'))).sort((a, b) => a.id - b.id)
    assert.deepEqual(rows.map((row) => [row.statusCode, row.actor]), [[202, 'bob'], [200, 'bob']])
    assert.deepEqual((rows[1]!.changes as { approval: unknown; body: unknown }).approval, { request: held.json().approval.id, approvedBy: 'ops@acme.test' })
    assert.deepEqual((rows[1]!.changes as { body: unknown }).body, { retentionDays: 30 })
    // The audit log's "approval" kind holds the whole story and nothing else.
    await call('GET', '/v1/data-retention', as('owner', 'ada'))
    await call('DELETE', `/v1/api-keys/${(await db.select().from(apiKeys))[0]!.id}`, as('owner', 'ada'))
    const story = (await call('GET', '/admin/audit?kind=approval', staff('op_a'))).json()
    assert.deepEqual(story.items.map((item: { route: string; statusCode: number }) => `${item.route} ${item.statusCode}`).sort(), ['/v1/change-requests/:id/approve 200', '/v1/data-retention 200', '/v1/data-retention 202'])

    // Decided requests cannot be decided again.
    assert.equal((await decide(held.json().approval.id, 'approve', as('owner', 'ada'))).statusCode, 409)
    assert.equal((await decide(held.json().approval.id, 'cancel', as('admin', 'bob'))).statusCode, 409)
  })

  it('a secret goes to the person who asked, once, and is stored nowhere', async () => {
    const held = await call('POST', '/v1/api-keys', as('admin', 'bob'), { label: 'reporting' })
    const id = held.json().approval.id
    const approved = await decide(id, 'approve', as('owner', 'ada'))
    assert.equal(approved.json().status, 'approved', 'it waits for the person who asked')
    assert.equal((await db.select().from(apiKeys)).length, 1, 'no key yet')

    // Not the approver, not a third person.
    assert.equal((await decide(id, 'apply', as('owner', 'ada'))).statusCode, 403)
    assert.equal((await decide(id, 'apply', as('admin', 'cat'))).statusCode, 403)

    // Two clicks at once make one key.
    const [one, two] = await Promise.all([decide(id, 'apply', as('admin', 'bob')), decide(id, 'apply', as('admin', 'bob'))])
    const done = [one, two].filter((response) => response.statusCode === 200)
    assert.equal(done.length, 1)
    assert.equal([one, two].filter((response) => response.statusCode === 409).length, 1)
    const applied = done[0]!.json()
    assert.equal(applied.request.status, 'applied')
    assert.equal(applied.result.statusCode, 201)
    assert.match(applied.result.body.apiKey, /^12id_sk_/)
    const keys = await db.select().from(apiKeys)
    assert.equal(keys.length, 2)
    assert.equal(keys.find((key) => key.label === 'reporting')!.createdBy, 'bob')

    const secret = applied.result.body.apiKey as string
    assert.ok(!JSON.stringify(await requestRow(id)).includes(secret), 'the key is not in the request')
    assert.ok(!JSON.stringify(await db.select().from(consoleAudit)).includes(secret), 'the key is not in the audit')
    assert.equal((await decide(id, 'apply', as('admin', 'bob'))).statusCode, 409)
  })

  it('a new webhook endpoint hands its signing secret to the person who asked', async () => {
    const held = await call('PUT', '/v1/webhook', as('owner', 'ada'), { url: 'https://hooks.acme.test/12id' })
    await decide(held.json().approval.id, 'approve', as('admin', 'bob'))
    assert.equal((await db.select().from(webhookEndpoints)).length, 0)
    const applied = await decide(held.json().approval.id, 'apply', as('owner', 'ada'))
    assert.match(applied.json().result.body.secret, /^whsec_/)
    assert.equal((await db.select().from(webhookEndpoints))[0]!.url, 'https://hooks.acme.test/12id')

    // Removing it takes effect on approval, and the request shows what was in force.
    const removal = await call('DELETE', '/v1/webhook', as('admin', 'bob'))
    assert.deepEqual(removal.json().approval.before, { url: 'https://hooks.acme.test/12id', events: null })
    assert.equal((await decide(removal.json().approval.id, 'approve', as('owner', 'ada'))).json().status, 'applied')
    assert.equal((await db.select().from(webhookEndpoints)).length, 0)
  })

  it('rejecting needs a reason; cancelling is for the person who asked', async () => {
    const held = await call('PUT', '/v1/audit-retention', as('owner', 'ada'), { auditRetentionDays: 365 })
    const id = held.json().approval.id
    assert.equal((await decide(id, 'reject', as('admin', 'bob'), { reason: '' })).statusCode, 400)
    assert.equal((await decide(id, 'reject', as('owner', 'ada'), { reason: 'changed my mind' })).statusCode, 403)
    assert.equal((await decide(id, 'cancel', as('admin', 'bob'))).statusCode, 403)
    const rejected = await decide(id, 'reject', as('admin', 'bob'), { reason: 'Legal wants two years.' })
    assert.deepEqual([rejected.json().status, rejected.json().decisionReason], ['rejected', 'Legal wants two years.'])
    assert.equal((await db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]!.auditRetentionDays, null)
    // The thing is free again.
    assert.equal((await call('PUT', '/v1/audit-retention', as('owner', 'ada'), { auditRetentionDays: 730 })).statusCode, 202)
  })

  it('a request expires, and the change is checked again when it is applied', async () => {
    const stale = await call('PUT', '/v1/data-retention', as('admin', 'bob'), { retentionDays: 10 })
    await db.update(changeRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(changeRequests.id, stale.json().approval.id))
    assert.equal((await call('GET', `/v1/change-requests/${stale.json().approval.id}`, as('owner', 'ada'))).json().status, 'expired')
    assert.equal((await decide(stale.json().approval.id, 'approve', as('owner', 'ada'))).statusCode, 409)
    // An expired request no longer holds its subject.
    assert.equal((await call('PUT', '/v1/data-retention', as('admin', 'bob'), { retentionDays: 20 })).statusCode, 202)

    // A template is changed, then deleted before the change is approved: the approval cannot make it.
    const [row] = await db.insert(proofTemplates).values({ tenantId, name: 'kyc', definition: template('kyc') }).returning()
    const change = await call('PUT', `/v1/proof-templates/${row!.id}`, as('admin', 'bob'), template('kyc v2'))
    assert.equal(change.statusCode, 202)
    assert.equal(change.json().approval.before.name, 'kyc')
    await db.delete(proofTemplates).where(eq(proofTemplates.id, row!.id))
    const failed = await decide(change.json().approval.id, 'approve', as('owner', 'ada'))
    assert.equal(failed.statusCode, 200)
    assert.deepEqual([failed.json().status, failed.json().applyError], ['failed', 'proof template not found'])

    // The sweep closes what nobody opens, and old closed requests go with the audit period.
    await db.update(changeRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(changeRequests.status, 'pending'))
    assert.equal((await expireDue(db)).length, 1)
    assert.equal(await purgeClosed(db, new Date(Date.now() - REQUEST_TTL_MS)), 0)
    assert.equal(await purgeClosed(db, new Date(Date.now() + 1000)), 3)
    assert.equal((await db.select().from(changeRequests)).length, 0)
  })

  it('creating, changing and deleting a proof template are held; what closes access is not', async () => {
    assert.equal((await call('POST', '/v1/proof-templates', as('admin', 'bob'), template('kyc'))).statusCode, 202)
    const [row] = await db.insert(proofTemplates).values({ tenantId, name: 'transfer', definition: template('transfer') }).returning()
    assert.equal((await call('PUT', `/v1/proof-templates/${row!.id}/biometric-policy`, as('admin', 'bob'), { mode: 'off' })).statusCode, 202)
    // The same template: its change and its deletion are about one thing.
    assert.equal((await call('DELETE', `/v1/proof-templates/${row!.id}`, as('admin', 'bob'))).statusCode, 409)
    assert.equal((await call('POST', '/v1/schemas', as('owner', 'ada'), { name: 'badge', version: '1.0', attributes: ['name', 'expiresOn'] })).statusCode, 202)
    assert.equal(agent.calls.filter((c) => c.method === 'publishSchema').length, 0, 'nothing was written to the ledger')

    // The operators' own key route is the break-glass path: the console is sent to the held one.
    const viaConsole = await call('POST', `/admin/tenants/${tenantId}/api-keys`, staff('op_a'), { label: 'ops' })
    assert.deepEqual([viaConsole.statusCode, viaConsole.json().error], [403, 'approval_required'])
    assert.equal((await call('POST', `/admin/tenants/${tenantId}/api-keys`, { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN }, { label: 'break-glass' })).statusCode, 201)
    assert.equal((await call('POST', `/admin/tenants/${otherTenantId}/api-keys`, { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN }, { label: 'other' })).statusCode, 201)

    // Revoking a key never waits.
    const spare = generateSecret(API_KEY_PREFIX)
    const [key] = await db.insert(apiKeys).values({ tenantId, prefix: lookupPrefix(spare), keyHash: hashSecret(spare), label: 'spare' }).returning()
    const revoked = await call('DELETE', `/v1/api-keys/${key!.id}`, as('admin', 'bob'))
    assert.equal(revoked.statusCode, 200)
    assert.ok(revoked.json().revokedAt)
    // A member is refused before anything is stored.
    const before = (await db.select().from(changeRequests)).length
    assert.equal((await call('PUT', '/v1/webhook', as('member', 'mia'), { url: 'https://x.test/h' })).statusCode, 403)
    assert.equal((await db.select().from(changeRequests)).length, before)
    // An API key gets what it always got from a console-only route.
    assert.equal((await call('PUT', '/v1/webhook', apiKey(), { url: 'https://x.test/h' })).statusCode, 403)
  })

  it('switching approval off is itself held', async () => {
    const held = await call('PUT', '/v1/approvals', as('owner', 'ada'), { required: false })
    assert.equal(held.statusCode, 202)
    assert.equal(held.json().approval.type, 'approvals.disable')
    assert.equal((await call('GET', '/v1/approvals', as('owner', 'ada'))).json().required, true)
    assert.equal((await call('PUT', '/v1/data-retention', as('owner', 'ada'), { retentionDays: 5 })).statusCode, 202)
    // Switching on again while on is not a request.
    assert.equal((await call('PUT', '/v1/approvals', as('owner', 'ada'), { required: true })).statusCode, 200)

    assert.equal((await decide(held.json().approval.id, 'approve', as('admin', 'bob'))).json().status, 'applied')
    assert.equal((await call('GET', '/v1/approvals', as('owner', 'ada'))).json().required, false)
    assert.equal((await call('PUT', '/v1/audit-retention', as('owner', 'ada'), { auditRetentionDays: 365 })).statusCode, 200)
  })

  it('a biometric provider waits in biometric-service; its configuration is never stored here', async () => {
    const config = { region: 'eu-central-1', roleArn: 'arn:aws:iam::1:role/x', apiSecret: 'VENDOR-SECRET-VALUE-0123456789' }
    const held = await call('PUT', '/v1/biometrics/provider', as('admin', 'bob'), { providerId: 'aws-rekognition', config })
    assert.equal(held.statusCode, 202)
    const request = held.json().approval
    assert.deepEqual(request.change, { providerId: 'aws-rekognition', publicConfig: { region: 'eu-central-1' } })
    assert.deepEqual(request.before, { providerId: 'mock', publicConfig: {} })
    assert.deepEqual(biometric.calls.map((c) => c.method), ['putPendingProvider'])
    assert.ok(!JSON.stringify(await db.select().from(changeRequests)).includes('VENDOR-SECRET'), 'the configuration is not in the request')
    assert.ok(!JSON.stringify(await db.select().from(consoleAudit)).includes('VENDOR-SECRET'), 'nor in the audit')

    // The route that activates it answers only to an approval.
    assert.equal((await call('POST', '/v1/biometrics/provider/pending/activate', as('owner', 'ada'))).statusCode, 403)
    const forged = await app.inject({ method: 'POST', url: '/v1/biometrics/provider/pending/activate', headers: { ...as('owner', 'ada'), [REPLAY_HEADER]: `${request.id}:${'0'.repeat(64)}` } })
    assert.equal(forged.statusCode, 403)
    assert.ok(!biometric.calls.some((c) => c.method === 'activatePendingProvider'))

    assert.equal((await decide(request.id, 'approve', as('owner', 'ada'))).json().status, 'applied')
    assert.deepEqual(biometric.calls.map((c) => c.method), ['putPendingProvider', 'activatePendingProvider'])

    // Rejected: what waited is dropped. Refused by biometric-service: no request is left behind.
    const again = await call('PUT', '/v1/biometrics/provider', as('admin', 'bob'), { providerId: 'aws-rekognition', config })
    await decide(again.json().approval.id, 'reject', as('owner', 'ada'), { reason: 'Wrong account.' })
    assert.equal(biometric.calls.at(-1)!.method, 'deletePendingProvider')
    const refused = await call('PUT', '/v1/biometrics/provider', as('admin', 'bob'), { providerId: 'unknown', config: {} })
    assert.equal(refused.statusCode, 400)
    assert.equal((await db.select().from(changeRequests).where(eq(changeRequests.status, 'pending'))).length, 0)
    // Without approval the configuration goes straight in, as before.
    await db.update(tenants).set({ approvalsRequired: false }).where(eq(tenants.id, tenantId))
    assert.equal((await call('PUT', '/v1/biometrics/provider', as('admin', 'bob'), { providerId: 'mock', config: {} })).statusCode, 200)
    assert.equal(biometric.calls.at(-1)!.method, 'putProvider')
    assert.equal((await call('POST', '/v1/biometrics/provider/pending/activate', as('owner', 'ada'))).statusCode, 403)
  })

  it('an account action the console performs: asked here, approved by another, applied by the asker', async () => {
    const payload = { email: 'New.Person@acme.test', role: 'admin', organizationId: 'org_1' }
    assert.equal((await call('POST', '/v1/change-requests', as('owner', 'ada'), { type: 'operator.invite', payload })).statusCode, 400)
    assert.equal((await call('POST', '/v1/change-requests', as('member', 'mia'), { type: 'member.invite', payload })).statusCode, 403)
    const asked = await call('POST', '/v1/change-requests', as('owner', 'ada'), { type: 'member.invite', payload })
    assert.equal(asked.statusCode, 201)
    assert.equal(asked.json().summary, 'Invite New.Person@acme.test as admin')
    assert.deepEqual([asked.json().executor, asked.json().apply], ['console', 'by_requester'])
    // The same person, whatever the capitals: one open request.
    assert.equal((await call('POST', '/v1/change-requests', as('owner', 'ada'), { type: 'member.invite', payload: { ...payload, email: 'new.person@acme.test' } })).statusCode, 409)

    const id = asked.json().id
    assert.equal((await decide(id, 'apply', as('owner', 'ada'))).statusCode, 409, 'not before it is approved')
    assert.equal((await decide(id, 'approve', as('admin', 'bob'))).json().status, 'approved')
    const applied = await decide(id, 'apply', as('owner', 'ada'))
    assert.deepEqual(applied.json().payload, payload)
    assert.equal(applied.json().result, null)
    assert.equal((await call('POST', `/v1/change-requests/${id}/applied`, as('admin', 'bob'), { ok: true })).statusCode, 403)
    const reported = await call('POST', `/v1/change-requests/${id}/applied`, as('owner', 'ada'), { ok: true })
    assert.equal(reported.json().status, 'applied')

    // The console could not do it: the request says why.
    const second = await call('POST', '/v1/change-requests', as('owner', 'ada'), { type: 'member.role', payload: { memberId: 'm_1', account: 'bob@acme.test', role: 'owner' } })
    await decide(second.json().id, 'approve', as('admin', 'bob'))
    await decide(second.json().id, 'apply', as('owner', 'ada'))
    const failed = await call('POST', `/v1/change-requests/${second.json().id}/applied`, as('owner', 'ada'), { ok: false, error: 'the member left the organization' })
    assert.deepEqual([failed.json().status, failed.json().applyError], ['failed', 'the member left the organization'])

    // Where approval is off, the console makes the change itself.
    await db.update(tenants).set({ approvalsRequired: false }).where(eq(tenants.id, tenantId))
    const off = await call('POST', '/v1/change-requests', as('owner', 'ada'), { type: 'member.invite', payload })
    assert.deepEqual([off.statusCode, off.json().error], [409, 'approvals_off'])
  })

  it('operator accounts: a second operator, when the deployment asks for one', async () => {
    const payload = { email: 'new.op@12id.test', name: 'New Operator', role: 'operator' }
    const off = await call('POST', '/admin/change-requests', staff('op_a'), { type: 'operator.invite', payload })
    assert.deepEqual([off.statusCode, off.json().error], [409, 'approvals_off'])
    assert.equal((await call('GET', '/admin/approvals', staff('op_a'))).json().required, false)

    const setting = await call('GET', '/admin/approvals', staff('op_a'), undefined, strict)
    assert.equal(setting.json().required, true)
    assert.deepEqual(setting.json().types.map((t: { id: string }) => t.id).sort(), ['operator.invite', 'operator.role', 'operator.unban'])
    assert.equal((await call('POST', '/admin/change-requests', staff('op_a'), { type: 'member.invite', payload }, strict)).statusCode, 400)
    const asked = await call('POST', '/admin/change-requests', staff('op_a'), { type: 'operator.invite', payload }, strict)
    assert.equal(asked.statusCode, 201)
    assert.equal(asked.json().tenantId, null)
    const id = asked.json().id
    const op = (action: string, headers: Record<string, string>, body?: object) => call('POST', `/admin/change-requests/${id}/${action}`, headers, body, strict)

    assert.equal((await op('approve', staff('op_a'))).statusCode, 403)
    assert.equal((await op('approve', staff('aud', 'auditor'))).statusCode, 403)
    assert.equal((await op('approve', as('owner', 'ada'))).statusCode, 403)
    // The break-glass token reads and decides nothing: it is nobody in particular.
    const breakGlass = { 'x-admin-token': testConfig.PLATFORM_ADMIN_TOKEN }
    assert.equal((await call('GET', '/admin/change-requests', breakGlass, undefined, strict)).json().total, 1)
    assert.equal((await op('approve', breakGlass)).statusCode, 403)
    // A tenant's list does not hold it.
    assert.equal((await call('GET', `/v1/change-requests/${id}`, as('owner', 'ada'))).statusCode, 404)
    assert.equal((await call('GET', '/v1/change-requests', as('owner', 'ada'))).json().total, 0)

    assert.equal((await op('approve', staff('op_b'))).json().status, 'approved')
    assert.deepEqual((await op('apply', staff('op_a'))).json().payload, payload)
    assert.equal((await op('applied', staff('op_a'), { ok: true })).json().status, 'applied')
    // An auditor reads the list.
    assert.equal((await call('GET', '/admin/change-requests?status=applied', staff('aud', 'auditor'), undefined, strict)).json().total, 1)
  })

  it('every held kind of change has a route, or is one the console performs', () => {
    const routes = app.printRoutes({ commonPrefix: false })
    assert.ok(routes.includes('change-requests'))
    for (const [id, type] of Object.entries(APPROVAL_TYPES)) {
      assert.ok(type.label.length > 0 && type.roles.length > 0, id)
      // Whoever may decide a console action must be able to see it: organisation types never list only operators.
      if (type.executor === 'console' && id.startsWith('member.')) assert.ok((type.roles as readonly string[]).includes('owner'), id)
    }
  })
})
