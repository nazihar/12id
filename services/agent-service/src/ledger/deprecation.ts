/**
 * Schema versioning (A4, 4-init §5.1). A new version is a new schema + cred def. Deprecating a
 * version blocks new offers on its cred defs; proofs keep accepting them (the platform's templates
 * list several cred def ids per logical credential type).
 */
import { and, eq, inArray } from 'drizzle-orm'

import type { Database } from '../db/client.ts'
import { ledgerObjects } from '../db/schema.ts'

export async function setSchemaDeprecated(db: Database, tenantId: string, schemaObjectId: string, deprecated: boolean) {
  const [schema] = await db.select().from(ledgerObjects).where(and(eq(ledgerObjects.id, schemaObjectId), eq(ledgerObjects.tenantId, tenantId), eq(ledgerObjects.kind, 'schema')))
  if (!schema) throw new Error(`schema ${schemaObjectId} not found for tenant ${tenantId}`)
  if (!['published', 'deprecated'].includes(schema.status)) throw new Error(`schema is ${schema.status}; only published schemas can be deprecated`)

  const status = deprecated ? 'deprecated' : 'published'
  await db.transaction(async (tx) => {
    await tx.update(ledgerObjects).set({ status, updatedAt: new Date() }).where(eq(ledgerObjects.id, schemaObjectId))
    await tx
      .update(ledgerObjects)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(ledgerObjects.schemaObjectId, schemaObjectId), eq(ledgerObjects.kind, 'credential_definition'), inArray(ledgerObjects.status, ['published', 'deprecated'])))
  })
  return status
}

export async function listCatalogue(db: Database, tenantId: string) {
  return db.select().from(ledgerObjects).where(eq(ledgerObjects.tenantId, tenantId)).orderBy(ledgerObjects.createdAt)
}
