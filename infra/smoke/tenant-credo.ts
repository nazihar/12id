/**
* smoke:tenant-credo (Phase 2 A11). Drives agent-service ONLY through its internal API (SSH tunnel to
 * 127.0.0.1:3410 on the VM) with a Credo holder behind the staging mediator.
 * Original: drive a running agent-service ONLY through its internal API with a Credo
 * holder behind the staging mediator. invitation → connect → offer → proof, then read the
 * exchange states back and dump the outbox rows.
 *
 * Env: AGENT_API (default http://127.0.0.1:3410), TENANT_ID, CRED_DEF_OBJECT_ID, CRED_DEF_ID
 * (unqualified), MEDIATOR_INVITATION_FILE.
 */
import './bindings.ts'

import { DidCommCredentialState, DidCommProofState } from '@credo-ts/didcomm'

import { createHolderAgent, env, withTimeout } from './common.ts'

const api = env('AGENT_API', 'http://127.0.0.1:3410')
const tenantId = env('TENANT_ID')
const credDefObjectId = env('CRED_DEF_OBJECT_ID')
const credDefId = env('CRED_DEF_ID')
const correlationId = `corr-${Date.now()}`

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

let passed = false
const holder = await createHolderAgent('a5-holder')
try {
  const invitation = await call<{ outOfBandId: string; invitationUrl: string }>('POST', `/tenants/${tenantId}/invitations`, { correlationId })
  const received = await holder.modules.didcomm.oob.receiveInvitationFromUrl(invitation.invitationUrl, { label: 'a5-holder' })
  if (!received.connectionRecord) throw new Error('no holder connection')
  await holder.modules.didcomm.connections.returnWhenIsConnected(received.connectionRecord.id, { timeoutMs: 90_000 })

  let connectionId: string | undefined
  for (const deadline = Date.now() + 60_000; !connectionId && Date.now() < deadline; ) {
    const connections = await call<Array<{ id: string; state: string }>>('GET', `/tenants/${tenantId}/connections?outOfBandId=${invitation.outOfBandId}`)
    connectionId = connections.find((c) => c.state === 'completed')?.id
    if (!connectionId) await new Promise((r) => setTimeout(r, 1000))
  }
  if (!connectionId) throw new Error('tenant connection never completed')
  console.log('connected', { connectionId })

  const credentialDone = withTimeout(
    new Promise<void>((resolve) => {
      holder.events.observable<any>('DidCommCredentialStateChanged').subscribe((e) => {
        if (e.payload.credentialExchangeRecord.state === DidCommCredentialState.Done) resolve()
      })
    }),
    180_000,
    'holder credential done'
  )
  const offer = await call<{ credentialExchangeId: string; threadId: string }>('POST', `/tenants/${tenantId}/credentials/offer`, {
    connectionId,
    credentialDefinitionObjectId: credDefObjectId,
    values: { name: 'Ada Lovelace', employeeNumber: '1815', department: 'Analytical Engines', expiresAt: String(Math.floor(Date.now() / 1000) + 86_400) },
    correlationId,
  })
  await credentialDone
  const credential = await call<{ state: string }>('GET', `/tenants/${tenantId}/credentials/${offer.credentialExchangeId}`)
  console.log('credential', { id: offer.credentialExchangeId, state: credential.state })

  const proof = await call<{ proofExchangeId: string }>('POST', `/tenants/${tenantId}/proofs/request`, {
    connectionId,
    name: 'employment',
    groups: [{ key: 'employee', attributes: ['name', 'department'], credentialDefinitionIds: [credDefId], predicates: [{ name: 'employeeNumber', type: '>', value: 1000 }] }],
    correlationId,
  })
  await withTimeout(
    new Promise<void>((resolve) => {
      holder.events.observable<any>('DidCommProofStateChanged').subscribe((e) => {
        if (e.payload.proofRecord.state === DidCommProofState.Done) resolve()
      })
    }),
    180_000,
    'holder proof done'
  )
  await new Promise((r) => setTimeout(r, 2000))
  const result = await call<{ state: string; isVerified: boolean | null; disclosed: Record<string, Record<string, string>> }>('GET', `/tenants/${tenantId}/proofs/${proof.proofExchangeId}`)
  console.log('proof', result)

  // Reject a qualified id at the boundary.
  const rejected = await fetch(`${api}/tenants/${tenantId}/proofs/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId, name: 'x', groups: [{ key: 'g', attributes: ['name'], credentialDefinitionIds: [`did:indy:twelveid:staging/anoncreds/v0/CLAIM_DEF/1/default`] }] }),
  })
  console.log('qualified id rejected:', rejected.status, await rejected.text())

  // credential-issued = delivered; done arrives with the holder's ack a moment later (T3a lesson).
  passed = ['credential-issued', 'done'].includes(credential.state) && result.isVerified === true && result.disclosed.employee?.name === 'Ada Lovelace' && rejected.status === 400
  console.log('correlationId', correlationId)
} catch (error) {
  console.error('A5 FAILED:', error)
} finally {
  await new Promise((r) => setTimeout(r, 2000))
  await holder.shutdown().catch(() => undefined)
}
console.log(`\n=== A5 ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
