/**
 * smoke:platform-android (Phase 3 P10, the gate): the native Kotlin holder on a phone, with
 * everything server-side driven through the PUBLIC platform API and observed through webhooks.
 *
 * Plumbing (one SSH tunnel): `-R 3200:127.0.0.1:3201` makes this process reachable as
 * https://smoke-issuer.<domain>/ for the webhook receiver (/webhook) and for the app's issuer
 * invitation (/phase0/invitation). The app is the Phase 0 sample (PickUpV1, staging genesis)
 * with its mediator invitation replaced by the per-wallet one minted here:
 * set MEDIATOR_INVITATION_OUT to write it to a file, rebuild/install the app, then run with
 * SKIP_WALLET=<walletId> to continue with that wallet.
 *
 * Scenario: connect, LIVE offer, OFFLINE offer (force-stop → queued → wake webhook → reopen),
 * PROOF from a template. No Credo on this machine; only fetch + adb.
 *
 * Env: PLATFORM_API, PLATFORM_API_KEY, PLATFORM_TENANT_ID (console setup over SSH, K1), WEBHOOK_URL, RECEIVER_PORT, CRED_DEF_ID (optional: reuse a
 * published cred def instead of publishing), MEDIATOR_INVITATION_OUT | SKIP_WALLET.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { consoleClient, env, now, offerAttributes, platformClient, publishCatalogue, sleep, startReceiver } from './platform-common.ts'

const APP = 'org.hyperledger.ariesproject'
const baseUrl = env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')
const api = platformClient(baseUrl, env('PLATFORM_API_KEY'))
// Setup routes are console only (review K1): publishing, templates, policies, the webhook endpoint.
const setup = consoleClient()
const webhookUrl = env('WEBHOOK_URL', 'https://smoke-issuer.12id.naziharitsolution.com/webhook')
const externalId = `android-${Date.now()}`
const adb = (...args: string[]) => execFileSync('adb', args, { encoding: 'utf8' }).trim()

// Step 1: mint the wallet + invitation for the app build, then exit.
if (process.env.MEDIATOR_INVITATION_OUT) {
  const wallet = await api.must<{ id: string; walletToken: string }>('POST', '/v1/wallets', { externalId: `phone-${externalId}` })
  const invitation = await platformClient(baseUrl, wallet.walletToken).must<{ invitationUrl: string }>('GET', '/v1/wallet/mediator-invitation')
  writeFileSync(process.env.MEDIATOR_INVITATION_OUT, invitation.invitationUrl)
  console.log(`wallet ${wallet.id}: invitation written to ${process.env.MEDIATOR_INVITATION_OUT}; build the app with it, then run with SKIP_WALLET=${wallet.id}`)
  process.exit(0)
}

const walletId = env('SKIP_WALLET')
let passed = false
let secret = ''
let issuerInvitationUrl: string | undefined
const receiver = startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret, invitationUrl: () => issuerInvitationUrl })

const waitState = async (type: string, id: string, states: string[], timeoutMs: number, label: string) => {
  const started = Date.now()
  const hit = await receiver.waitFor(`${label} ${states.join('|')}`, (e) => e.type === type && e.event.data.id === id && states.includes(String(e.event.data.state)), timeoutMs)
  return { state: String(hit.event.data.state), afterMs: Date.now() - started, event: hit.event }
}

try {
  await receiver.listening
  console.log(`device: ${adb('shell', 'getprop', 'ro.product.model')}, Android ${adb('shell', 'getprop', 'ro.build.version.release')}`)

  const endpoint = await setup.must<{ secret?: string }>('PUT', '/v1/webhook', { url: webhookUrl })
  secret = endpoint.secret ?? (await setup.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret
  const credDefId = process.env.CRED_DEF_ID ?? (await publishCatalogue(setup, 'smoke-badge')).credentialDefinitionLedgerId

  // --- connect (the app fetches the invitation from /phase0/invitation on a fresh launch) ---
  const invitation = await api.must<{ invitationId: string; invitationUrl: string }>('POST', '/v1/connections/invitations', { externalId })
  issuerInvitationUrl = invitation.invitationUrl
  adb('shell', 'am', 'force-stop', APP)
  adb('shell', 'pm', 'clear', APP)
  adb('shell', 'am', 'start', '-n', `${APP}/.WalletMainActivity`)
  console.log(`  [${now()}] app launched with a fresh wallet`)
  const connected = await receiver.waitFor('connection completed', (e) => e.type === 'connection.state_changed' && e.event.data.invitationId === invitation.invitationId && e.event.data.state === 'completed', 180_000)
  const connectionId = connected.event.data.id as string
  console.log(`  [${now()}] connected ${connectionId} (theirLabel ${connected.event.data.theirLabel})`)

  // --- live ------------------------------------------------------------------------------
  console.log('\n=== LIVE: offer while the app is running ===')
  const live = await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: credDefId, attributes: offerAttributes('live'), externalId })
  const liveResult = await waitState('credential.state_changed', live.id, ['done', 'abandoned'], 120_000, 'live credential')

  // --- offline ---------------------------------------------------------------------------
  console.log('\n=== OFFLINE: force-stop, offer, wake webhook, reopen ===')
  adb('shell', 'am', 'force-stop', APP)
  console.log(`  [${now()}] app force-stopped`)
  // The live offer's forward already produced a wake-up, which suppresses further ones for
  // WAKE_DEBOUNCE_MS (30 s). Wait the window out so the offline message has to produce its own,
  // and count only wake-ups received after this point.
  console.log(`  [${now()}] waiting 32 s for the wake-up debounce window to close`)
  await sleep(32_000)
  const eventsBefore = receiver.events.length
  const offline = await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: credDefId, attributes: offerAttributes('offline'), externalId })
  console.log(`  [${now()}] offer sent while the app was closed`)
  let wake: { receivedAt: string } | undefined
  try {
    wake = await receiver.waitFor('wallet.sync_requested', (e) => e.type === 'wallet.sync_requested' && e.event.data.walletId === walletId && receiver.events.indexOf(e) >= eventsBefore, 30_000)
    console.log(`  [${now()}] wallet.sync_requested received (the customer backend would push the device now)`)
  } catch {
    console.log(`  [${now()}] no wake webhook within 30 s (debounced by an earlier one?)`)
  }
  await sleep(5_000)
  adb('shell', 'am', 'start', '-n', `${APP}/.WalletMainActivity`)
  console.log(`  [${now()}] app reopened`)
  const offlineResult = await waitState('credential.state_changed', offline.id, ['done', 'abandoned'], 180_000, 'offline credential')

  // --- proof from a template -------------------------------------------------------------
  console.log('\n=== PROOF (template: attributes + automatic expiresOn predicate) ===')
  const template = await setup.must<{ id: string }>('POST', '/v1/proof-templates', { name: 'smoke-platform-android', groups: [{ key: 'employee', attributes: ['name', 'department'], credentials: [{ credentialDefinitionId: credDefId }] }] })
  const proof = await api.must<{ id: string }>('POST', '/v1/proofs/request', { connectionId, templateId: template.id, externalId })
  const proofResult = await waitState('proof.state_changed', proof.id, ['done', 'abandoned'], 120_000, 'proof')
  const proofView = await api.must<{ verified: boolean | null; disclosed: Record<string, Record<string, string>> | null }>('GET', `/v1/proofs/${proof.id}`)

  const wakes = receiver.events.filter((e) => e.type === 'wallet.sync_requested' && e.event.data.walletId === walletId).length
  const badSignatures = receiver.events.filter((e) => !e.signatureValid).length
  console.log('\n=== smoke:platform-android results ===')
  console.log('live credential   :', liveResult.state)
  console.log('offline credential:', offlineResult.state, `(${(offlineResult.afterMs / 1000).toFixed(1)} s after reopen)`)
  console.log('wake webhook      :', wake ? 'received' : 'not received', `(total for this wallet: ${wakes})`)
  console.log('proof             :', proofResult.state, `verified=${proofView.verified}`, JSON.stringify(proofView.disclosed ?? {}))
  console.log('signatures        :', badSignatures === 0 ? 'all valid' : `${badSignatures} INVALID`)
  console.log('externalId        :', externalId)
  passed = liveResult.state === 'done' && offlineResult.state === 'done' && proofResult.state === 'done' && proofView.verified === true && wake !== undefined && badSignatures === 0
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  receiver.close()
}
console.log(`\n=== smoke:platform-android ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
