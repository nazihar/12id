/**
 * W8 smoke:android: the native Kotlin holder against the staging edge.
 *
 * The phone (Phase 0 sample app, PickUpV1) reaches:
 * - the staging mediator over wss:// (the holder path smoke:credo cannot cover);
 * - the issuer over https://smoke-issuer.<domain>;
 * - the ledger client ports and the public signed genesis.
 *
 * The issuer runs on this machine, next to adb, and is published through an SSH reverse
 * tunnel: Caddy smoke-issuer -> VM 127.0.0.1:ISSUER_PORT -> this machine.
 *
 * Scenario (Phase 0 S7, on staging):
 *  1. Fresh wallet, launch the app; it fetches the issuer invitation once and connects.
 *  2. LIVE: offer a credential while the app runs.
 *  3. OFFLINE: force-stop the app, offer, wait, reopen; the queued offer must be collected.
 *  4. PROOF: request a presentation on the same connection.
 * Exits 0 only if all three complete and no v2 protocol message was exchanged.
 */
import 'reflect-metadata'

// Native bindings before any @credo-ts/* import.
import '../bindings.ts'

import { execFileSync } from 'node:child_process'

import { DidCommCredentialState, DidCommProofState } from '@credo-ts/didcomm'
import express from 'express'

import { type SmokeAgent, createSmokeAgent, env } from './agent.ts'
import { createIssuerDid, publishSchemaAndCredentialDefinition } from './ledger-objects.ts'
import { type WireEntry, printWire, recordWire } from './wire-log.ts'

const APP = 'org.hyperledger.ariesproject'
const runId = `smoke-android-${Date.now()}`
const issuerEndpoint = env('ISSUER_ENDPOINT')
const wire: WireEntry[] = []
const agents: SmokeAgent[] = []

const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function adb(...args: string[]) {
  return execFileSync('adb', args, { encoding: 'utf8' }).trim()
}

async function waitForConnection(issuer: SmokeAgent, outOfBandId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [connection] = await issuer.modules.didcomm.connections.findAllByOutOfBandId(outOfBandId)
    if (connection?.isReady) return connection
    await sleep(2_000)
  }
  throw new Error(`app did not connect within ${timeoutMs / 1000}s`)
}

function waitForCredential(issuer: SmokeAgent, threadId: string, timeoutMs: number) {
  return new Promise<'DONE' | 'TIMEOUT'>((resolve) => {
    const timer = setTimeout(() => {
      subscription.unsubscribe()
      resolve('TIMEOUT')
    }, timeoutMs)
    const subscription = issuer.events.observable<any>('DidCommCredentialStateChanged').subscribe((event) => {
      const record = event.payload.credentialExchangeRecord
      if (record.threadId !== threadId) return
      console.log(`  [${now()}] credential ${threadId.slice(0, 8)} -> ${record.state}`)
      if (record.state === DidCommCredentialState.Done) {
        clearTimeout(timer)
        subscription.unsubscribe()
        resolve('DONE')
      }
    })
  })
}

async function offer(issuer: SmokeAgent, connectionId: string, credentialDefinitionId: string, label: string) {
  return issuer.modules.didcomm.credentials.offerCredential({
    connectionId,
    protocolVersion: 'v1' as never,
    credentialFormats: {
      indy: {
        credentialDefinitionId,
        attributes: [
          { name: 'name', value: `Ada Lovelace (${label})` },
          { name: 'employeeNumber', value: '1815' },
          { name: 'department', value: 'Analytical Engines' },
        ],
      },
    },
  })
}

