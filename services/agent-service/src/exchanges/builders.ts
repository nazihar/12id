/**
 * Pure builders for v1 offers and proof requests, so the wire-level rules are unit-tested:
 *   - only unqualified cred def ids (4-init §2.7.2);
 *   - attributes exactly match the schema, as strings (4-init §5.2);
 *   - every schema carries `expiresOn` (YYYYMMDD, UTC), and every proof request checks it is not past (4-init §4.7).
 */
import { assertWireCredentialDefinitionId } from '@12id/credo-base/ids.ts'

import { EXPIRY_ATTRIBUTE } from '../ledger/schema-input.ts'

export class ExchangeInputError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ExchangeInputError'
  }
}

/** The largest integer AnonCreds encodes as an integer (signed 32-bit); predicates need integers. */
export const MAX_PREDICATE_INTEGER = 2_147_483_647

/** The UTC day of [epochSeconds] as the integer YYYYMMDD the expiry predicate compares. */
export function utcDateNumber(epochSeconds: number): number {
  const day = new Date(epochSeconds * 1000)
  return day.getUTCFullYear() * 10_000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate()
}

/** True for an existing calendar date written as YYYYMMDD (no 20250230). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false
  const [year, month, day] = [Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8))]
  const date = new Date(Date.UTC(year, month - 1, day))
  return year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export interface OfferAttribute {
  name: string
  value: string
}

/** Validates offer values against the schema's attribute list and returns them in schema order. */
export function buildOfferAttributes(
  schemaAttributes: readonly string[],
  values: Record<string, string>,
  nowSeconds: number
): OfferAttribute[] {
  const expected = new Set(schemaAttributes)
  const missing = schemaAttributes.filter((name) => !(name in values))
  const unexpected = Object.keys(values).filter((name) => !expected.has(name))
  if (missing.length > 0) throw new ExchangeInputError(`missing attributes: ${missing.join(', ')}`)
  if (unexpected.length > 0) throw new ExchangeInputError(`attributes not in the schema: ${unexpected.join(', ')}`)

  // A date, not epoch seconds (2026-10-06): AnonCreds compares only 32-bit integers in predicates, so
  // epoch seconds capped validity at 2038-01-19; YYYYMMDD fits until year 9999 (Phase 9 W7 finding).
  const expiresOn = values[EXPIRY_ATTRIBUTE]
  if (expiresOn === undefined || !isCalendarDate(expiresOn)) {
    throw new ExchangeInputError(`${EXPIRY_ATTRIBUTE} must be a date as YYYYMMDD, e.g. 20301231`)
  }
  if (Number(expiresOn) < utcDateNumber(nowSeconds)) throw new ExchangeInputError(`${EXPIRY_ATTRIBUTE} is in the past`)

  return schemaAttributes.map((name) => ({ name, value: String(values[name]) }))
}

export interface ProofGroupInput {
  /** Group key in the request, e.g. "employee". */
  key: string
  /** Attributes to disclose, all from one credential. */
  attributes: string[]
  /** Unqualified cred def ids accepted for this group (several schema versions allowed, §5.1). */
  credentialDefinitionIds: string[]
  /** Optional integer predicates, e.g. { name: 'age', type: '>=', value: 18 }. */
  predicates?: Array<{ name: string; type: '>=' | '>' | '<=' | '<'; value: number }>
}

export interface IndyProofRequest {
  name: string
  version: string
  requested_attributes: Record<string, { names: string[]; restrictions: Array<{ cred_def_id: string }> }>
  requested_predicates: Record<string, { name: string; p_type: '>=' | '>' | '<=' | '<'; p_value: number; restrictions: Array<{ cred_def_id: string }> }>
}

export function buildProofRequest(name: string, groups: ProofGroupInput[], nowSeconds: number): IndyProofRequest {
  if (groups.length === 0) throw new ExchangeInputError('a proof request needs at least one group')
  const request: IndyProofRequest = { name, version: '1.0', requested_attributes: {}, requested_predicates: {} }

  for (const group of groups) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(group.key)) throw new ExchangeInputError(`invalid group key ${group.key}`)
    if (group.credentialDefinitionIds.length === 0) throw new ExchangeInputError(`group ${group.key} accepts no credential definition`)
    const restrictions = group.credentialDefinitionIds.map((id) => ({ cred_def_id: assertWireCredentialDefinitionId(id) }))

    // AnonCreds refuses a request that both reveals an attribute and predicates on it
    // (Credo: "duplicate predicates and attributes"). expiresOn is always predicated.
    const predicated = new Set([EXPIRY_ATTRIBUTE, ...(group.predicates ?? []).map((p) => p.name)])
    const clash = group.attributes.filter((name) => predicated.has(name))
    if (clash.length > 0) {
      throw new ExchangeInputError(`attributes cannot be both revealed and used in a predicate: ${clash.join(', ')}`)
    }

    if (group.attributes.length > 0) {
      request.requested_attributes[group.key] = { names: [...group.attributes], restrictions }
    }
    for (const predicate of group.predicates ?? []) {
      if (predicate.name === EXPIRY_ATTRIBUTE) throw new ExchangeInputError(`${EXPIRY_ATTRIBUTE} is checked automatically; do not pass it`)
      request.requested_predicates[`${group.key}_${predicate.name}`] = {
        name: predicate.name,
        p_type: predicate.type,
        p_value: predicate.value,
        restrictions,
      }
    }
    // Mandatory and not removable: without revocation, expiry is the only way a credential ends.
    request.requested_predicates[`${group.key}_not_expired`] = {
      name: EXPIRY_ATTRIBUTE,
      p_type: '>=',
      // Valid through the end of its expiry day (UTC): today's date as YYYYMMDD.
      p_value: utcDateNumber(nowSeconds),
      restrictions,
    }
  }
  return request
}
