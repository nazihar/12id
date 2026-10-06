/**
 * smoke:sdk-android (Phase 5, the gate): the 12id sample app (SDK from build/m2, debug build) on a
 * phone against staging, driven over adb; everything server-side through the PUBLIC platform API and
 * observed through signed webhooks. Nothing is compiled into the app: it gets its wallet token from
 * this process (the customer-backend stand-in at /sdk/wallet), the genesis from /v1/ledger and its
 * mediator invitation from /v1/wallet/mediator-invitation.
 *
 * Plumbing: one SSH tunnel `-R 3200:127.0.0.1:3201` makes this process https://smoke-issuer.<domain>/
 * (webhook receiver + /sdk/wallet). Build and install the app first:
 *   cd sdk-android && ./gradlew :sample:assembleDebug && adb install -r sample/build/outputs/apk/debug/sample-arm64-v8a-debug.apk
 *
 * Steps (plan T; on-demand delivery, implement/20-on-demand-delivery.md): 1 fresh install → Ready;
 * 2 connect (the connect window); 3 EXPECT + offer → pending (not auto-accepted) → accept → done, a
 * second offer pushed while the app is open → declined; 3b the open, idle app sends no pickups for 60 s;
 * 3c an offer sent while the app is in the background without a push is collected when it opens;
 * 4 offline offer → wake webhook → simulated push in the background → sync collects; a second offer
 * inside the 30 s wake-up debounce gets no wake-up and is collected by the sync tail → both done;
 * 5 EXPECT + template proof → respond → verified, second request declined; 6 restart keeps the
 * mediator connection and credentials; 7 wiped wallet + spent invitation recovers.
 *
 * Env: PLATFORM_API, PLATFORM_API_KEY, PLATFORM_TENANT_ID (console setup over SSH, K1), WEBHOOK_URL, RECEIVER_PORT, CRED_DEF_ID (optional).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'

import { consoleClient, env, now, offerAttributes, platformClient, publishCatalogue, sleep, startReceiver } from './platform-common.ts'

const APP = 'com.onetwoid.sample'
const baseUrl = env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')
const api = platformClient(baseUrl, env('PLATFORM_API_KEY'))
// Setup routes are console only (review K1): publishing, templates, policies, the webhook endpoint.
const setup = consoleClient()
const webhookUrl = env('WEBHOOK_URL', 'https://smoke-issuer.12id.naziharitsolution.com/webhook')
const externalId = `sdk-${Date.now()}`
// ADB_SERIAL picks the device (e.g. emulator-5554 for the min-SDK check); STEPS=3 stops after step 3.
const serial = process.env.ADB_SERIAL ? ['-s', process.env.ADB_SERIAL] : []
const lastStep = Number(process.env.STEPS ?? 7)
// Asynchronous on purpose: this process also serves the webhook receiver and the stand-in customer
// backend, and one `adb logcat -d` takes seconds on a real phone. A synchronous adb froze both, so the
// app's token request timed out and the queued requests were answered later in one burst.
const execFileAsync = promisify(execFile)
const adb = async (...args: string[]) =>
  (await execFileAsync('adb', [...serial, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout.trim()

interface Dump {
  state: string
  error?: string
  connections?: { id: string; label: string | null; status: string }[]
  credentials?: { id: string; credentialDefinitionId: string; attributes: Record<string, string> }[]
  offers?: { id: string; attributes: Record<string, string> }[]
  proofRequests?: { id: string; name: string }[]
}

const dumpLines = async () => (await adb('logcat', '-d', '-s', 'onetwoid-sample')).split('\n').map((l) => l.trim()).filter((l) => l.includes(' dump {'))

/** Broadcasts a debug action and returns the app's next `dump {json}` line (the log buffer is kept for diagnosis). */
async function action(name: string, extras: string[] = [], timeoutMs = 30_000): Promise<Dump> {
  const before = (await dumpLines()).length
  await adb('shell', 'am', 'broadcast', '-a', `${APP}.${name}`, '-p', APP, ...extras)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lines = await dumpLines()
    if (lines.length > before) {
      const line = lines[lines.length - 1]
      const dump = JSON.parse(line.slice(line.indexOf('dump {') + 5)) as Dump
      if (dump.error) throw new Error(`${name}: ${dump.error}`)
      return dump
    }
    await sleep(500)
  }
  throw new Error(`${name}: no dump within ${timeoutMs} ms`)
}

