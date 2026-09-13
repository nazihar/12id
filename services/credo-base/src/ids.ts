/**
 * AnonCreds identifier handling (4-init §2.7.2, 8-phase-2-findings T2).
 *
 * - IndyVdrAnonCredsRegistry RETURNS did:indy-qualified ids, but writes the ledger object
 *   unqualified.
 * - issue-credential v1 / present-proof v1 accept ONLY the legacy unqualified form. A qualified
 *   id in an offer makes the holder send `issuance-abandoned` while the issuer record sits at
 *   `offer-sent` with no error.
 *
 * So: store both forms, and guard every id that goes on the wire.
 */
import {
  getUnqualifiedCredentialDefinitionId,
  getUnqualifiedSchemaId,
  isDidIndyCredentialDefinitionId,
  isDidIndySchemaId,
  isUnqualifiedCredentialDefinitionId,
  isUnqualifiedSchemaId,
  parseIndyCredentialDefinitionId,
  parseIndySchemaId,
} from '@credo-ts/anoncreds'

export interface LedgerObjectIds {
  /** did:indy form, as returned by the registry. Stored for reference and future v2 use. */
  qualified: string
  /** Legacy form. The only one allowed in v1 offers and proof-request restrictions. */
  unqualified: string
}

export class WireIdentifierError extends Error {
  public readonly identifier: string

  public constructor(message: string, identifier: string) {
    super(message)
    this.name = 'WireIdentifierError'
    this.identifier = identifier
  }
}

export function schemaIds(qualifiedSchemaId: string): LedgerObjectIds {
  if (!isDidIndySchemaId(qualifiedSchemaId)) {
    throw new WireIdentifierError('expected a did:indy schema id from the registry', qualifiedSchemaId)
  }
  const parsed = parseIndySchemaId(qualifiedSchemaId)
  return {
    qualified: qualifiedSchemaId,
    unqualified: getUnqualifiedSchemaId(parsed.namespaceIdentifier, parsed.schemaName, parsed.schemaVersion),
  }
}

export function credentialDefinitionIds(qualifiedCredentialDefinitionId: string): LedgerObjectIds {
  if (!isDidIndyCredentialDefinitionId(qualifiedCredentialDefinitionId)) {
    throw new WireIdentifierError('expected a did:indy credential definition id from the registry', qualifiedCredentialDefinitionId)
  }
  const parsed = parseIndyCredentialDefinitionId(qualifiedCredentialDefinitionId)
  return {
    qualified: qualifiedCredentialDefinitionId,
    unqualified: getUnqualifiedCredentialDefinitionId(parsed.namespaceIdentifier, parsed.schemaSeqNo, parsed.tag),
  }
}

/** Guard for ids placed in v1 offers and proof-request restrictions. Returns the id unchanged. */
export function assertWireCredentialDefinitionId(credentialDefinitionId: string): string {
  if (isUnqualifiedCredentialDefinitionId(credentialDefinitionId)) return credentialDefinitionId
  const hint = isDidIndyCredentialDefinitionId(credentialDefinitionId) ? ' (qualified did:indy form is rejected by v1 holders)' : ''
  throw new WireIdentifierError(`credential definition id is not in legacy unqualified form${hint}`, credentialDefinitionId)
}

export function assertWireSchemaId(schemaId: string): string {
  if (isUnqualifiedSchemaId(schemaId)) return schemaId
  const hint = isDidIndySchemaId(schemaId) ? ' (qualified did:indy form is rejected by v1 holders)' : ''
  throw new WireIdentifierError(`schema id is not in legacy unqualified form${hint}`, schemaId)
}
