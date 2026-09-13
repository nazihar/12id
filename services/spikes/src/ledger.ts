/**
 * T2: tenant onboarding with the author/endorser split (7-phase-2.md D3, D5).
 *
 * The tenant never holds an ENDORSER role and the endorser never writes to the ledger:
 *   NYM:            tenant builds an UNSIGNED nym request -> endorser signs it as author -> tenant submits
 *   SCHEMA/CLAIM_DEF: tenant signs as author, naming the endorser -> endorser multi-signs -> tenant submits
 *
 * `checkEndorsementPolicy` is the spike version of the endorser-service policy (A9).
 */
import {
  AnonCredsCredentialDefinitionPrivateRepository,
  getUnqualifiedCredentialDefinitionId,
  getUnqualifiedSchemaId,
  parseIndyCredentialDefinitionId,
  parseIndySchemaId,
} from '@credo-ts/anoncreds'
import type { IndyVdrDidCreateOptions } from '@credo-ts/indy-vdr'

import { type EndorserAgent, INDY_NAMESPACE, type RootAgent, readNym } from './common.ts'

interface LedgerRequest {
  identifier: string
  endorser?: string
  signature?: string
  signatures?: Record<string, string>
  operation: { type: string; dest?: string; verkey?: string; role?: string | null; ref?: number }
}

const TXN_NYM = '1'
const TXN_SCHEMA = '101'
const TXN_CLAIM_DEF = '102'

export type PolicyInput =
  | { kind: 'nym'; request: string; endorserNym: string; expectedDest: string }
  | { kind: 'schema' | 'credDef'; request: string; endorserNym: string; expectedAuthor: string }

/** Returns null when the request may be endorsed, otherwise the refusal reason. */
export function checkEndorsementPolicy(input: PolicyInput): string | null {
  const request = JSON.parse(input.request) as LedgerRequest
  if (input.kind === 'nym') {
    if (request.operation.type !== TXN_NYM) return `expected NYM (type 1), got type ${request.operation.type}`
    if (request.signature || request.signatures) return 'NYM request is already signed'
    if (request.identifier !== input.endorserNym) return `NYM author ${request.identifier} is not the endorser`
    if (request.operation.dest !== input.expectedDest) return `NYM dest ${request.operation.dest} is not the tenant DID`
    if (request.operation.role !== undefined && request.operation.role !== null) {
      return `NYM requests role ${request.operation.role}; tenants must be role-less`
    }
    return null
  }
  const expectedType = input.kind === 'schema' ? TXN_SCHEMA : TXN_CLAIM_DEF
  if (request.operation.type !== expectedType) return `expected type ${expectedType}, got ${request.operation.type}`
  if (request.identifier !== input.expectedAuthor) return `author ${request.identifier} is not the tenant`
  if (request.endorser !== input.endorserNym) return `endorser field ${request.endorser} is not our endorser`
  if (!request.signature) return 'author signature missing'
  return null
}

function describe(request: string) {
  const r = JSON.parse(request) as LedgerRequest
  return {
    identifier: r.identifier,
    endorser: r.endorser,
    signed: Boolean(r.signature),
    multiSigned: r.signatures ? Object.keys(r.signatures) : [],
    operation: { type: r.operation.type, dest: r.operation.dest, role: r.operation.role, ref: r.operation.ref },
  }
}

export interface OnboardedTenant {
  tenantId: string
  label: string
  did: string
  nym: string
  schemaId: string
  credentialDefinitionId: string
  unqualifiedSchemaId: string
  unqualifiedCredentialDefinitionId: string
}

