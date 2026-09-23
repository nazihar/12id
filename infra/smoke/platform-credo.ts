/**
 * smoke:platform-credo (Phase 3 P10). Everything goes through the PUBLIC platform API with an
 * API key; the only operator step is creating the tenant + key (scripts: platform-bootstrap.ts).
 * A Credo holder stands in for the SDK: it gets its wallet token from the "customer backend"
 * (this script), fetches its per-wallet mediator invitation, then connects, receives a
 * credential and presents a proof. A local webhook receiver (reverse tunnel, see
 * platform-common.ts) asserts every event arrived, signed, including the wake-up.
 *
 * Env: PLATFORM_API (default https://api.12id.naziharitsolution.com), PLATFORM_API_KEY,
 *   PLATFORM_TENANT_ID (setup runs as the console over SSH, review K1; see consoleClient),
 * WEBHOOK_URL (default https://smoke-issuer.12id.naziharitsolution.com/webhook), RECEIVER_PORT (3201).
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
const externalId = `credo-${Date.now()}`

let passed = false
let secret = ''
const receiver = startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret })
let holder: Awaited<ReturnType<typeof createHolderAgent>> | undefined
const startedAt = Date.now()
try {
  await receiver.listening

  // --- customer backend setup ------------------------------------------------------------
  const endpoint = await setup.must<{ secret?: string }>('PUT', '/v1/webhook', { url: webhookUrl })
  if (!endpoint.secret) {
    // Existing endpoint from an earlier run: rotate so this receiver can verify signatures.
    secret = (await setup.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret
  } else secret = endpoint.secret
  console.log(`  [${now()}] webhook endpoint set`)
  const catalogue = await publishCatalogue(setup, 'smoke-badge')

  // --- wallet (what the customer backend does for its app user) --------------------------
  const wallet = await api.must<{ id: string; walletToken: string }>('POST', '/v1/wallets', { externalId: `user-${externalId}` })
  const sdk = platformClient(baseUrl, wallet.walletToken)
  const ledger = await sdk.must<{ genesis: { url: string; sha256: string } }>('GET', '/v1/ledger')
  const invitation = await sdk.must<{ invitationUrl: string }>('GET', '/v1/wallet/mediator-invitation')
  console.log(`  [${now()}] wallet ${wallet.id} got its mediator invitation (genesis ${ledger.genesis.sha256.slice(0, 8)}…)`)
  holder = await createHolderAgent('platform-holder', { mediatorInvitationUrl: invitation.invitationUrl })
  console.log(`  [${now()}] holder mediated through the per-wallet invitation`)

  // --- connect ---------------------------------------------------------------------------
  const connectionInvitation = await api.must<{ invitationId: string; invitationUrl: string }>('POST', '/v1/connections/invitations', { externalId })
  const received = await holder.modules.didcomm.oob.receiveInvitationFromUrl(connectionInvitation.invitationUrl, { label: 'platform-holder' })
  if (!received.connectionRecord) throw new Error('no holder connection')
  await holder.modules.didcomm.connections.returnWhenIsConnected(received.connectionRecord.id, { timeoutMs: 90_000 })
  const connected = await receiver.waitFor('connection completed', (e) => e.type === 'connection.state_changed' && e.event.data.state === 'completed', 60_000)
  const connectionId = connected.event.data.id as string
  const viaApi = await api.must<{ id: string; externalId: string }>('GET', `/v1/connections/${connectionId}`)
  console.log(`  [${now()}] connected ${connectionId} (externalId ${viaApi.externalId})`)

  // --- credential, with an idempotency replay --------------------------------------------
  const credentialDone = withTimeout(
    new Promise<void>((resolve) => {
      holder!.events.observable<any>('DidCommCredentialStateChanged').subscribe((e) => {
        if (e.payload.credentialExchangeRecord.state === DidCommCredentialState.Done) resolve()
      })
    }),
    180_000,
    'holder credential done'
  )
  const idempotencyKey = `offer-${externalId}`
  // One body for both calls: offerAttributes derives expiresAt from the clock, and a retry whose body
  // differs by a second is (correctly) refused with 422.
  const offerBody = { connectionId, credentialDefinitionId: catalogue.credentialDefinitionLedgerId, attributes: offerAttributes('platform'), externalId }
  const offer = await api.must<{ id: string; state: string }>('POST', '/v1/credentials/offer', offerBody, { 'idempotency-key': idempotencyKey })
  const replay = await api.call<{ id: string }>('POST', '/v1/credentials/offer', offerBody, { 'idempotency-key': idempotencyKey })
  const replayed = replay.status === 202 && replay.json.id === offer.id
  console.log(`  [${now()}] offered ${offer.id} (${offer.state}); idempotent replay ${replayed ? 'ok' : `UNEXPECTED ${replay.status}`}`)
  await credentialDone
  const credentialEvent = await receiver.waitFor('credential done', (e) => e.type === 'credential.state_changed' && e.event.data.id === offer.id && e.event.data.state === 'done', 60_000)
  console.log(`  [${now()}] credential done via webhook (externalId ${credentialEvent.event.data.externalId})`)

  // --- proof from a template -------------------------------------------------------------
  const template = await setup.must<{ id: string }>('POST', '/v1/proof-templates', {
    name: 'employment',
    groups: [{ key: 'employee', attributes: ['name', 'department'], credentials: [{ schemaName: 'smoke-badge' }], predicates: [{ name: 'employeeNumber', type: '>', value: 1000 }] }],
  })
  const proofDone = withTimeout(
    new Promise<void>((resolve) => {
      holder!.events.observable<any>('DidCommProofStateChanged').subscribe((e) => {
        if (e.payload.proofRecord.state === DidCommProofState.Done) resolve()
      })
    }),
    180_000,
    'holder proof done'
  )
  const proof = await api.must<{ id: string }>('POST', '/v1/proofs/request', { connectionId, templateId: template.id, externalId })
  await proofDone
  const proofEvent = await receiver.waitFor('proof done', (e) => e.type === 'proof.state_changed' && e.event.data.id === proof.id && e.event.data.state === 'done', 60_000)
  const proofView = await api.must<{ state: string; verified: boolean | null; disclosed: Record<string, Record<string, string>> | null }>('GET', `/v1/proofs/${proof.id}`)
  console.log(`  [${now()}] proof done: verified=${proofView.verified} disclosed=${JSON.stringify(proofView.disclosed)}`)

  // --- wake path: the mediator queued messages for this wallet → wallet.sync_requested ------
  await sleep(3_000)
  const wakes = receiver.events.filter((e) => e.type === 'wallet.sync_requested' && e.event.data.walletId === wallet.id)
  const elapsedWindows = Math.ceil((Date.now() - startedAt) / 30_000) + 1
  console.log(`  [${now()}] wallet.sync_requested x${wakes.length} (debounce allows at most ${elapsedWindows})`)

  const badSignatures = receiver.events.filter((e) => !e.signatureValid).length
  const deliveries = await api.must<Array<{ status: string }>>('GET', '/v1/webhook/deliveries?limit=200')
  const undelivered = deliveries.filter((d) => d.status !== 'delivered').length

  console.log('\n=== smoke:platform-credo results ===')
  console.log('connection webhook :', connected.event.data.state, `externalId=${viaApi.externalId}`)
  console.log('credential webhook :', credentialEvent.event.data.state, `replayed=${replayed}`)
  console.log('proof webhook      :', proofEvent.event.data.state, `verified=${proofEvent.event.data.verified}`)
  console.log('wake-ups           :', wakes.length)
  console.log('signatures         :', badSignatures === 0 ? 'all valid' : `${badSignatures} INVALID`)
  console.log('deliveries pending :', undelivered)
  passed =
    viaApi.externalId === externalId &&
    replayed &&
    proofView.verified === true &&
    proofView.disclosed?.employee?.name === 'Ada Lovelace (platform)' &&
    wakes.length >= 1 &&
    wakes.length <= elapsedWindows &&
    badSignatures === 0
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  await sleep(2000)
  await holder?.shutdown().catch(() => undefined)
  receiver.close()
}
console.log(`\n=== smoke:platform-credo ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
