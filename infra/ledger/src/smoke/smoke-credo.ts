/**
 * W8 smoke:credo, which is also W5 M1 (TLS): a full issue-credential v1 + present-proof v1
 * round trip against staging.
 *
 * - The issuer is reachable at ISSUER_ENDPOINT (https, through Caddy).
 * - The holder has no inbound transport; everything reaches it through the mediator's
 *   public wss:// endpoint.
 * - Exits 0 only if the proof verifies and no v2 protocol message was exchanged.
 */
import 'reflect-metadata'

// Native bindings before any @credo-ts/* import, including the ones below.
import '../bindings.ts'

import { DidCommCredentialState, DidCommMediatorPickupStrategy, DidCommProofState } from '@credo-ts/didcomm'

import { type SmokeAgent, createSmokeAgent, env, withTimeout } from './agent.ts'
import { createIssuerDid, publishSchemaAndCredentialDefinition } from './ledger-objects.ts'
import { type WireEntry, printWire, recordWire } from './wire-log.ts'

const runId = `smoke-${Date.now()}`
const issuerEndpoint = env('ISSUER_ENDPOINT')
const strategyName = env('PICKUP_STRATEGY', 'PickUpV2LiveMode') as keyof typeof DidCommMediatorPickupStrategy
const pickupStrategy = DidCommMediatorPickupStrategy[strategyName]
if (!pickupStrategy) throw new Error(`unknown PICKUP_STRATEGY ${strategyName}`)

const wire: WireEntry[] = []
const agents: SmokeAgent[] = []

async function run(): Promise<boolean> {
  console.log(`run ${runId}: issuer ${issuerEndpoint}, holder pickup ${pickupStrategy}`)

  const issuer = await createSmokeAgent({
    name: 'smoke-issuer',
    endpoint: issuerEndpoint,
    port: Number(env('ISSUER_PORT')),
  })
  agents.push(issuer)

  // HOLDER_OUTBOUND=http: see SmokeAgentOptions.outbound for why a Credo holder cannot
  // request mediation over WebSocket from a ws-first mediator.
  const holderOutbound = env('HOLDER_OUTBOUND', 'http,ws')
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is 'http' | 'ws' => t === 'http' || t === 'ws')
  console.log('holder outbound transports:', holderOutbound.join(','))

  const holder = await createSmokeAgent({
    name: 'smoke-holder',
    mediatorInvitationUrl: env('MEDIATOR_INVITATION_URL'),
    pickupStrategy,
    outbound: holderOutbound,
  })
  agents.push(holder)

  recordWire(issuer, 'issuer', wire)
  recordWire(holder, 'holder', wire)

  const mediators = await holder.modules.didcomm.mediationRecipient.getMediators()
  console.log(
    'mediation:',
    mediators.map((record) => ({ state: record.state, endpoint: record.endpoint, routingKeys: record.routingKeys.length }))
  )
  if (mediators.length === 0) throw new Error('no mediation record - mediation coordination failed')

  // --- ledger objects ----------------------------------------------------------
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

  // --- connect -----------------------------------------------------------------
  const invitation = await issuer.modules.didcomm.oob.createInvitation({ label: 'smoke-issuer' })
  const invitationUrl = invitation.outOfBandInvitation.toUrl({ domain: issuerEndpoint })
  const received = await holder.modules.didcomm.oob.receiveInvitationFromUrl(invitationUrl, { label: 'smoke-holder' })
  if (!received.connectionRecord) throw new Error('holder created no connection record')

  await holder.modules.didcomm.connections.returnWhenIsConnected(received.connectionRecord.id, { timeoutMs: 60_000 })
  const [issuerConnection] = await issuer.modules.didcomm.connections.findAllByOutOfBandId(invitation.id)
  if (!issuerConnection) throw new Error('issuer has no connection for the invitation')
  await issuer.modules.didcomm.connections.returnWhenIsConnected(issuerConnection.id, { timeoutMs: 60_000 })
  console.log('connected through the mediator')

  // --- issue ---------------------------------------------------------------------
  const credentialDone = new Promise<void>((resolve) => {
    holder.events.observable<any>('DidCommCredentialStateChanged').subscribe((event) => {
      if (event.payload.credentialExchangeRecord.state === DidCommCredentialState.Done) resolve()
    })
  })
  await issuer.modules.didcomm.credentials.offerCredential({
    connectionId: issuerConnection.id,
    protocolVersion: 'v1' as never,
    credentialFormats: {
      indy: {
        credentialDefinitionId,
        attributes: [
          { name: 'name', value: 'Ada Lovelace' },
          { name: 'employeeNumber', value: '1815' },
          { name: 'department', value: 'Analytical Engines' },
        ],
      },
    },
  })
  await withTimeout(credentialDone, 120_000, 'credential done')
  console.log('credential issued through the mediator')

  // --- verify ----------------------------------------------------------------------
  const proofDone = new Promise<{ isVerified?: boolean }>((resolve) => {
    issuer.events.observable<any>('DidCommProofStateChanged').subscribe((event) => {
      if (event.payload.proofRecord.state === DidCommProofState.Done) resolve(event.payload.proofRecord)
    })
  })
  await issuer.modules.didcomm.proofs.requestProof({
    connectionId: issuerConnection.id,
    protocolVersion: 'v1' as never,
    proofFormats: {
      indy: {
        name: 'smoke-proof',
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
  const proofRecord = await withTimeout(proofDone, 120_000, 'proof done')
  console.log('proof isVerified:', proofRecord.isVerified)

  const v1 = wire.filter((e) => /issue-credential\/1|present-proof\/1/.test(e.type)).length
  const v2 = wire.filter((e) => /issue-credential\/2|present-proof\/2/.test(e.type)).length
  return proofRecord.isVerified === true && v1 > 0 && v2 === 0
}

let passed = false
try {
  passed = await run()
} catch (error) {
  console.error('SMOKE FAILED:', error)
} finally {
  printWire(wire)
  // Give in-flight acks a moment before closing stores (Phase 0 saw "Invalid resource handle").
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  for (const agent of agents) await agent.shutdown().catch(() => undefined)
}

console.log(`\n=== smoke:credo ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
