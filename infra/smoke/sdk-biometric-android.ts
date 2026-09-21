/**
 * smoke:sdk-biometric-android (Phase 6, implement/16-phase-6-biometric.md T): the sample app (debug
 * build, SDK + biometric add-ons from build/m2) on a phone against staging, driven over adb as in
 * smoke:sdk-android. The tenant behind PLATFORM_API_KEY must have biometrics on
 * (infra/smoke/biometric-setup.sh on the VM).
 *
 *   PROVIDER=mock (default): the mock add-on answers from a preset (VERIFY_FACES --es preset …).
 *   PROVIDER=aws: the AWS add-on shows the real Face Liveness screen; a person does the check on the
 *   phone when the script says so (same face as REFERENCE_IMAGE for the pass, anyone else for the fail).
 *
 * Steps: 1 fresh install → Ready; 2 connect; 3 gated offer → accept refused (BiometricRequired) →
 * face check passes → accept → done; 4 gated offer → face check fails → attemptsRemaining reported;
 * 5 gated template proof → face check passes → respond → verified and disclosed released; 6 every
 * attempt in the biometric log.
 *
 * Env: PLATFORM_API, PLATFORM_API_KEY, WEBHOOK_URL, RECEIVER_PORT, PROVIDER, REFERENCE_IMAGE (a JPEG
 * path; required for aws, optional for mock), CRED_DEF_ID (optional, schema smoke-sdk-biometric).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { env, now, offerAttributes, platformClient, publishCatalogue, sleep, startReceiver } from './platform-common.ts'

const APP = 'com.onetwoid.sample'
const baseUrl = env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')
const api = platformClient(baseUrl, env('PLATFORM_API_KEY'))
const webhookUrl = env('WEBHOOK_URL', 'https://smoke-issuer.12id.naziharitsolution.com/webhook')
const provider = process.env.PROVIDER ?? 'mock'
// ATTACK=1 (aws): step 4 is a presentation attack, a photo of the reference person held up to the camera.
const attack = process.env.ATTACK === '1'
const runId = `sdkbio-${Date.now()}`
const referenceImage = process.env.REFERENCE_IMAGE
  ? readFileSync(process.env.REFERENCE_IMAGE).toString('base64')
  : Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 7)]).toString('base64')
if (provider === 'aws' && !process.env.REFERENCE_IMAGE) throw new Error('PROVIDER=aws needs REFERENCE_IMAGE (a JPEG of the person who will do the check)')

const serial = process.env.ADB_SERIAL ? ['-s', process.env.ADB_SERIAL] : []
const adb = (...args: string[]) => execFileSync('adb', [...serial, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()

type Biometric = { status: string; attemptsRemaining: number; provider: string } | null
interface Dump {
  state: string
  error?: string
  connections?: { id: string; status: string }[]
  offers?: { id: string; attributes: Record<string, string>; biometric: Biometric }[]
  proofRequests?: { id: string; name: string; biometric: Biometric }[]
}

const logLines = (tag = 'onetwoid-sample') => adb('logcat', '-d', '-s', tag).split('\n').map((l) => l.trim())
const dumpLines = () => logLines().filter((l) => l.includes(' dump {'))

async function action(name: string, extras: string[] = [], timeoutMs = 30_000): Promise<Dump> {
  const before = dumpLines().length
  adb('shell', 'am', 'broadcast', '-a', `${APP}.${name}`, '-p', APP, ...extras)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lines = dumpLines()
    if (lines.length > before) {
      const line = lines[lines.length - 1]
      return JSON.parse(line.slice(line.indexOf('dump {') + 5)) as Dump
    }
    await sleep(500)
  }
  throw new Error(`${name}: no dump within ${timeoutMs} ms`)
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined)
    if (value !== undefined) return value
    await sleep(2_000)
  }
  throw new Error(`timed out: ${label}`)
}

/** The sample logs `biometric outcome <exchangeId> <Passed|Failed|Locked> …` after each verifyFace. */
async function faceCheck(exchangeId: string, preset: 'same' | 'other', prompt: string, timeoutMs = 180_000) {
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`)
  await sleep(1_500)
  const before = logLines().filter((l) => l.includes(`biometric outcome ${exchangeId}`)).length
  if (provider === 'aws') console.log(`\n  >>> ON THE PHONE: ${prompt}\n`)
  adb('shell', 'am', 'broadcast', '-a', `${APP}.VERIFY_FACES`, '-p', APP, ...(provider === 'mock' ? ['--es', 'preset', preset] : []))
  return waitFor(`face check ${exchangeId}`, async () => {
    const lines = logLines().filter((l) => l.includes(`biometric outcome ${exchangeId}`))
    return lines.length > before ? lines[lines.length - 1].slice(lines[lines.length - 1].indexOf('biometric outcome')) : undefined
  }, timeoutMs)
}

let passed = false
let secret = ''
const wallets = new Map<string, string>()
const tokenRequests = { count: 0 }
const receiver = startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret, walletBackend: { api, wallets, requests: tokenRequests } })
const checks: Array<[string, boolean, string]> = []
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok, detail])
  console.log(`  [${now()}] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const waitState = (type: string, id: string, state: string, timeoutMs = 120_000) =>
  receiver.waitFor(`${type} ${id} ${state}`, (e) => e.type === type && e.event.data.id === id && e.event.data.state === state, timeoutMs)

try {
  await receiver.listening
  console.log(`device: ${adb('shell', 'getprop', 'ro.product.model')}, Android ${adb('shell', 'getprop', 'ro.build.version.release')}; provider ${provider}`)
  adb('logcat', '-c')
  const endpoint = await api.must<{ secret?: string }>('PUT', '/v1/webhook', { url: webhookUrl })
  secret = endpoint.secret ?? (await api.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret
  // CRED_DEF_ID reuses a published definition of schema smoke-sdk-biometric (publishing can outlast the
  // agent timeout, trap 44 / review M5).
  const catalogue = process.env.CRED_DEF_ID ? { credentialDefinitionLedgerId: process.env.CRED_DEF_ID } : await publishCatalogue(api, 'smoke-sdk-biometric')
  await api.must('PUT', `/v1/credential-definitions/${encodeURIComponent(catalogue.credentialDefinitionLedgerId)}/biometric-policy`, { mode: 'required', maxAttempts: 3 })

  // 1: fresh install
  adb('shell', 'am', 'force-stop', APP)
  adb('shell', 'pm', 'clear', APP)
  await sleep(3_000)
  adb('shell', 'pm', 'grant', APP, 'android.permission.CAMERA')
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`)
  await waitFor('wallet Ready', async () => ((await action('DUMP')).state === 'Ready' ? true : undefined), 120_000)
  check('1 wallet Ready', true, `token requests ${tokenRequests.count}`)

  // 2: connect
  const invitation = await api.must<{ invitationUrl: string }>('POST', '/v1/connections/invitations', { externalId: runId })
  await action('CONNECT', ['--es', 'url', invitation.invitationUrl])
  const connected = await receiver.waitFor('connection completed', (e) => e.type === 'connection.state_changed' && e.event.data.state === 'completed' && e.event.data.externalId === runId, 120_000)
  const connectionId = connected.event.data.id as string
  check('2 connected', true, connectionId.slice(0, 8))

  const offer = (label: string) =>
    api.must<{ id: string; threadId: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: catalogue.credentialDefinitionLedgerId, attributes: offerAttributes(label), externalId: `${runId}-${label}`, biometric: { referenceImage } })
  const pendingOffer = (label: string) =>
    waitFor(`offer ${label} on the phone`, async () => (await action('DUMP')).offers?.find((o) => o.attributes.name?.includes(label)), 120_000)

  // 3: gated offer, refused until the face check passes
  {
    const created = await offer('phone-pass')
    const onPhone = await pendingOffer('phone-pass')
    check('3 the offer carries its requirement', onPhone.biometric?.status === 'Pending' && onPhone.biometric?.provider === (provider === 'aws' ? 'aws-rekognition' : 'mock'), JSON.stringify(onPhone.biometric))
    const refused = await action('ACCEPT_OFFERS')
    check('3 accept is refused before the check', (refused.error ?? '').includes('BiometricRequired'), refused.error ?? 'no error')
    const outcome = await faceCheck(onPhone.id, 'same', 'do the face check as the person in REFERENCE_IMAGE')
    check('3 face check passes', outcome.includes(' Passed'), outcome)
    await action('ACCEPT_OFFERS')
    await waitState('credential.state_changed', created.id, 'done')
    check('3 credential issued after the pass', true)
  }

  // 4: a failed match reports the attempts left
  {
    const created = await offer('phone-fail')
    const onPhone = await pendingOffer('phone-fail')
    const prompt = attack
      ? 'ATTACK: hold a PHOTO of the reference person (printed, or on another phone/screen) in front of the camera; no real face'
      : 'do the face check as SOMEONE ELSE (or hold up a photo)'
    const outcome = await faceCheck(onPhone.id, 'other', prompt)
    check(`4 ${attack ? 'photo attack is refused' : 'face check fails'} with attempts left`, outcome.includes(' Failed') && outcome.includes('attemptsRemaining=2'), outcome)
    const view = await api.must<{ state: string; biometric: { status: string; attemptsRemaining: number; reason: string | null; livenessScore: number | null; matchScore: number | null } }>('GET', `/v1/credentials/${created.id}`)
    check('4 platform keeps it pending', view.biometric.status === 'pending' && view.state === 'offer-sent', `${view.state} ${view.biometric.status} ${view.biometric.attemptsRemaining} reason=${view.biometric.reason} liveness=${view.biometric.livenessScore} match=${view.biometric.matchScore}`)
    await action('DECLINE_OFFERS')
  }

  // 5: gated proof
  {
    const template = await api.must<{ id: string }>('POST', '/v1/proof-templates', {
      name: 'phone biometric proof',
      groups: [{ key: 'employee', attributes: ['name'], credentials: [{ schemaName: 'smoke-sdk-biometric' }] }],
      biometricPolicy: { mode: 'required' },
    })
    const created = await api.must<{ id: string }>('POST', '/v1/proofs/request', { connectionId, templateId: template.id, externalId: `${runId}-proof`, biometric: { referenceImage } })
    const request = await waitFor('proof request on the phone', async () => (await action('DUMP')).proofRequests?.[0], 120_000)
    check('5 the request carries its requirement', request.biometric?.status === 'Pending')
    const outcome = await faceCheck(request.id, 'same', 'do the face check again as the person in REFERENCE_IMAGE')
    check('5 face check passes', outcome.includes(' Passed'), outcome)
    await action('RESPOND_PROOFS')
    const done = await waitState('proof.state_changed', created.id, 'done')
    check('5 verified and disclosed released', done.event.data.verified === true && JSON.stringify(done.event.data.disclosed ?? {}).includes('phone-pass'), JSON.stringify(done.event.data.disclosed))
    const log = await api.must<{ events: Array<{ type: string; vendorSessionId: string | null; matchScore: number | null; livenessScore: number | null }> }>('GET', `/v1/proofs/${created.id}/biometric-log`)
    const attempt = log.events.find((e) => e.type === 'attempt_completed')
    check('6 the attempt is in the log', !!attempt, `liveness ${attempt?.livenessScore} match ${attempt?.matchScore} session ${attempt?.vendorSessionId}`)
  }

  passed = checks.every(([, ok]) => ok)
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  receiver.close()
}
console.log(`\n=== smoke:sdk-biometric-android (${provider}) ${passed ? 'PASSED' : 'FAILED'} (${checks.filter(([, ok]) => ok).length}/${checks.length}) ===`)
process.exit(passed ? 0 : 1)