async function run(): Promise<boolean> {
  console.log(`run ${runId}: issuer ${issuerEndpoint}`)
  console.log(`device: ${adb('shell', 'getprop', 'ro.product.model')}, Android ${adb('shell', 'getprop', 'ro.build.version.release')}`)

  const app = express()
  const issuer = await createSmokeAgent({
    name: 'smoke-issuer',
    endpoint: issuerEndpoint,
    port: Number(env('ISSUER_PORT')),
    app,
  })
  agents.push(issuer)
  recordWire(issuer, 'issuer', wire)

  const identity = await createIssuerDid(issuer, {
    namespace: env('INDY_NAMESPACE'),
    registerUrl: env('LEDGER_REGISTER_URL'),
    alias: runId,
  })
  const published = await publishSchemaAndCredentialDefinition(issuer, {
    issuerId: identity.did,
    schemaName: runId,
    attributes: ['name', 'employeeNumber', 'department'],
  })
  const credentialDefinitionId = published.unqualifiedCredentialDefinitionId
  console.log('issuer DID:', identity.did)
  console.log('cred def (unqualified, used on the wire):', credentialDefinitionId)

  // The invitation is served exactly once, so a relaunched app cannot open a second connection.
  const invitation = await issuer.modules.didcomm.oob.createInvitation({ label: 'smoke-issuer' })
  const invitationUrl = invitation.outOfBandInvitation.toUrl({ domain: issuerEndpoint })
  let served = false
  app.get('/phase0/invitation', (_req, res) => {
    if (served) {
      res.status(404).send('already served')
      return
    }
    served = true
    console.log(`  [${now()}] app fetched the invitation`)
    res.type('text/plain').send(invitationUrl)
  })

  // --- connect -----------------------------------------------------------------------
  adb('shell', 'am', 'force-stop', APP)
  adb('shell', 'pm', 'clear', APP)
  adb('shell', 'am', 'start', '-n', `${APP}/.WalletMainActivity`)
  console.log(`  [${now()}] app launched with a fresh wallet`)

  const connection = await waitForConnection(issuer, invitation.id, 180_000)
  console.log(`  [${now()}] connected: ${connection.id}`)

  // --- live ----------------------------------------------------------------------------
  console.log('\n=== LIVE: offer while the app is running ===')
  const liveRecord = await offer(issuer, connection.id, credentialDefinitionId, 'live')
  const liveResult = await waitForCredential(issuer, liveRecord.threadId, 120_000)
  console.log('LIVE result:', liveResult)

  // --- offline -------------------------------------------------------------------------
  console.log('\n=== OFFLINE: force-stop, offer, reopen ===')
  adb('shell', 'am', 'force-stop', APP)
  console.log(`  [${now()}] app force-stopped`)
  const offlineRecord = await offer(issuer, connection.id, credentialDefinitionId, 'offline')
  console.log(`  [${now()}] offer sent while the app was closed`)
  await sleep(15_000)
  adb('shell', 'am', 'start', '-n', `${APP}/.WalletMainActivity`)
  const reopenedAt = Date.now()
  console.log(`  [${now()}] app reopened`)
  const offlineResult = await waitForCredential(issuer, offlineRecord.threadId, 180_000)
  console.log(
    'OFFLINE result:',
    offlineResult,
    offlineResult === 'DONE' ? `(${((Date.now() - reopenedAt) / 1000).toFixed(1)} s after reopen)` : ''
  )

  // --- proof ---------------------------------------------------------------------------
  let proofResult = 'SKIPPED'
  if (liveResult === 'DONE' || offlineResult === 'DONE') {
    console.log('\n=== PROOF ===')
    const proofDone = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('TIMEOUT'), 120_000)
      issuer.events.observable<any>('DidCommProofStateChanged').subscribe((event) => {
        const record = event.payload.proofRecord
        if (record.connectionId === connection.id && record.state === DidCommProofState.Done) {
          clearTimeout(timer)
          resolve(`DONE isVerified=${record.isVerified}`)
        }
      })
    })
    await issuer.modules.didcomm.proofs.requestProof({
      connectionId: connection.id,
      protocolVersion: 'v1' as never,
      proofFormats: {
        indy: {
          name: 'smoke-android-proof',
          version: '1.0',
          requested_attributes: {
            employee: {
              names: ['name', 'employeeNumber'],
              restrictions: [{ cred_def_id: credentialDefinitionId }],
            },
          },
        },
      },
    })
    proofResult = await proofDone
  }

  const v1 = wire.filter((e) => /issue-credential\/1|present-proof\/1/.test(e.type)).length
  const v2 = wire.filter((e) => /issue-credential\/2|present-proof\/2/.test(e.type)).length

  console.log('\n=== smoke:android results (native holder, staging edge) ===')
  console.log('live credential   :', liveResult)
  console.log('offline credential:', offlineResult)
  console.log('proof             :', proofResult)
  console.log(`v1 messages: ${v1}, v2 messages: ${v2}`)

  return liveResult === 'DONE' && offlineResult === 'DONE' && proofResult === 'DONE isVerified=true' && v2 === 0
}

let passed = false
try {
  passed = await run()
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  printWire(wire)
  await sleep(3_000)
  for (const agent of agents) await agent.shutdown().catch(() => undefined)
}

console.log(`\n=== smoke:android ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
