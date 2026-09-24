/**
 * Schema versioning (A4, 4-init §5.1). A new version is a new schema + cred def. Deprecating a
 * version blocks new offers on its cred defs; proofs keep accepting them (the platform's templates
 * list several cred def ids per logical credential type).
 */
import { type SQL, and, count, desc, eq, ilike, inArray, or } from 'drizzle-orm'

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

export interface CataloguePageQuery {
  kind: (typeof ledgerObjects.kind.enumValues)[number]
  status?: (typeof ledgerObjects.status.enumValues)[number]
  q?: string
  page: number
  pageSize: number
}

/** One page of one kind, newest first, for the console's catalogue lists (Phase 4 C9). */
export async function listCataloguePage(db: Database, tenantId: string, query: CataloguePageQuery) {
  const filters: SQL[] = [eq(ledgerObjects.tenantId, tenantId), eq(ledgerObjects.kind, query.kind)]
  if (query.status) filters.push(eq(ledgerObjects.status, query.status))
  if (query.q) {
    // LIKE wildcards in the search term are literal.
    const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    filters.push(or(ilike(ledgerObjects.name, pattern), ilike(ledgerObjects.tag, pattern))!)
  }
  const where = and(...filters)
  const [items, [{ total }]] = await Promise.all([
    db.select().from(ledgerObjects).where(where).orderBy(desc(ledgerObjects.createdAt), desc(ledgerObjects.id)).limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(ledgerObjects).where(where),
  ])
  return { items, total, page: query.page, pageSize: query.pageSize }
}
