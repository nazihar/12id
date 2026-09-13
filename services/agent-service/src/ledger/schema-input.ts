/**
 * Validation for customer-defined schemas before anything reaches the ledger. Ledger objects are
 * immutable (4-init §5.1), so mistakes here are permanent.
 */
import { z } from 'zod'

/** Mandatory in every schema: the integer expiry every proof template checks (4-init §4.7). */
export const EXPIRY_ATTRIBUTE = 'expiresAt'

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
    }
    if (!seen.has(EXPIRY_ATTRIBUTE)) {
      context.addIssue({
        code: 'custom',
        path: ['attributes'],
        message: `every schema must include the integer attribute ${EXPIRY_ATTRIBUTE}; it cannot be added later`,
      })
    }
  })

export type SchemaInput = z.infer<typeof schemaInput>
