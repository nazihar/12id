/**
 * Bounds on the attribute values of a credential offer (Phase 7 review L4). platform-api checks
 * them on the customer's request and agent-service again on its internal command; before this the
 * only bound was the 1 MB (8 MB when gated) request body, and the values travel on into the agent,
 * the outbox, the mirror and every webhook body.
 *
 * The name bounds match what a schema may declare (125 names of up to 100 characters). The total
 * keeps the issued credential well inside the 512 KB DIDComm cap at the edge and the mediator
 * (review M1): each value appears raw in the offer and in the credential, and the credential is
 * base64-encoded and encrypted twice (message, then forward) on its way to the holder.
 */
import { z } from 'zod'

export const MAX_CREDENTIAL_ATTRIBUTES = 125
export const MAX_ATTRIBUTE_NAME_LENGTH = 100
export const MAX_ATTRIBUTE_VALUE_BYTES = 4 * 1024
export const MAX_CREDENTIAL_VALUES_BYTES = 64 * 1024

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

export const credentialValuesSchema = z
  .record(z.string().min(1).max(MAX_ATTRIBUTE_NAME_LENGTH), z.string().refine((v) => bytes(v) <= MAX_ATTRIBUTE_VALUE_BYTES, `an attribute value may be at most ${MAX_ATTRIBUTE_VALUE_BYTES} bytes`))
  .refine((values) => Object.keys(values).length <= MAX_CREDENTIAL_ATTRIBUTES, `at most ${MAX_CREDENTIAL_ATTRIBUTES} attributes`)
  .refine(
    (values) => Object.entries(values).reduce((sum, [name, value]) => sum + bytes(name) + bytes(value), 0) <= MAX_CREDENTIAL_VALUES_BYTES,
    `attribute names and values may total at most ${MAX_CREDENTIAL_VALUES_BYTES / 1024} KB`
  )
