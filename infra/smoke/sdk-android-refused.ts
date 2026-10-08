/**
 * smoke:sdk-android-refused (fork change F10): the sample app on a phone gets real 429s from the edge
 * while it accepts credential offers, and every credential is still issued.
 *
 * Precondition, set by hand for the run and removed afterwards: the agent's per-address limit lowered to
 * 2 per 10 s on the environment (`EDGE_AGENT_LIMIT=2` in infra/env/<env>.env, then `deploy.sh edge`).
 * The script checks it from this machine first and stops when the limit is not lowered.
 *
 * Steps: 1 fresh install → Ready; 2 connect; 3 EXPECT + three offers → all pending → accept all at once.
 * The three credential requests and the acknowledgements go to the agent inside a few seconds, so the
 * edge refuses some of them. Pass: the three credentials reach `done` and are stored in the app, and the
 * edge counted at least one refused agent request while the app was accepting (Caddy's own counter, read
 * on the VM over SSH). The app's log lines for a request sent again are printed too, but they are not part
 * of the verdict: the sample includes the AWS add-on, which brings slf4j 2, and the SDK's slf4j 1.7 binding
 * is then not loaded, so the framework's lines do not reach the app log.
 *
 * Plumbing and env as smoke/sdk-android.ts (the `-R 3200:127.0.0.1:3201` tunnel, PLATFORM_API_KEY,
 * PLATFORM_TENANT_ID, CRED_DEF_ID optional), plus AGENT_URL (default https://agent.12id.naziharitsolution.com/)
 * and VM_SSH / VM_SSH_KEY as in platform-common.ts.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { consoleClient, env, now, offerAttributes, platformClient, publishCatalogue, sleep, startReceiver } from './platform-common.ts'

const APP = 'com.onetwoid.sample'
const OFFERS = 3
const baseUrl = env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')
const agentUrl = env('AGENT_URL', 'https://agent.12id.naziharitsolution.com/')
const api = platformClient(baseUrl, env('PLATFORM_API_KEY'))
const setup = consoleClient()
const webhookUrl = env('WEBHOOK_URL', 'https://smoke-issuer.12id.naziharitsolution.com/webhook')
const externalId = `sdk-refused-${Date.now()}`
const serial = process.env.ADB_SERIAL ? ['-s', process.env.ADB_SERIAL] : []
// Asynchronous adb: this process also serves the webhook receiver and the stand-in customer backend.
const execFileAsync = promisify(execFile)
const adb = async (...args: string[]) =>
  (await execFileAsync('adb', [...serial, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout.trim()

interface Dump {
  state: string
  error?: string
  offers?: { id: string }[]
  credentials?: { id: string }[]
}

const sampleLines = async () => (await adb('logcat', '-d', '-s', 'onetwoid-sample')).split('\n').map((l) => l.trim())
const dumpLines = async () => (await sampleLines()).filter((l) => l.includes(' dump {'))
const sdkLines = async () => (await adb('logcat', '-d', '-s', 'onetwoid-sdk')).split('\n').map((l) => l.trim())

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

async function waitForDump(label: string, done: (d: Dump) => boolean, timeoutMs: number): Promise<Dump> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dump = await action('DUMP').catch(() => undefined)
    if (dump?.state === 'Failed') throw new Error(`wallet failed: ${dump.error}`)
    if (dump && done(dump)) return dump
    await sleep(1_000)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Agent requests the edge has refused since it started: Caddy's counter, read on the VM (no scrape delay). */
async function declinedAtEdge(): Promise<number> {
  const target = env('VM_SSH', 'ubuntu@123.176.58.72')
  const key = env('VM_SSH_KEY', `${homedir()}/.ssh/12id_staging_ed25519`)
  const { stdout } = await execFileAsync('ssh', ['-i', key, '-o', 'BatchMode=yes', target, 'curl -s 127.0.0.1:2019/metrics'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return stdout
    .split('\n')
    .filter((l) => l.startsWith('caddy_rate_limit_declined_requests_total') && l.includes('zone="agent_per_ip"'))
    .reduce((sum, l) => sum + Number(l.slice(l.lastIndexOf(' ') + 1)), 0)
}

/** Four requests at once from this machine's own address: with the limit at 2 per 10 s, some are refused. */
async function limitIsLowered(): Promise<boolean> {
  const statuses = await Promise.all(
    [1, 2, 3, 4].map(() => fetch(agentUrl, { method: 'POST', headers: { 'content-type': 'application/didcomm-envelope-enc' }, body: '{}' }).then((r) => r.status)),
  )
  console.log(`  limit check from this machine: ${statuses.join(', ')}`)
  return statuses.includes(429)
}

let passed = false
let stayOnBefore = ''
let secret = ''
const wallets = new Map<string, string>()
const receiver = startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret, walletBackend: { api, wallets, requests: { count: 0 } } })

