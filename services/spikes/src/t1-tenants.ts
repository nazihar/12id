/**
 * Spike T1 (7-phase-2.md): two tenants in one Credo 0.7.0 root agent on Postgres
 * (ProfilePerWallet), each onboarded with the T2 author/endorser flow, each issuing and
 * verifying a v1 credential to ONE Credo holder behind the staging mediator, concurrently.
 *
 * Checks:
 *   - one inbound endpoint routes each message to the right tenant;
 *   - root-level DIDComm config (v1 only, did:sov prefix, auto-accept) applies in tenants;
 *   - events reach the root emitter tagged `tenant-<tenantId>`;
 *   - each tenant sees only its own connection.
 *
 * Env: MEDIATOR_INVITATION_FILE (required), SSH tunnel for LEDGER_REGISTER_URL, local Postgres.
 */
import './bindings.ts'

import { randomBytes } from 'node:crypto'

import { DidCommCredentialState, DidCommProofState } from '@credo-ts/didcomm'

import {
  createEndorserAgent,
  createHolderAgent,
  createRootAgent,
  createSpikeEndorserDid,
  type HolderAgent,
  type RootAgent,
  withTimeout,
} from './common.ts'
import { type OnboardedTenant, onboardTenant } from './ledger.ts'
import { type WireEntry, printWire, recordWire } from './wire-log.ts'

const runId = `p2t1${Date.now()}`
const endpoint = 'http://127.0.0.1:3500'
const wire: WireEntry[] = []
const cleanup: Array<() => Promise<unknown>> = []

interface EventSeen {
  type: string
  context: string
  state: string
  recordId: string
  threadId?: string
}
const rootEvents: EventSeen[] = []