export async function onboardTenant(
  root: RootAgent,
  endorser: EndorserAgent,
  endorserDid: string,
  options: { label: string; schemaName: string; attributes: string[]; log?: boolean }
): Promise<OnboardedTenant> {
  const log = (...args: unknown[]) => options.log && console.log(...args)
  const endorserNym = endorserDid.split(':').pop() as string
  const endorse = async (input: PolicyInput) => {
    const refusal = checkEndorsementPolicy(input)
    if (refusal) throw new Error(`endorser policy refused ${input.kind}: ${refusal}`)
    return endorser.modules.indyVdr.endorseTransaction(input.request, endorserDid)
  }

  const tenantRecord = await root.modules.tenants.createTenant({ config: { label: options.label } })
  log(`tenant created: ${tenantRecord.id} (${options.label})`)

  return root.modules.tenants.withTenantAgent({ tenantId: tenantRecord.id }, async (tenantAgent) => {
    // TenantsModule is untyped for tenant modules here; the tenant inherits the root's modules at runtime.
    const tenant = tenantAgent as unknown as RootAgent

    // --- NYM ---------------------------------------------------------------------------
    const created = (await tenant.dids.create<IndyVdrDidCreateOptions>({
      method: 'indy',
      options: { endorserDid, endorserMode: 'external' },
    })) as { didState: { state: string; action?: string; did?: string; nymRequest?: string; reason?: string } }
    if (created.didState.state !== 'action' || !created.didState.nymRequest || !created.didState.did) {
      throw new Error(`tenant DID create did not return an endorsement action: ${JSON.stringify(created.didState)}`)
    }
    const did = created.didState.did
    const nym = did.split(':').pop() as string
    log('  nym request (tenant-built):', describe(created.didState.nymRequest))

    const endorsedNym = await endorse({ kind: 'nym', request: created.didState.nymRequest, endorserNym, expectedDest: nym })
    log('  nym request (endorser-signed):', describe(endorsedNym))

    const submitted = (await tenant.dids.create<IndyVdrDidCreateOptions>({
      did,
      options: { endorserMode: 'external', endorsedTransaction: { nymRequest: endorsedNym } },
    })) as { didState: { state: string; reason?: string } }
    if (submitted.didState.state !== 'finished') {
      throw new Error(`tenant NYM submit failed: ${JSON.stringify(submitted.didState)}`)
    }
    const onLedger = await readNym(tenant, nym)
    if (!onLedger) throw new Error(`tenant NYM ${nym} not on the ledger after submit`)
    log(`  tenant DID on ledger: ${did} role=${onLedger.role}`)
    if (onLedger.role !== null && onLedger.role !== undefined) throw new Error(`tenant NYM has role ${onLedger.role}`)

    // --- SCHEMA ------------------------------------------------------------------------
    const schema = { issuerId: did, name: options.schemaName, version: '1.0', attrNames: options.attributes }
    const schemaAction = (await tenant.modules.anoncreds.registerSchema({
      schema,
      options: { endorserMode: 'external', endorserDid },
    })) as unknown as { schemaState: { state: string; schemaRequest?: string; reason?: string } }
    if (schemaAction.schemaState.state !== 'action' || !schemaAction.schemaState.schemaRequest) {
      throw new Error(`schema create did not return an endorsement action: ${JSON.stringify(schemaAction.schemaState)}`)
    }
    log('  schema request (tenant-signed):', describe(schemaAction.schemaState.schemaRequest))
    const endorsedSchema = await endorse({
      kind: 'schema',
      request: schemaAction.schemaState.schemaRequest,
      endorserNym,
      expectedAuthor: nym,
    })
    log('  schema request (endorsed):', describe(endorsedSchema))
    const schemaResult = (await tenant.modules.anoncreds.registerSchema({
      schema,
      options: { endorserMode: 'external', endorsedTransaction: endorsedSchema },
    })) as unknown as { schemaState: { state: string; schemaId?: string; reason?: string } }
    if (schemaResult.schemaState.state !== 'finished' || !schemaResult.schemaState.schemaId) {
      throw new Error(`schema submit failed: ${JSON.stringify(schemaResult.schemaState)}`)
    }
    const schemaId = schemaResult.schemaState.schemaId

    // --- CLAIM_DEF ---------------------------------------------------------------------
    const credDefAction = (await tenant.modules.anoncreds.registerCredentialDefinition({
      credentialDefinition: { issuerId: did, schemaId, tag: 'default' },
      options: { supportRevocation: false, endorserMode: 'external', endorserDid },
    })) as unknown as {
      credentialDefinitionState: {
        state: string
        credentialDefinition?: Record<string, unknown>
        credentialDefinitionRequest?: string
        reason?: string
      }
    }
    const actionState = credDefAction.credentialDefinitionState
    if (actionState.state !== 'action' || !actionState.credentialDefinitionRequest || !actionState.credentialDefinition) {
      throw new Error(`cred def create did not return an endorsement action: ${JSON.stringify(actionState)}`)
    }
    log('  cred def request (tenant-signed):', describe(actionState.credentialDefinitionRequest))
    const endorsedCredDef = await endorse({
      kind: 'credDef',
      request: actionState.credentialDefinitionRequest,
      endorserNym,
      expectedAuthor: nym,
    })
    // Submit with the FULL credential definition from the action state (it has `value`), so
    // AnonCredsApi does not generate a second key pair that would not match the endorsed tx
    // (AnonCredsApi.registerCredentialDefinition -> isFullCredentialDefinitionInput).
    const credDefResult = (await tenant.modules.anoncreds.registerCredentialDefinition({
      credentialDefinition: actionState.credentialDefinition as never,
      options: { supportRevocation: false, endorserMode: 'external', endorsedTransaction: endorsedCredDef } as never,
    })) as unknown as { credentialDefinitionState: { state: string; credentialDefinitionId?: string; reason?: string } }
    if (credDefResult.credentialDefinitionState.state !== 'finished' || !credDefResult.credentialDefinitionState.credentialDefinitionId) {
      throw new Error(`cred def submit failed: ${JSON.stringify(credDefResult.credentialDefinitionState)}`)
    }
    const credentialDefinitionId = credDefResult.credentialDefinitionState.credentialDefinitionId

    const privateRecords = await tenant.dependencyManager
      .resolve(AnonCredsCredentialDefinitionPrivateRepository)
      .getAll(tenant.context)
    log(`  cred def private records in tenant wallet: ${privateRecords.length} (expected 1)`)
    if (privateRecords.length !== 1) throw new Error(`expected 1 cred def private record, found ${privateRecords.length}`)

    const s = parseIndySchemaId(schemaId)
    const c = parseIndyCredentialDefinitionId(credentialDefinitionId)
    const result: OnboardedTenant = {
      tenantId: tenantRecord.id,
      label: options.label,
      did,
      nym,
      schemaId,
      credentialDefinitionId,
      unqualifiedSchemaId: getUnqualifiedSchemaId(s.namespaceIdentifier, s.schemaName, s.schemaVersion),
      unqualifiedCredentialDefinitionId: getUnqualifiedCredentialDefinitionId(c.namespaceIdentifier, c.schemaSeqNo, c.tag),
    }
    if (!did.startsWith(`did:indy:${INDY_NAMESPACE}:`)) throw new Error(`unexpected tenant DID namespace: ${did}`)
    return result
  })
}
