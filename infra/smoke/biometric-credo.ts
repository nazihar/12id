/**
 * smoke:biometric-credo (Phase 6, implement/15-phase-6-biometric.md T). The biometric gate end to
 * end on staging with the `mock` provider: a Credo holder with manual accept stands in for the SDK
 * and drives the wallet routes (requirements, session start, complete) with its wallet token.
 *
 * Before running, on the VM:  infra/smoke/biometric-setup.sh <tenant-uuid> mock
 *
 *   1. pass before hold: check passes, then the holder accepts → issued
 *   2. hold before pass: the holder accepts first → NOT issued while held → check passes → issued
 *   3. three failed matches → locked → the exchange is abandoned
 *   4. gated proof: the holder presents before passing → verified/disclosed withheld → pass → released
 *   5. every biometric log has the expected sequence; biometric.check_completed webhooks arrive signed
 *
 * Env as smoke:platform-credo: PLATFORM_API, PLATFORM_API_KEY, PLATFORM_TENANT_ID, WEBHOOK_URL, RECEIVER_PORT.
 */
import './bindings.ts'

import { DidCommCredentialState, DidCommProofState } from '@credo-ts/didcomm'

import { createHolderAgent, withTimeout } from './common.ts'
import { consoleClient, env, now, offerAttributes, platformClient, publishCatalogue, sleep, startReceiver } from './platform-common.ts'

const baseUrl = env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')
const api = platformClient(baseUrl, env('PLATFORM_API_KEY'))
// Setup routes are console only (review K1): publishing, templates, policies, the webhook endpoint.
const setup = consoleClient()
const webhookUrl = env('WEBHOOK_URL', 'https://smoke-issuer.12id.naziharitsolution.com/webhook')
const runId = `bio-${Date.now()}`
// The mock provider never looks inside the image; it must only be a JPEG.
const referenceImage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 7)]).toString('base64')

type Holder = Awaited<ReturnType<typeof createHolderAgent>>
type Log = { biometric: { status: string } | null; events: Array<{ type: string; decision: string | null; matchScore: number | null }> }