async function runTenant(root: RootAgent, holder: HolderAgent, tenant: OnboardedTenant) {
  const context = `tenant-${tenant.tenantId}`

  // --- connect ---------------------------------------------------------------------
  const invitation = await root.modules.tenants.withTenantAgent({ tenantId: tenant.tenantId }, async (t) => {
    const agent = t as unknown as RootAgent
    const oob = await agent.modules.didcomm.oob.createInvitation({ label: tenant.label })
    return { id: oob.id, url: oob.outOfBandInvitation.toUrl({ domain: endpoint }) }
  })
  const received = await holder.modules.didcomm.oob.receiveInvitationFromUrl(invitation.url, { label: 'spike-holder' })
  if (!received.connectionRecord) throw new Error(`${tenant.label}: holder created no connection record`)
  const holderConnectionId = received.connectionRecord.id
  await holder.modules.didcomm.connections.returnWhenIsConnected(holderConnectionId, { timeoutMs: 90_000 })

  const tenantConnectionId = await root.modules.tenants.withTenantAgent({ tenantId: tenant.tenantId }, async (t) => {
    const agent = t as unknown as RootAgent
    const deadline = Date.now() + 90_000
    for (;;) {
      const [connection] = await agent.modules.didcomm.connections.findAllByOutOfBandId(invitation.id)
      if (connection) {
        await agent.modules.didcomm.connections.returnWhenIsConnected(connection.id, { timeoutMs: 90_000 })
        return connection.id
      }
      if (Date.now() > deadline) throw new Error(`${tenant.label}: tenant has no connection for its invitation`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })
  console.log(`[${tenant.label}] connected (tenant connection ${tenantConnectionId})`)

  // --- issue -------------------------------------------------------------------------
  const credentialDone = new Promise<void>((resolve) => {
    holder.events.observable<any>('DidCommCredentialStateChanged').subscribe((event) => {
      const record = event.payload.credentialExchangeRecord
      if (record.connectionId === holderConnectionId && record.state === DidCommCredentialState.Done) resolve()
    })
  })
  const expiresAt = String(Math.floor(Date.now() / 1000) + 30 * 24 * 3600)
  await root.modules.tenants.withTenantAgent({ tenantId: tenant.tenantId }, async (t) => {
    const agent = t as unknown as RootAgent
    await agent.modules.didcomm.credentials.offerCredential({
      connectionId: tenantConnectionId,
      protocolVersion: 'v1' as never,
      credentialFormats: {
        indy: {
          credentialDefinitionId: tenant.unqualifiedCredentialDefinitionId,
          attributes: [
            { name: 'name', value: `Holder of ${tenant.label}` },
            { name: 'employeeNumber', value: '1815' },
            { name: 'expiresAt', value: expiresAt },
          ],
        },
      },
    })
  })
  await withTimeout(credentialDone, 180_000, `${tenant.label} credential done`)
  console.log(`[${tenant.label}] credential issued through the mediator`)

  // --- verify ------------------------------------------------------------------------
  const proofDone = new Promise<{ isVerified?: boolean }>((resolve) => {
    root.events.observable<any>('DidCommProofStateChanged').subscribe((event) => {
      if (event.metadata?.contextCorrelationId !== context) return
      if (event.payload.proofRecord.state === DidCommProofState.Done) resolve(event.payload.proofRecord)
    })
  })
  await root.modules.tenants.withTenantAgent({ tenantId: tenant.tenantId }, async (t) => {
    const agent = t as unknown as RootAgent
    await agent.modules.didcomm.proofs.requestProof({
      connectionId: tenantConnectionId,
      protocolVersion: 'v1' as never,
      proofFormats: {
        indy: {
          name: `${tenant.label}-proof`,
          version: '1.0',
          requested_attributes: {
            employee: { names: ['name', 'employeeNumber'], restrictions: [{ cred_def_id: tenant.unqualifiedCredentialDefinitionId }] },
          },
          // The mandatory expiry predicate (4-init §4.7).
          requested_predicates: {
            notExpired: {
              name: 'expiresAt',
              p_type: '>=',
              p_value: Math.floor(Date.now() / 1000),
              restrictions: [{ cred_def_id: tenant.unqualifiedCredentialDefinitionId }],
            },
          },
        },
      },
    })
  })
  const proof = await withTimeout(proofDone, 180_000, `${tenant.label} proof done`)
  console.log(`[${tenant.label}] proof isVerified: ${proof.isVerified}`)

  const connectionsInTenant = await root.modules.tenants.withTenantAgent({ tenantId: tenant.tenantId }, async (t) => {
    const agent = t as unknown as RootAgent
    return (await agent.modules.didcomm.connections.getAll()).length
  })
  return { label: tenant.label, context, isVerified: proof.isVerified === true, connectionsInTenant }
}

let passed = false
try {
  const endorser = await createEndorserAgent()
  cleanup.push(() => endorser.shutdown())
  const endorserIdentity = await createSpikeEndorserDid(endorser, `${runId}-endorser`)
  console.log('spike endorser DID:', endorserIdentity.did)

  const root = await createRootAgent({ storeId: `spike_${runId}`, storeKey: randomBytes(32).toString('base64url'), endpoint, port: 3500 })
  cleanup.push(() => root.shutdown())
  for (const type of ['DidCommConnectionStateChanged', 'DidCommCredentialStateChanged', 'DidCommProofStateChanged']) {
    root.events.observable<any>(type).subscribe((event) => {
      const record = event.payload.connectionRecord ?? event.payload.credentialExchangeRecord ?? event.payload.proofRecord
      rootEvents.push({
        type,
        context: event.metadata?.contextCorrelationId,
        state: record?.state,
        recordId: record?.id,
        threadId: record?.threadId,
      })
    })
  }

  const tenants: OnboardedTenant[] = []
  for (const name of ['a', 'b']) {
    tenants.push(
      await onboardTenant(root, endorser, endorserIdentity.did, {
        label: `${runId}-tenant-${name}`,
        schemaName: `${runId}-badge-${name}`,
        attributes: ['name', 'employeeNumber', 'expiresAt'],
      })
    )
    console.log(`onboarded ${tenants.at(-1)?.label}: ${tenants.at(-1)?.did} cred def ${tenants.at(-1)?.unqualifiedCredentialDefinitionId}`)
  }

  const holder = await createHolderAgent('spike-holder')
  cleanup.push(() => holder.shutdown())
  const mediators = await holder.modules.didcomm.mediationRecipient.getMediators()
  if (mediators.length === 0) throw new Error('holder has no mediation record')
  console.log('holder mediation:', mediators.map((m) => ({ state: m.state, endpoint: m.endpoint })))

  recordWire(root, 'root', wire)
  recordWire(holder, 'holder', wire)

  // Both tenants concurrently: shared endpoint, shared holder.
  const results = await Promise.all(tenants.map((tenant) => runTenant(root, holder, tenant)))
  console.log('\nresults:', JSON.stringify(results, null, 2))

  const tenantContexts = new Set(tenants.map((t) => `tenant-${t.tenantId}`))
  const exchangeEvents = rootEvents.filter((e) => e.type !== 'DidCommConnectionStateChanged' || e.context !== 'default')
  const contexts = [...new Set(rootEvents.map((e) => e.context))]
  const untagged = exchangeEvents.filter((e) => !tenantContexts.has(e.context))
  console.log('\nevent contexts seen on the root emitter:', contexts)
  console.log('credential/proof/connection events not tagged with a tenant context:', untagged.length)
  for (const tenant of tenants) {
    const seen = rootEvents.filter((e) => e.context === `tenant-${tenant.tenantId}`)
    console.log(`  ${tenant.label}: ${seen.length} events`, seen.map((e) => `${e.type.replace('DidComm', '').replace('StateChanged', '')}:${e.state}`).join(' '))
  }

  const { v1, v2 } = printWire(wire)
  passed = results.every((r) => r.isVerified && r.connectionsInTenant === 1) && untagged.length === 0 && v1 > 0 && v2 === 0
} catch (error) {
  console.error('T1 FAILED:', error)
} finally {
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined)
}

console.log(`\n=== T1 ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
