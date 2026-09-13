import {
  getUnqualifiedCredentialDefinitionId,
  getUnqualifiedSchemaId,
  parseIndyCredentialDefinitionId,
  parseIndySchemaId,
} from '@credo-ts/anoncreds'
import { TypedArrayEncoder } from '@credo-ts/core'

import type { SmokeAgent } from './agent.ts'

// Credo 0.7 types an absent module's API as `undefined`, so a narrower
// Agent<{ anoncreds: AnonCredsModule }> does not accept an agent that also has DIDComm.
type AnonCredsAgent = SmokeAgent

export interface IssuerIdentity {
  did: string
  nym: string
  verkey: string
}

/**
 * Creates a throwaway issuer DID for one smoke run: the key is generated in the agent's
 * (in-memory) Askar store and von-network's trustee writes the NYM with role ENDORSER.
 *
 * Smoke-test shortcut only. Platform tenants get their DIDs endorsed by the platform
 * endorser (Phase 2), not through von-network's /register.
 */
export async function createIssuerDid(
  agent: AnonCredsAgent,
  options: { namespace: string; registerUrl: string; alias: string }
): Promise<IssuerIdentity> {
  const { keyId, publicJwk } = await agent.kms.createKey({ type: { kty: 'OKP', crv: 'Ed25519' } })
  const publicKeyBytes = TypedArrayEncoder.fromBase64Url((publicJwk as { x: string }).x)
  const verkey = TypedArrayEncoder.toBase58(publicKeyBytes)
  const nym = TypedArrayEncoder.toBase58(publicKeyBytes.slice(0, 16))
  const did = `did:indy:${options.namespace}:${nym}`

  const response = await fetch(options.registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did: nym, verkey, alias: options.alias, role: 'ENDORSER' }),
  })
  if (!response.ok) {
    throw new Error(`NYM registration failed: ${response.status} ${await response.text()}`)
  }

  // Importing a did:indy DID resolves it; retry briefly while the NYM propagates.
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      await agent.dids.import({
        did,
        keys: [{ kmsKeyId: keyId, didDocumentRelativeKeyId: '#verkey' }],
        overwrite: true,
      })
      break
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }

  return { did, nym, verkey }
}

export interface PublishedObjects {
  schemaId: string
  credentialDefinitionId: string
  unqualifiedSchemaId: string
  unqualifiedCredentialDefinitionId: string
}

/**
 * Publishes a schema and a non-revocable credential definition (v1 has no revocation).
 *
 * IndyVdrAnonCredsRegistry returns did:indy-qualified identifiers while writing the ledger
 * objects unqualified, and issue-credential/present-proof v1 accept only the unqualified
 * form (4-init §2.7.2), so both are returned.
 */
export async function publishSchemaAndCredentialDefinition(
  agent: AnonCredsAgent,
  options: { issuerId: string; schemaName: string; attributes: string[] }
): Promise<PublishedObjects> {
  const schemaResult = await agent.modules.anoncreds.registerSchema({
    schema: {
      issuerId: options.issuerId,
      name: options.schemaName,
      version: '1.0',
      attrNames: options.attributes,
    },
    options: { endorserMode: 'internal', endorserDid: options.issuerId },
  })
  if (schemaResult.schemaState.state !== 'finished') {
    throw new Error(`schema registration failed: ${JSON.stringify(schemaResult.schemaState)}`)
  }
  const schemaId = schemaResult.schemaState.schemaId

  const credentialDefinitionResult = await agent.modules.anoncreds.registerCredentialDefinition({
    credentialDefinition: { issuerId: options.issuerId, schemaId, tag: 'default' },
    options: { supportRevocation: false, endorserMode: 'internal', endorserDid: options.issuerId },
  })
  if (credentialDefinitionResult.credentialDefinitionState.state !== 'finished') {
    throw new Error(
      `cred def registration failed: ${JSON.stringify(credentialDefinitionResult.credentialDefinitionState)}`
    )
  }
  const credentialDefinitionId = credentialDefinitionResult.credentialDefinitionState.credentialDefinitionId

  const parsedSchema = parseIndySchemaId(schemaId)
  const parsedCredentialDefinition = parseIndyCredentialDefinitionId(credentialDefinitionId)

  return {
    schemaId,
    credentialDefinitionId,
    unqualifiedSchemaId: getUnqualifiedSchemaId(
      parsedSchema.namespaceIdentifier,
      parsedSchema.schemaName,
      parsedSchema.schemaVersion
    ),
    unqualifiedCredentialDefinitionId: getUnqualifiedCredentialDefinitionId(
      parsedCredentialDefinition.namespaceIdentifier,
      parsedCredentialDefinition.schemaSeqNo,
      parsedCredentialDefinition.tag
    ),
  }
}
