/**
 * What the platform endorser will sign (8-phase-2-findings T2).
 *
 * Credo's IndyVdrApi.endorseTransaction signs anything whose `endorser` / `identifier` field
 * matches the endorser, so every rule here is ours. Checks run on the request BEFORE signing:
 * after multi-signing, `signature` is replaced by `signatures` and the author check no longer works.
 *
 *   NYM (type 1)        tenant-built, UNSIGNED, authored in the endorser's name, role-less,
 *                       for a DID the agent-service registered for a tenant
 *   SCHEMA (101)        signed by a registered tenant DID, naming our endorser
 *   CLAIM_DEF (102)     same
 *   anything else       refused
 */

export const TXN_NYM = '1'
export const TXN_SCHEMA = '101'
export const TXN_CLAIM_DEF = '102'

export type EndorsementKind = 'nym' | 'schema' | 'credentialDefinition'

export interface EndorsementRequest {
  kind: EndorsementKind
  /** The ledger request JSON exactly as Credo produced it. */
  request: string
  /** Tenant the agent-service says this is for. */
  tenantId: string
}

export interface TenantRegistry {
  /** Unqualified nym registered for the tenant, or null if the tenant has none yet. */
  nymForTenant(tenantId: string): Promise<string | null>
}

export type PolicyDecision =
  | { allowed: true; kind: EndorsementKind; author: string; operationType: string }
  | { allowed: false; reason: string }

interface LedgerRequestShape {
  identifier?: unknown
  endorser?: unknown
  signature?: unknown
  signatures?: unknown
  operation?: { type?: unknown; dest?: unknown; role?: unknown }
}

const NYM_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{21,22}$/

function refuse(reason: string): PolicyDecision {
  return { allowed: false, reason }
}

function parse(request: string): LedgerRequestShape | null {
  try {
    const value = JSON.parse(request) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as LedgerRequestShape) : null
  } catch {
    return null
  }
}

export async function checkEndorsement(
  input: EndorsementRequest,
  endorserNym: string,
  tenants: TenantRegistry
): Promise<PolicyDecision> {
  const request = parse(input.request)
  if (!request || !request.operation) return refuse('request is not a ledger request object')
  const operationType = String(request.operation.type)

  const tenantNym = await tenants.nymForTenant(input.tenantId)
  if (!tenantNym) return refuse(`tenant ${input.tenantId} has no registered DID`)

  if (input.kind === 'nym') {
    if (operationType !== TXN_NYM) return refuse(`expected NYM (type ${TXN_NYM}), got type ${operationType}`)
    if (request.signature !== undefined || request.signatures !== undefined) return refuse('NYM request is already signed')
    if (request.identifier !== endorserNym) return refuse('NYM must be authored in the endorser name')
    if (request.operation.dest !== tenantNym) return refuse('NYM dest is not the DID registered for this tenant')
    if (request.operation.role !== undefined && request.operation.role !== null) {
      return refuse(`NYM requests role ${String(request.operation.role)}; tenant DIDs must be role-less`)
    }
    return { allowed: true, kind: 'nym', author: endorserNym, operationType }
  }

  const expectedType = input.kind === 'schema' ? TXN_SCHEMA : TXN_CLAIM_DEF
  if (operationType !== expectedType) return refuse(`expected type ${expectedType}, got type ${operationType}`)
  if (typeof request.identifier !== 'string' || !NYM_PATTERN.test(request.identifier)) return refuse('author is not a nym')
  if (request.identifier !== tenantNym) return refuse('author is not the DID registered for this tenant')
  if (request.endorser !== endorserNym) return refuse('endorser field does not name our endorser')
  if (typeof request.signature !== 'string' || request.signature.length === 0) return refuse('author signature missing')
  if (request.signatures !== undefined) return refuse('request is already multi-signed')
  return { allowed: true, kind: input.kind, author: tenantNym, operationType }
}