try {
  await receiver.listening
  console.log(`device: ${await adb('shell', 'getprop', 'ro.product.model')}, Android ${await adb('shell', 'getprop', 'ro.build.version.release')}`)
  if (!(await limitIsLowered())) throw new Error('the agent limit is not lowered: set EDGE_AGENT_LIMIT=2 and deploy the edge (see the header)')
  await adb('logcat', '-c').catch(() => undefined)
  stayOnBefore = await adb('shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in').catch(() => '')
  await adb('shell', 'svc', 'power', 'stayon', 'true').catch(() => undefined)
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  const endpoint = await setup.must<{ secret?: string }>('PUT', '/v1/webhook', { url: webhookUrl })
  secret = endpoint.secret ?? (await setup.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret
  const credDefId = process.env.CRED_DEF_ID ?? (await publishCatalogue(setup, 'smoke-badge')).credentialDefinitionLedgerId

  console.log('\n=== 1 ONBOARDING (fresh install) ===')
  await adb('shell', 'am', 'force-stop', APP)
  await adb('shell', 'pm', 'clear', APP)
  await sleep(3_000)
  await adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`)
  await waitForDump('Ready', (d) => d.state === 'Ready', 120_000)
  console.log(`  [${now()}] wallet Ready`)

  console.log('\n=== 2 CONNECT ===')
  const invitation = await api.must<{ invitationId: string; invitationUrl: string }>('POST', '/v1/connections/invitations', { externalId })
  await action('CONNECT', ['--es', 'url', invitation.invitationUrl], 60_000)
  const connected = await receiver.waitFor('connection completed', (e) => e.type === 'connection.state_changed' && e.event.data.invitationId === invitation.invitationId && e.event.data.state === 'completed', 120_000)
  const connectionId = connected.event.data.id as string
  console.log(`  [${now()}] connected ${connectionId.slice(0, 8)}`)
  // Let the handshake's own requests leave the edge's 10 s window.
  await sleep(12_000)

  console.log(`\n=== 3 ${OFFERS} OFFERS ACCEPTED AT ONCE, the agent refusing more than 2 requests per 10 s ===`)
  await action('EXPECT', ['--ei', 'seconds', '60'])
  const offers: { id: string }[] = []
  for (let i = 1; i <= OFFERS; i++) {
    offers.push(await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId, credentialDefinitionId: credDefId, attributes: offerAttributes(`refused-${i}`), externalId }))
  }
  // Each new offer ends the window; ask again until all are in the app.
  const deadline = Date.now() + 90_000
  while (((await action('DUMP')).offers?.length ?? 0) < OFFERS) {
    if (Date.now() > deadline) throw new Error('the offers did not all reach the app')
    await action('EXPECT', ['--ei', 'seconds', '10'])
    await sleep(3_000)
  }
  console.log(`  [${now()}] ${OFFERS} offers pending in the app; waiting for a quiet edge window`)
  await sleep(12_000)
  const declinedBefore = await declinedAtEdge()
  const acceptedAt = Date.now()
  // acceptOffer waits inside the SDK while a refused request is sent again, so this takes a while.
  await action('ACCEPT_OFFERS', [], 120_000)
  console.log(`  [${now()}] accept returned after ${((Date.now() - acceptedAt) / 1000).toFixed(1)} s`)
  const states: string[] = []
  for (const offer of offers) {
    const hit = await receiver.waitFor(`credential ${offer.id.slice(0, 8)} done|abandoned`, (e) => e.type === 'credential.state_changed' && e.event.data.id === offer.id && ['done', 'abandoned'].includes(String(e.event.data.state)), 180_000)
    states.push(String(hit.event.data.state))
  }
  const total = ((Date.now() - acceptedAt) / 1000).toFixed(1)
  const stored = (await action('DUMP')).credentials?.length ?? 0
  const declined = (await declinedAtEdge()) - declinedBefore

  const log = await sdkLines()
  const retried = log.filter((l) => l.includes('HTTP 429 from'))
  const refused = log.filter((l) => l.includes('Outbound message refused'))
  const badSignatures = receiver.events.filter((e) => !e.signatureValid).length
  console.log('\n=== smoke:sdk-android-refused results ===')
  console.log(`credentials     : ${states.join(', ')} (${total} s after the accept); stored in the app: ${stored}`)
  console.log(`refused at edge : ${declined} agent request(s) while the app was accepting`)
  console.log(`sent again      : ${retried.length} line(s) in the app log (none when slf4j 2 is on the classpath, see the header)`)
  for (const line of retried) console.log(`    ${line.slice(line.indexOf('HTTP 429'))}`)
  console.log(`given up        : ${refused.length} line(s) in the app log`)
  for (const line of refused) console.log(`    ${line.slice(line.indexOf('Outbound message refused'))}`)
  console.log(`signatures      : ${badSignatures === 0 ? 'all valid' : `${badSignatures} INVALID`}`)
  console.log(`externalId      : ${externalId}`)
  passed = states.every((s) => s === 'done') && stored === OFFERS && declined > 0 && refused.length === 0 && badSignatures === 0
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  receiver.close()
  if (stayOnBefore === '0') await adb('shell', 'svc', 'power', 'stayon', 'false').catch(() => undefined)
  const logFile = process.env.APP_LOG_OUT ?? 'smoke/sdk-android-refused.last.log'
  try {
    writeFileSync(logFile, await adb('logcat', '-d', '-s', 'onetwoid-sample', 'onetwoid-sdk', 'AndroidRuntime'))
    console.log(`app log saved to ${logFile}`)
  } catch (error) {
    console.log(`app log not saved: ${error}`)
  }
}
console.log(`\n=== smoke:sdk-android-refused ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
