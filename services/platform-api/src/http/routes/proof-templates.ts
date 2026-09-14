/** Proof template CRUD (P4). Validation is static here; catalogue resolution happens at request time. */
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { proofTemplates } from '../../db/schema.ts'
import { templateDefinition, validateTemplate } from '../../templates.ts'
import type { TenantContext } from '../auth.ts'
import { notFound } from '../errors.ts'

const errorBody = z.object({ error: z.string(), reason: z.string() })
const templateView = z.object({ id: z.string(), name: z.string(), definition: templateDefinition, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() })
const view = (row: typeof proofTemplates.$inferSelect) => ({ id: row.id, name: row.name, definition: templateDefinition.parse(row.definition), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })

export const proofTemplateRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => request.tenant as TenantContext

  app.post(
    '/v1/proof-templates',
    {
      schema: {
        tags: ['proofs'],
        summary: 'Create a proof template',
        description: 'Each group discloses attributes from one credential and may add integer predicates. Credentials are referenced by schema name (all versions, or active only) or by credential definition id. `expiresAt` is always predicated and can never be disclosed.',
        body: templateDefinition,
        response: { 201: templateView, 400: errorBody },
      },
    },
    async (request, reply) => {
      validateTemplate(request.body)
      const [row] = await deps.db.insert(proofTemplates).values({ tenantId: tenant(request).id, name: request.body.name, definition: request.body }).returning()
      return reply.code(201).send(view(row))
    }
  )

  app.get('/v1/proof-templates', { schema: { tags: ['proofs'], summary: 'List proof templates', response: { 200: z.array(templateView) } } }, async (request) => {
    const rows = await deps.db.select().from(proofTemplates).where(eq(proofTemplates.tenantId, tenant(request).id)).orderBy(desc(proofTemplates.createdAt))
    return rows.map(view)
  })

  app.get('/v1/proof-templates/:id', { schema: { tags: ['proofs'], summary: 'Get a proof template', params: z.object({ id: z.uuid() }), response: { 200: templateView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(proofTemplates).where(and(eq(proofTemplates.tenantId, tenant(request).id), eq(proofTemplates.id, request.params.id)))
    if (!row) throw notFound('proof template')
    return view(row)
  })

  app.put('/v1/proof-templates/:id', { schema: { tags: ['proofs'], summary: 'Replace a proof template', params: z.object({ id: z.uuid() }), body: templateDefinition, response: { 200: templateView, 400: errorBody, 404: errorBody } } }, async (request) => {
    validateTemplate(request.body)
    const [row] = await deps.db
      .update(proofTemplates)
      .set({ name: request.body.name, definition: request.body, updatedAt: new Date() })
      .where(and(eq(proofTemplates.tenantId, tenant(request).id), eq(proofTemplates.id, request.params.id)))
      .returning()
    if (!row) throw notFound('proof template')
    return view(row)
  })

  app.delete('/v1/proof-templates/:id', { schema: { tags: ['proofs'], summary: 'Delete a proof template', params: z.object({ id: z.uuid() }), response: { 200: z.object({ deleted: z.boolean() }), 404: errorBody } } }, async (request) => {
    const rows = await deps.db.delete(proofTemplates).where(and(eq(proofTemplates.tenantId, tenant(request).id), eq(proofTemplates.id, request.params.id))).returning({ id: proofTemplates.id })
    if (rows.length === 0) throw notFound('proof template')
    return { deleted: true }
  })
}
