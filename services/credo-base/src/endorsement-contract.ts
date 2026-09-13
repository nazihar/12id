/**
 * HTTP contract between agent-service (caller) and endorser-service (signer), D5/A9.
 * Both sides validate with these schemas.
 */
import { z } from 'zod'

/** Shared-secret header on every call. The endorser-service is also network-isolated. */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token'

export const nymSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{21,22}$/, 'not an Indy nym')

/** Binds a tenant to its DID before its NYM is endorsed. First binding wins and cannot change. */
export const bindTenantBody = z.object({
  tenantId: z.string().min(1).max(200),
  nym: nymSchema,
})
export type BindTenantBody = z.infer<typeof bindTenantBody>

export const bindTenantResponse = z.object({
  result: z.enum(['bound', 'already_bound']),
  tenantId: z.string(),
  nym: nymSchema,
})

export const endorseBody = z.object({
  tenantId: z.string().min(1).max(200),
  kind: z.enum(['nym', 'schema', 'credentialDefinition']),
  /** The ledger request JSON exactly as Credo produced it. Cred defs can be large. */
  request: z.string().min(2).max(512_000),
})
export type EndorseBody = z.infer<typeof endorseBody>

export const endorseResponse = z.object({
  endorsedRequest: z.string(),
})

export const refusalResponse = z.object({
  error: z.enum(['refused', 'conflict', 'unauthorized']),
  reason: z.string(),
})
export type RefusalResponse = z.infer<typeof refusalResponse>
