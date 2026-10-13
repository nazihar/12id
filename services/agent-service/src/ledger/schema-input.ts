/**
 * Validation for customer-defined schemas before anything reaches the ledger. Ledger objects are
 * immutable (4-init §5.1), so mistakes here are permanent.
 */
import { z } from 'zod'

/** Mandatory in every schema: the expiry date (`YYYYMMDD`, UTC) every proof request checks (4-init §4.7). */
export const EXPIRY_ATTRIBUTE = 'expiresOn'

/**
 * Names a holder cannot keep as a claim. Credo keeps AnonCreds credentials in W3C form and takes `id`
 * out of the claims as the subject's identifier (0.7 `W3cCredentialSubject`), so a Credo-based wallet
 * fails to store a credential with an `id` attribute (implement/21-reference-integration.md, finding 5).
 */
export const RESERVED_ATTRIBUTES = ['id']

export const schemaInput = z
  .object({
    // Indy schema names end up inside unqualified ids (`<nym>:2:<name>:<version>`): no colons.
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'name may contain letters, digits, _ . - and no colon'),
    // Credo's unqualifiedSchemaVersionRegex accepts up to three numeric parts.
    version: z.string().regex(/^\d+(\.\d+){0,2}$/, 'version must be numeric, e.g. 1.0'),
    attributes: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'attribute names must be identifiers'))
      .min(2)
      .max(125),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const attribute of value.attributes) {
      if (seen.has(attribute)) context.addIssue({ code: 'custom', path: ['attributes'], message: `duplicate attribute ${attribute}` })
      seen.add(attribute)
      if (RESERVED_ATTRIBUTES.includes(attribute)) {
        context.addIssue({
          code: 'custom',
          path: ['attributes'],
          message: `${attribute} is reserved: wallets treat it as the credential subject's identifier and cannot store the credential; use a specific name such as memberId`,
        })
      }
    }
    if (!seen.has(EXPIRY_ATTRIBUTE)) {
      context.addIssue({
        code: 'custom',
        path: ['attributes'],
        message: `every schema must include the expiry date attribute ${EXPIRY_ATTRIBUTE}; it cannot be added later`,
      })
    }
  })

export type SchemaInput = z.infer<typeof schemaInput>