let passed = false
let secret = ''
const checks: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok, detail])
  console.log(`  [${now()}] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const receiver = startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret })
let holder: Holder | undefined

function waitForHolderCredential(h: Holder, threadId: string, state: DidCommCredentialState, timeoutMs = 120_000) {
  return withTimeout(
    new Promise<string>((resolve) => {
      h.events.observable<any>('DidCommCredentialStateChanged').subscribe((e) => {
        const r = e.payload.credentialExchangeRecord
        if (r.threadId === threadId && r.state === state) resolve(r.id)
      })
    }),
    timeoutMs,
    `holder credential ${state}`
  )
}

function waitForHolderProof(h: Holder, threadId: string, state: DidCommProofState, timeoutMs = 120_000) {
  return withTimeout(
    new Promise<string>((resolve) => {
      h.events.observable<any>('DidCommProofStateChanged').subscribe((e) => {
        const r = e.payload.proofRecord
        if (r.threadId === threadId && r.state === state) resolve(r.id)
      })
    }),
    timeoutMs,
    `holder proof ${state}`
  )
}

try {
  await receiver.listening
  const endpoint = await setup.must<{ secret?: string }>('PUT', '/v1/webhook', { url: webhookUrl })
  secret = endpoint.secret ?? (await setup.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret

  const catalogue = await publishCatalogue(setup, 'smoke-biometric')
  // Gate this credential definition (API key route; the tenant switch was set by biometric-setup.sh).
  await setup.must('PUT', `/v1/credential-definitions/${encodeURIComponent(catalogue.credentialDefinitionLedgerId)}/biometric-policy`, { mode: 'required', minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3 })

  const wallet = await api.must<{ id: string; walletToken: string }>('POST', '/v1/wallets', { externalId: `user-${runId}` })
  const sdk = platformClient(baseUrl, wallet.walletToken)
  const invitation = await sdk.must<{ invitationUrl: string }>('GET', '/v1/wallet/mediator-invitation')
  holder = await createHolderAgent('biometric-holder', { mediatorInvitationUrl: invitation.invitationUrl, autoAccept: false })
  const h = holder

  const connectionInvitation = await api.must<{ invitationUrl: string }>('POST', '/v1/connections/invitations', { externalId: runId })
  const received = await h.modules.didcomm.oob.receiveInvitationFromUrl(connectionInvitation.invitationUrl, { label: 'biometric-holder' })
  await h.modules.didcomm.connections.returnWhenIsConnected(received.connectionRecord!.id, { timeoutMs: 90_000 })
  const connected = await receiver.waitFor('connection completed', (e) => e.type === 'connection.state_changed' && e.event.data.state === 'completed' && e.event.data.externalId === runId, 60_000)
  const connectionId = connected.event.data.id as string
  console.log(`  [${now()}] connected ${connectionId}`)

  const offer = async (label: string, withImage = true) => {
    const body = { connectionId, credentialDefinitionId: catalogue.credentialDefinitionLedgerId, attributes: offerAttributes(label), externalId: `${runId}-${label}`, ...(withImage ? { biometric: { referenceImage } } : {}) }
    return api.call<{ id: string; threadId: string; biometric: { status: string } | null; error?: string }>('POST', '/v1/credentials/offer', body)
  }
  const session = async (threadId: string, face: 'same' | 'other') => {
    const started = await sdk.must<{ sessionId: string; attemptsRemaining: number }>('POST', '/v1/wallet/biometric-sessions', { threadId, captureModules: [{ provider: 'mock', version: 1 }] })
    return sdk.must<{ outcome: string; attemptsRemaining: number }>('POST', `/v1/wallet/biometric-sessions/${started.sessionId}/complete`, { clientOutput: { live: true, face } })
  }
  const logOf = (kind: 'credentials' | 'proofs', id: string) => api.must<Log>('GET', `/v1/${kind}/${id}/biometric-log`)
  const types = (log: Log) => log.events.map((e) => e.type).join('>')

  // 0. no reference image → 422
  const refused = await offer('no-image', false)
  check('offer without a reference image is refused', refused.status === 422 && refused.json.error === 'biometric_reference_required', `${refused.status}`)

  // 1. pass before hold
  {
    const created = (await offer('pass-first')).json
    const heldOffer = await waitForHolderCredential(h, created.threadId, DidCommCredentialState.OfferReceived)
    const reqs = await sdk.must<{ requirements: Array<{ threadId: string; status: string }> }>('GET', `/v1/wallet/biometric-requirements?threadId=${created.threadId}`)
    check('1 SDK sees the requirement by thread id', reqs.requirements[0]?.status === 'pending')
    const outcome = await session(created.threadId, 'same')
    check('1 check passes', outcome.outcome === 'passed')
    const credentialReceived = waitForHolderCredential(h, created.threadId, DidCommCredentialState.CredentialReceived)
    await h.modules.didcomm.credentials.acceptOffer({ credentialExchangeRecordId: heldOffer })
    const recordId = await credentialReceived
    await h.modules.didcomm.credentials.acceptCredential({ credentialExchangeRecordId: recordId })
    await receiver.waitFor('1 credential done', (e) => e.type === 'credential.state_changed' && e.event.data.id === created.id && e.event.data.state === 'done', 60_000)
    const log = await logOf('credentials', created.id)
    check('1 issued after the pass', types(log) === 'gate_created>session_started>attempt_completed>hold_reached>issued', types(log))
  }

  // 2. hold before pass
  {
    const created = (await offer('hold-first')).json
    const heldOffer = await waitForHolderCredential(h, created.threadId, DidCommCredentialState.OfferReceived)
    await h.modules.didcomm.credentials.acceptOffer({ credentialExchangeRecordId: heldOffer })
    await receiver.waitFor('2 request received', (e) => e.type === 'credential.state_changed' && e.event.data.id === created.id && e.event.data.state === 'request-received', 60_000)
    await sleep(15_000)
    const stillHeld = await api.must<{ state: string }>('GET', `/v1/credentials/${created.id}`)
    check('2 not issued while the check is pending', stillHeld.state === 'request-received', stillHeld.state)
    const credentialReceived = waitForHolderCredential(h, created.threadId, DidCommCredentialState.CredentialReceived)
    const outcome = await session(created.threadId, 'same')
    check('2 check passes', outcome.outcome === 'passed')
    const recordId = await credentialReceived
    await h.modules.didcomm.credentials.acceptCredential({ credentialExchangeRecordId: recordId })
    await receiver.waitFor('2 credential done', (e) => e.type === 'credential.state_changed' && e.event.data.id === created.id && e.event.data.state === 'done', 60_000)
    const log = await logOf('credentials', created.id)
    check('2 issued on the pass', types(log) === 'gate_created>hold_reached>session_started>attempt_completed>issued', types(log))
  }

  // 3. lockout
  {
    const created = (await offer('lockout')).json
    await waitForHolderCredential(h, created.threadId, DidCommCredentialState.OfferReceived)
    const outcomes = [await session(created.threadId, 'other'), await session(created.threadId, 'other'), await session(created.threadId, 'other')].map((o) => o.outcome)
    check('3 fails twice, then locks', outcomes.join(',') === 'failed,failed,locked', outcomes.join(','))
    await receiver.waitFor('3 abandoned', (e) => e.type === 'credential.state_changed' && e.event.data.id === created.id && e.event.data.state === 'abandoned', 60_000)
    const log = await logOf('credentials', created.id)
    check('3 abandoned after the last attempt', log.biometric?.status === 'failed' && types(log).endsWith('attempt_completed>declined'), types(log))
    check('3 scores are logged', log.events.filter((e) => e.type === 'attempt_completed').every((e) => e.matchScore === 12 && e.decision === 'failed'))
  }

  // 4. gated proof
  {
    const template = await setup.must<{ id: string }>('POST', '/v1/proof-templates', {
      name: 'biometric proof',
      groups: [{ key: 'employee', attributes: ['name'], credentials: [{ schemaName: 'smoke-biometric' }] }],
      biometricPolicy: { mode: 'required', minMatchScore: 90 },
    })
    const created = (await api.call<{ id: string; threadId: string }>('POST', '/v1/proofs/request', { connectionId, templateId: template.id, externalId: `${runId}-proof`, biometric: { referenceImage } })).json
    const requestId = await waitForHolderProof(h, created.threadId, DidCommProofState.RequestReceived)
    const { proofFormats } = await h.modules.didcomm.proofs.selectCredentialsForRequest({ proofExchangeRecordId: requestId })
    const holderDone = waitForHolderProof(h, created.threadId, DidCommProofState.Done)
    await h.modules.didcomm.proofs.acceptRequest({ proofExchangeRecordId: requestId, proofFormats })
    await receiver.waitFor('4 presentation received', (e) => e.type === 'proof.state_changed' && e.event.data.id === created.id && e.event.data.state === 'presentation-received', 60_000)
    const held = await api.must<{ state: string; verified: boolean | null; disclosed: unknown }>('GET', `/v1/proofs/${created.id}`)
    check('4 verified and disclosed withheld before the pass', held.verified === null && held.disclosed === null, `${held.state} verified=${held.verified}`)
    const outcome = await session(created.threadId, 'same')
    check('4 check passes', outcome.outcome === 'passed')
    await holderDone
    const done = await receiver.waitFor('4 proof done', (e) => e.type === 'proof.state_changed' && e.event.data.id === created.id && e.event.data.state === 'done', 60_000)
    const released = await api.must<{ verified: boolean | null; disclosed: Record<string, Record<string, string>> | null }>('GET', `/v1/proofs/${created.id}`)
    check('4 released after the pass', released.verified === true && ['Ada Lovelace (pass-first)', 'Ada Lovelace (hold-first)'].includes(released.disclosed?.employee?.name ?? ''), JSON.stringify(released.disclosed))
    check('4 the done webhook carries the result', done.event.data.verified === true)
    const log = await logOf('proofs', created.id)
    check('4 accepted on the pass', types(log) === 'gate_created>hold_reached>session_started>attempt_completed>accepted', types(log))
  }

  // 5. webhooks
  await sleep(3_000)
  const biometricEvents = receiver.events.filter((e) => e.type === 'biometric.check_completed')
  check('5 biometric.check_completed webhooks (one per attempt)', biometricEvents.length >= 6, `${biometricEvents.length}`)
  check('5 no image in any webhook', !receiver.events.some((e) => JSON.stringify(e.event).includes(referenceImage.slice(0, 40))))
  check('5 all signatures valid', receiver.events.every((e) => e.signatureValid))

  passed = checks.every(([, ok]) => ok)
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  await sleep(2000)
  await holder?.shutdown().catch(() => undefined)
  receiver.close()
}
console.log(`\n=== smoke:biometric-credo ${passed ? 'PASSED' : 'FAILED'} (${checks.filter(([, ok]) => ok).length}/${checks.length}) ===`)
process.exit(passed ? 0 : 1)