async function waitReady(timeoutMs: number): Promise<Dump> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dump = await action('DUMP').catch(() => undefined)
    if (dump?.state === 'Ready') return dump
    if (dump?.state === 'Failed') throw new Error(`wallet failed: ${dump.error}`)
    await sleep(2_000)
  }
  throw new Error('wallet not Ready in time')
}

/** Reads the app's state (a local read: DUMP never asks the mediator) until [done] holds. */
async function waitForDump(label: string, done: (d: Dump) => boolean, timeoutMs: number): Promise<Dump> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dump = await action('DUMP')
    if (done(dump)) return dump
    await sleep(1_000)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The SDK logs one Info line per mediator pickup (on-demand delivery); counts them in the app log. */
const pickupLines = async () => (await adb('logcat', '-d', '-s', 'onetwoid-sdk')).split('\n').filter((l) => l.includes('mediator pickup ('))

const launch = () => adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`)
const forceStop = () => adb('shell', 'am', 'force-stop', APP)
/**
 * Kills the process without force-stopping the package. A force-stopped app is in Android's
 * "stopped state" and receives neither broadcasts nor FCM messages until the user opens it again, so
 * the push path can only be simulated on a process that was evicted or swiped away.
 */
const killInBackground = async () => {
  await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(1_500)
  await adb('shell', 'am', 'kill', APP)
  await sleep(1_500)
  // pidof exits 1 when no process matches, which is the outcome wanted here.
  const pid = await adb('shell', `pidof ${APP} || true`)
  if (pid) throw new Error(`process still alive after am kill (pid ${pid})`)
}
/**
 * MIUI refuses to start a killed app for a broadcast (or an FCM message) unless the user grants
 * "Autostart"; MIUI app-op 10008 is that switch. `pm clear` resets it some time later, not at once, so
 * it is set after the clear and again before the step that needs it. Other Android builds do not know
 * the op and ignore it.
 */
const allowAutostart = async () => {
  for (let i = 0; i < 5; i++) {
    await adb('shell', `cmd appops set ${APP} 10008 allow 2>/dev/null || true`)
    await sleep(1_000)
    const op = await adb('shell', `cmd appops get ${APP} 10008 2>/dev/null || true`)
    if (!op || op.includes('allow')) return
  }
  throw new Error('MIUI autostart (app-op 10008) cannot be allowed for the sample')
}
const isForeground = async () => /ResumedActivity.*com\.onetwoid\.sample/.test(await adb('shell', 'dumpsys', 'activity', 'activities'))

let passed = false
let stayOnBefore = ''
let secret = ''
const wallets = new Map<string, string>()
const tokenRequests = { count: 0 }
const receiver = startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret, walletBackend: { api, wallets, requests: tokenRequests } })
const results: Record<string, string> = {}

const waitState = async (type: string, id: string, states: string[], timeoutMs: number, label: string) => {
  const started = Date.now()
  const hit = await receiver.waitFor(`${label} ${states.join('|')}`, (e) => e.type === type && e.event.data.id === id && states.includes(String(e.event.data.state)), timeoutMs)
  return { state: String(hit.event.data.state), afterMs: Date.now() - started, event: hit.event }
}

try {
  await receiver.listening
  console.log(`device: ${await adb('shell', 'getprop', 'ro.product.model')}, Android ${await adb('shell', 'getprop', 'ro.build.version.release')}`)
  // Best effort: some API 26 emulator images refuse ("failed to clear the 'main' log"); dumps are counted, not cleared.
  try {
    await adb('logcat', '-c')
  } catch {
    console.log('  (logcat -c refused by the device; continuing)')
  }
  // The screen must stay on: when it sleeps and wakes, the app returns to the foreground and drains
  // once, which 3b would count as a pickup from an idle app. Restored in the finally block.
  stayOnBefore = await adb('shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in').catch(() => '')
  await adb('shell', 'svc', 'power', 'stayon', 'true').catch(() => console.log('  (cannot keep the screen on; continuing)'))
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  const endpoint = await setup.must<{ secret?: string }>('PUT', '/v1/webhook', { url: webhookUrl })
  secret = endpoint.secret ?? (await setup.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret
  const credDefId = process.env.CRED_DEF_ID ?? (await publishCatalogue(setup, 'smoke-badge')).credentialDefinitionLedgerId

  // --- 1: fresh install onboards with nothing compiled in ------------------------------------
  console.log('\n=== 1 ONBOARDING (fresh install) ===')
  await forceStop()
  await adb('shell', 'pm', 'clear', APP)
  await sleep(3_000)
  await allowAutostart()
  await launch()
  console.log(`  [${now()}] app launched`)
  await waitReady(120_000)
  const walletId = [...wallets.values()][0]
  if (!walletId) throw new Error('the app never asked the backend for a wallet token')
  // No wake-up is expected here: the Kotlin holder gets its mediation grant back over the socket
  // (return route), so nothing is queued until an organisation sends the first message.
  const walletView = await api.must<{ hasMediatorInvitation: boolean }>('GET', `/v1/wallets/${walletId}`)
  console.log(`  [${now()}] wallet ${walletId.slice(0, 8)} Ready; platform hasMediatorInvitation=${walletView.hasMediatorInvitation}`)
  results.onboarding = `Ready (token requests: ${tokenRequests.count}, invitation minted: ${walletView.hasMediatorInvitation})`

  // --- 2: connect --------------------------------------------------------------------------
  console.log('\n=== 2 CONNECT ===')
  const invitation = await api.must<{ invitationId: string; invitationUrl: string }>('POST', '/v1/connections/invitations', { externalId })
  await action('CONNECT', ['--es', 'url', invitation.invitationUrl])
  const connected = await receiver.waitFor('connection completed', (e) => e.type === 'connection.state_changed' && e.event.data.invitationId === invitation.invitationId && e.event.data.state === 'completed', 120_000)
  const connectionId = connected.event.data.id as string
  const afterConnect = await action('DUMP')
  results.connect = `completed (app lists ${afterConnect.connections?.length} connection(s))`
  console.log(`  [${now()}] connected ${connectionId.slice(0, 8)}`)

  // --- 3: offer is pending, then accepted; a second offer declined -------------------------------
  // On-demand delivery: the open app does not poll while idle. The first offer is app-initiated (the app
  // calls expectMessages() as it asks its backend); the second is organisation-initiated while the app is
  // open, so it arrives with the push.
  console.log('\n=== 3 OFFER: expected → pending → accept; pushed while open → declined ===')
  await action('EXPECT')
  const liveSentAt = Date.now()
  const live = await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: credDefId, attributes: offerAttributes('live'), externalId })
  const pending = await waitForDump('the expected offer', (d) => !!d.offers?.length, 60_000)
  const offerLatency = ((Date.now() - liveSentAt) / 1000).toFixed(1)
  console.log(`  [${now()}] offer pending in the app ${offerLatency} s after the API call (${pending.offers?.length}); not auto-accepted`)
  await action('ACCEPT_OFFERS')
  const liveResult = await waitState('credential.state_changed', live.id, ['done', 'abandoned'], 120_000, 'live credential')
  // Out of the wake-up debounce, so the second offer gets a wake-up of its own.
  await sleep(32_000)
  const eventsBefore3 = receiver.events.length
  const declined = await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: credDefId, attributes: offerAttributes('declined'), externalId })
  await receiver.waitFor('wallet.sync_requested (app open)', (e) => e.type === 'wallet.sync_requested' && e.event.data.walletId === walletId && receiver.events.indexOf(e) >= eventsBefore3, 30_000)
  await action('SIMULATE_PUSH')
  await waitForDump('the pushed offer', (d) => !!d.offers?.length, 60_000)
  await action('DECLINE_OFFERS')
  const declinedResult = await waitState('credential.state_changed', declined.id, ['abandoned', 'declined', 'done'], 120_000, 'declined offer')
  results.offer = `expected offer in ${offerLatency} s, accepted → ${liveResult.state}; pushed offer declined → ${declinedResult.state}`
  if (lastStep <= 3) {
    const badSignatures3 = receiver.events.filter((e) => !e.signatureValid).length
    console.log('\n=== smoke:sdk-android results (steps 1-3) ===')
    for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(16)}: ${v}`)
    passed = liveResult.state === 'done' && declinedResult.state === 'abandoned' && badSignatures3 === 0
    throw new Error('__done__')
  }

  // --- 3b: an open, idle app does not poll ------------------------------------------------------
  console.log('\n=== 3b IDLE: the open app sends no pickups ===')
  // Let the accept window and the push's sync tail (32 s) finish first.
  await sleep(35_000)
  if (!(await isForeground())) throw new Error('3b needs the app in the foreground')
  const pickupsBefore = (await pickupLines()).length
  await sleep(60_000)
  const idlePickups = (await pickupLines()).slice(pickupsBefore)
  if (idlePickups.length !== 0) {
    // A "(foreground)" pickup means the screen slept and woke: the device left the state this step tests.
    const reasons = idlePickups.map((l) => l.match(/mediator pickup \(([^)]*)\)/)?.[1] ?? '?').join(', ')
    throw new Error(`the idle app sent ${idlePickups.length} pickup(s) in 60 s (${reasons})`)
  }
  results.idle = '0 pickups in 60 s with the app open'

  // --- 3c: a missed push is collected when the app comes to the foreground ----------------------
  console.log('\n=== 3c FOREGROUND DRAIN: offer while in the background, no push, then open ===')
  await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(32_000)
  const missed = await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: credDefId, attributes: offerAttributes('missed-push'), externalId })
  await waitState('credential.state_changed', missed.id, ['offer-sent'], 60_000, 'missed-push offer')
  await sleep(10_000)
  if ((await action('DUMP')).offers?.length) throw new Error('the backgrounded app collected an offer without a push or a foreground')
  const openedAt = Date.now()
  await launch()
  await waitForDump('the offer, drained on foreground', (d) => !!d.offers?.length, 30_000)
  const drainLatency = ((Date.now() - openedAt) / 1000).toFixed(1)
  await action('DECLINE_OFFERS')
  results.foregroundDrain = `offer collected ${drainLatency} s after the app opened`

  // --- 4: offline offers, one wake webhook, simulated push in the background, sync + tail ----------
  console.log('\n=== 4 OFFLINE: process killed; offer → wake → push → sync; second offer inside the debounce → tail ===')
  await allowAutostart()
  await killInBackground()
  console.log(`  [${now()}] app process killed (not force-stopped); waiting 32 s for the wake-up debounce window`)
  await sleep(32_000)
  const eventsBefore = receiver.events.length
  const offline = await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: credDefId, attributes: offerAttributes('offline'), externalId })
  console.log(`  [${now()}] offer sent while the app process was dead`)
  const wake = await receiver.waitFor('wallet.sync_requested', (e) => e.type === 'wallet.sync_requested' && e.event.data.walletId === walletId && receiver.events.indexOf(e) >= eventsBefore, 30_000)
  console.log(`  [${now()}] wallet.sync_requested received; simulating the customer's push (app not in foreground)`)
  // The broadcast starts the process in the background; SyncWorker opens the wallet and syncs.
  const syncDump = await action('SIMULATE_PUSH', [], 90_000)
  if (await isForeground()) throw new Error('the app came to the foreground during the push path')
  await waitForDump('the offline offer, collected by sync()', (d) => (d.offers?.length ?? 0) >= 1, 90_000)
  console.log(`  [${now()}] offline offer collected in the background (state ${syncDump.state})`)
  // Inside the platform's 30 s debounce: no wake-up of its own; the SDK's sync tail must collect it.
  const offline2 = await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: credDefId, attributes: offerAttributes('offline-2'), externalId })
  const offline2SentAt = Date.now()
  await waitForDump('the second offer, collected by the sync tail', (d) => (d.offers?.length ?? 0) >= 2, 45_000)
  const tailLatency = ((Date.now() - offline2SentAt) / 1000).toFixed(1)
  const wakes4 = receiver.events.slice(eventsBefore).filter((e) => e.type === 'wallet.sync_requested' && e.event.data.walletId === walletId).length
  if (await isForeground()) throw new Error('the app came to the foreground during the sync tail')
  console.log(`  [${now()}] second offer collected by the tail ${tailLatency} s after it was sent (wake-ups: ${wakes4})`)
  await action('ACCEPT_OFFERS')
  const offlineResult = await waitState('credential.state_changed', offline.id, ['done', 'abandoned'], 120_000, 'offline credential')
  const offline2Result = await waitState('credential.state_changed', offline2.id, ['done', 'abandoned'], 120_000, 'second offline credential')
  results.offline = `${offlineResult.state} + ${offline2Result.state}; wake webhook at ${wake.receivedAt}; second offer by the tail in ${tailLatency} s with ${wakes4} wake-up(s)`

  // --- 5: proof from a template; a second request declined -------------------------------------
  console.log('\n=== 5 PROOF (template with the automatic expiresOn predicate) ===')
  // The user opens the app (a foreground drain) and starts an action the backend guards with a proof
  // request: the app calls expectMessages() as it asks.
  await launch()
  await waitReady(60_000)
  const template = await setup.must<{ id: string }>('POST', '/v1/proof-templates', { name: 'smoke-sdk-android', groups: [{ key: 'employee', attributes: ['name', 'department'], credentials: [{ credentialDefinitionId: credDefId }] }] })
  await sleep(3_000)
  await action('EXPECT')
  const proofSentAt = Date.now()
  const proof = await api.must<{ id: string }>('POST', '/v1/proofs/request', { connectionId, templateId: template.id, externalId })
  await waitForDump('the expected proof request', (d) => !!d.proofRequests?.length, 60_000)
  const requestLatency = ((Date.now() - proofSentAt) / 1000).toFixed(1)
  await action('RESPOND_PROOFS')
  const proofResult = await waitState('proof.state_changed', proof.id, ['done', 'abandoned'], 120_000, 'proof')
  const proofDone = ((Date.now() - proofSentAt) / 1000).toFixed(1)
  const proofView = await api.must<{ verified: boolean | null; disclosed: Record<string, Record<string, string>> | null }>('GET', `/v1/proofs/${proof.id}`)
  await action('EXPECT')
  const proof2 = await api.must<{ id: string }>('POST', '/v1/proofs/request', { connectionId, templateId: template.id, externalId })
  await waitForDump('the second proof request', (d) => !!d.proofRequests?.length, 60_000)
  await action('DECLINE_PROOFS')
  const proof2Result = await waitState('proof.state_changed', proof2.id, ['abandoned', 'declined', 'done'], 120_000, 'declined proof')
  results.proof = `${proofResult.state} verified=${proofView.verified} ${JSON.stringify(proofView.disclosed ?? {})}; in the app after ${requestLatency} s, done after ${proofDone} s (incl. the smoke's DUMP round trips); declined → ${proof2Result.state}`

  // --- 6: restart keeps the mediator connection and the credentials ----------------------------
  console.log('\n=== 6 RESTART ===')
  // A re-mediation would show as a new wallet.sync_requested (mediation setup queues replies) and, with
  // a fresh invitation, as another token request at the backend. Neither may happen on a plain restart.
  const eventsBefore6 = receiver.events.length
  const tokensBefore = tokenRequests.count
  await forceStop()
  await launch()
  const restarted = await waitReady(120_000)
  await sleep(15_000)
  const reMediated = receiver.events.slice(eventsBefore6).some((e) => e.type === 'wallet.sync_requested' && e.event.data.walletId === walletId)
  const sameMediation = !reMediated && tokenRequests.count === tokensBefore
  results.restart = `${restarted.credentials?.length} credentials listed; mediation unchanged=${sameMediation} (wake-ups after restart: ${reMediated}, token re-requested: ${tokenRequests.count !== tokensBefore})`

  // --- 7: wiped wallet with a spent invitation recovers ----------------------------------------
  console.log('\n=== 7 SPENT INVITATION (wallet wiped, SDK state kept) ===')
  // Recovery = the SDK asks the platform for a new invitation, which needs the wallet token from the
  // backend: one more token request, then Ready.
  await action('WIPE_WALLET_KEEP_STATE')
  await forceStop()
  const tokensBefore7 = tokenRequests.count
  const started7 = Date.now()
  await launch()
  const recovered = await waitReady(180_000)
  const reFetched = tokenRequests.count > tokensBefore7
  results.spentInvitation = `${recovered.state} after ${((Date.now() - started7) / 1000).toFixed(0)} s; new invitation fetched=${reFetched}`

  const badSignatures = receiver.events.filter((e) => !e.signatureValid).length
  console.log('\n=== smoke:sdk-android results ===')
  for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(16)}: ${v}`)
  console.log(`${'signatures'.padEnd(16)}: ${badSignatures === 0 ? 'all valid' : `${badSignatures} INVALID`}`)
  console.log(`${'externalId'.padEnd(16)}: ${externalId}`)
  passed = liveResult.state === 'done' && offlineResult.state === 'done' && offline2Result.state === 'done' && wakes4 === 1 && proofResult.state === 'done' && proofView.verified === true && sameMediation && recovered.state === 'Ready' && reFetched && badSignatures === 0
} catch (error) {
  if (!(error instanceof Error && error.message === '__done__')) {
    console.error('SMOKE FAILED:', error)
    for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v}`)
  }
} finally {
  receiver.close()
  if (stayOnBefore === '0') await adb('shell', 'svc', 'power', 'stayon', 'false').catch(() => undefined)
  const logFile = process.env.APP_LOG_OUT ?? 'smoke/sdk-android.last.log'
  try {
    writeFileSync(logFile, await adb('logcat', '-d', '-s', 'onetwoid-sample', 'onetwoid-sdk', 'AndroidRuntime'))
    console.log(`app log saved to ${logFile}`)
  } catch (error) {
    console.log(`app log not saved: ${error}`)
  }
}
console.log(`\n=== smoke:sdk-android ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
