/**
 * smoke:tenant-android (Phase 2 A11): the native Kotlin holder on a phone against a TENANT
 * issuer on staging, driven only through agent-service's internal API.
 *
 * Plumbing (both SSH tunnels to the VM):
 *   -L 13410:127.0.0.1:3410   agent-service internal API          (AGENT_API)
 *   -R 3200:127.0.0.1:3201    Caddy smoke-issuer -> this process   (serves the invitation once)
 * The app (Phase 0 sample, PickUpV1, staging genesis + mediator) fetches
 * https://smoke-issuer.<domain>/phase0/invitation on a fresh launch.
 *
 * Scenario (Phase 0 S7 / Phase 1 W8, now on a tenant): connect, LIVE offer, OFFLINE offer
 * (app force-stopped, queued at the mediator, collected on reopen), PROOF with the mandatory
 * expiresOn predicate. No Credo runs on this machine; only fetch + adb.
 *
 * Env: TENANT_ID, CRED_DEF_OBJECT_ID, CRED_DEF_ID (unqualified), AGENT_API, INVITE_PORT.
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'

const APP = 'org.hyperledger.ariesproject'
const api = process.env.AGENT_API ?? 'http://127.0.0.1:13410'
const invitePort = Number(process.env.INVITE_PORT ?? 3201)
const tenantId = must('TENANT_ID')
const credDefObjectId = must('CRED_DEF_OBJECT_ID')
const credDefId = must('CRED_DEF_ID')
const correlationId = `android-${Date.now()}`

function must(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}
const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const adb = (...args: string[]) => execFileSync('adb', args, { encoding: 'utf8' }).trim()

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = (await response.json()) as T
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${JSON.stringify(json)}`)
  return json
}

async function pollState(path: string, target: string[], timeoutMs: number, label: string): Promise<{ state: string; isVerified?: boolean | null; disclosed?: unknown }> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const record = await call<{ state: string; isVerified?: boolean | null; disclosed?: unknown }>('GET', path)
    if (record.state !== last) {
      console.log(`  [${now()}] ${label} -> ${record.state}`)
      last = record.state
    }
    if (target.includes(record.state)) return record
    await sleep(1_000)
  }
  return { state: `TIMEOUT (last ${last})` }
}

async function offer(connectionId: string, label: string) {
  return call<{ credentialExchangeId: string; threadId: string }>('POST', `/tenants/${tenantId}/credentials/offer`, {
    connectionId,
    credentialDefinitionObjectId: credDefObjectId,
    values: {
      name: `Ada Lovelace (${label})`,
      employeeNumber: '1815',
      department: 'Analytical Engines',
      expiresOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10).replaceAll('-', ''),
    },
    correlationId,
  })
}

let passed = false
let server: ReturnType<typeof createServer> | undefined
try {
  console.log(`device: ${adb('shell', 'getprop', 'ro.product.model')}, Android ${adb('shell', 'getprop', 'ro.build.version.release')}`)
  const ready = await call<{ ready: boolean }>('GET', '/readyz')
  if (!ready.ready) throw new Error('agent-service not ready')

  // --- invitation, served once -----------------------------------------------------------
  const invitation = await call<{ outOfBandId: string; invitationUrl: string }>('POST', `/tenants/${tenantId}/invitations`, { correlationId })
  let served = false
  server = createServer((request, response) => {
    if (request.url !== '/phase0/invitation' || served) {
      response.writeHead(404).end('no')
      return
    }
    served = true
    console.log(`  [${now()}] app fetched the invitation`)
    response.writeHead(200, { 'content-type': 'text/plain' }).end(invitation.invitationUrl)
  })
  await new Promise<void>((resolve) => server!.listen(invitePort, '127.0.0.1', resolve))

  // --- connect ---------------------------------------------------------------------------
  adb('shell', 'am', 'force-stop', APP)
  adb('shell', 'pm', 'clear', APP)
  adb('shell', 'am', 'start', '-n', `${APP}/.WalletMainActivity`)
  console.log(`  [${now()}] app launched with a fresh wallet`)
  let connectionId: string | undefined
  for (const deadline = Date.now() + 180_000; !connectionId && Date.now() < deadline; ) {
    const connections = await call<Array<{ id: string; state: string }>>('GET', `/tenants/${tenantId}/connections?outOfBandId=${invitation.outOfBandId}`)
    connectionId = connections.find((c) => c.state === 'completed')?.id
    if (!connectionId) await sleep(2_000)
  }
  if (!connectionId) throw new Error('app did not connect within 180s')
  console.log(`  [${now()}] connected: ${connectionId}`)

  // --- live ------------------------------------------------------------------------------
  console.log('\n=== LIVE: offer while the app is running ===')
  const live = await offer(connectionId, 'live')
  const liveResult = await pollState(`/tenants/${tenantId}/credentials/${live.credentialExchangeId}`, ['done', 'abandoned'], 120_000, 'live credential')

  // --- offline ---------------------------------------------------------------------------
  console.log('\n=== OFFLINE: force-stop, offer, reopen ===')
  adb('shell', 'am', 'force-stop', APP)
  console.log(`  [${now()}] app force-stopped`)
  const offline = await offer(connectionId, 'offline')
  console.log(`  [${now()}] offer sent while the app was closed`)
  await sleep(15_000)
  adb('shell', 'am', 'start', '-n', `${APP}/.WalletMainActivity`)
  const reopenedAt = Date.now()
  console.log(`  [${now()}] app reopened`)
  const offlineResult = await pollState(`/tenants/${tenantId}/credentials/${offline.credentialExchangeId}`, ['done', 'abandoned'], 180_000, 'offline credential')
  const offlineLatency = offlineResult.state === 'done' ? `(${((Date.now() - reopenedAt) / 1000).toFixed(1)} s after reopen)` : ''

  // --- proof -----------------------------------------------------------------------------
  console.log('\n=== PROOF (attributes + the mandatory expiresOn predicate) ===')
  const proof = await call<{ proofExchangeId: string }>('POST', `/tenants/${tenantId}/proofs/request`, {
    connectionId,
    name: 'smoke-tenant-android',
    groups: [{ key: 'employee', attributes: ['name', 'department'], credentialDefinitionIds: [credDefId] }],
    correlationId,
  })
  const proofResult = await pollState(`/tenants/${tenantId}/proofs/${proof.proofExchangeId}`, ['done', 'abandoned'], 120_000, 'proof')

  console.log('\n=== smoke:tenant-android results ===')
  console.log('live credential   :', liveResult.state)
  console.log('offline credential:', offlineResult.state, offlineLatency)
  console.log('proof             :', proofResult.state, `isVerified=${proofResult.isVerified}`, JSON.stringify(proofResult.disclosed ?? {}))
  console.log('correlationId     :', correlationId)
  passed = liveResult.state === 'done' && offlineResult.state === 'done' && proofResult.state === 'done' && proofResult.isVerified === true
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  server?.close()
}
console.log(`\n=== smoke:tenant-android ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
