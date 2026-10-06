/** Client-safe input schemas for the catalogue forms and the server functions' validators. */
import { z } from 'zod'

import { EXPIRY_ATTRIBUTE, attributeName } from '@/lib/template-schema'

export const schemaName = z.string().trim().min(1, 'Enter a schema name.').max(200, 'Use at most 200 characters.')
export const schemaVersion = z.string().trim().regex(/^\d+(\.\d+){0,2}$/, 'Use a version like 1.0 or 2.1.3.')
export const schemaAttributes = z.array(attributeName).min(1, 'Add at least one attribute.').max(124, 'A schema holds at most 124 attributes.')

/** What the server accepts: attributes already split into names. */
export const publishSchemaInput = z.object({ name: schemaName, version: schemaVersion, attributes: schemaAttributes })

/** Splits the attributes textarea: one per line or comma-separated, trimmed, deduplicated, `expiresOn` dropped (always appended by the server). */
export function parseAttributeList(text: string): string[] {
  const names = text
    .split(/[\s,]+/)
    .map((attribute) => attribute.trim())
    .filter((attribute) => attribute && attribute !== EXPIRY_ATTRIBUTE)
  return [...new Set(names)]
}

/** What the form holds: the attributes as typed. Parsing errors land on the `attributes` field. */
export const publishSchemaForm = z.object({
  name: schemaName,
  version: schemaVersion,
  attributes: z.string().transform(parseAttributeList).pipe(schemaAttributes),
})
export type PublishSchemaForm = z.input<typeof publishSchemaForm>
