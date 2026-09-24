/**
 * Proof template CRUD (P4). Validation is static here; catalogue resolution happens at request time.
 * Reads take an API key or the console; writes are console only (review K1).
 */
import { type SQL, and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { proofTemplates } from '../../db/schema.ts'
import { biometricOverride } from '../../biometric/policy.ts'
import { templateDefinition, validateTemplate } from '../../templates.ts'
import { type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { notFound } from '../errors.ts'
import { containsI, listPage, pageOf, pageQuery, searchQuery } from '../list.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

const errorBody = z.object({ error: z.string(), reason: z.string() })
const templateView = z.object({ id: z.string(), name: z.string(), definition: templateDefinition, biometricPolicy: biometricOverride, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() })
const view = (row: typeof proofTemplates.$inferSelect) => ({
  id: row.id,
  name: row.name,
  definition: templateDefinition.parse(row.definition),
  biometricPolicy: row.biometricPolicy ? biometricOverride.parse(row.biometricPolicy) : { mode: 'inherit' as const },
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

/** The template plus an optional biometric gate override (Phase 6), stored outside `definition`. */
const templateBody = templateDefinition.extend({ biometricPolicy: biometricOverride.optional() })
const split = (body: z.infer<typeof templateBody>) => {
  const { biometricPolicy, ...definition } = body
  // Omitted: keep the stored policy (undefined leaves the column out of the UPDATE). inherit: clear it.
  if (!biometricPolicy) return { definition, biometricPolicy: undefined }
  return { definition, biometricPolicy: biometricPolicy.mode === 'inherit' ? null : (biometricPolicy as Record<string, unknown>) }
}

export const proofTemplateRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => request.tenant as TenantContext
  const editor = (request: { tenant?: TenantContext }) => requireConsolePrincipal(request.tenant as TenantContext, 'proof templates are managed from the console')
  const writeTags = ['proofs', CONSOLE_ONLY_TAG]

  app.post(
    '/v1/proof-templates',
    {
      schema: {
        tags: writeTags,
        summary: 'Create a proof template',
        description: 'Each group discloses attributes from one credential and may add integer predicates. Credentials are referenced by schema name (all versions, or active only) or by credential definition id. `expiresAt` is always predicated and can never be disclosed. `biometricPolicy` (optional) overrides the tenant\'s biometric default for requests made from this template.',
        body: templateBody,
        response: { 201: templateView, 400: errorBody, 403: errorBody },
      },
    },
    async (request, reply) => {
      const { definition, biometricPolicy } = split(request.body)
      validateTemplate(definition)
      const [row] = await deps.db.insert(proofTemplates).values({ tenantId: editor(request).id, name: definition.name, definition, biometricPolicy }).returning()
      return reply.code(201).send(view(row))
    }
  )

  app.get(
    '/v1/proof-templates',
    {
      schema: {
        tags: ['proofs'],
        summary: 'List proof templates',
        description: 'Newest first (`createdAt` descending), paged with `page` and `pageSize`. `q` matches the name.',
        querystring: pageQuery.extend(searchQuery.shape),
        response: { 200: pageOf(templateView) },
      },
    },
    async (request) => {
      const filters: SQL[] = [eq(proofTemplates.tenantId, tenant(request).id)]
      if (request.query.q) filters.push(containsI(proofTemplates.name, request.query.q))
      const page = await listPage(deps.db, { table: proofTemplates, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(proofTemplates).where(where).orderBy(desc(proofTemplates.createdAt), desc(proofTemplates.id)).limit(limit).offset(offset)
      )
      return { ...page, items: page.items.map(view) }
    }
  )

  app.get('/v1/proof-templates/:id', { schema: { tags: ['proofs'], summary: 'Get a proof template', params: z.object({ id: z.uuid() }), response: { 200: templateView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(proofTemplates).where(and(eq(proofTemplates.tenantId, tenant(request).id), eq(proofTemplates.id, request.params.id)))
    if (!row) throw notFound('proof template')
    return view(row)
  })

  app.put('/v1/proof-templates/:id', { schema: { tags: writeTags, summary: 'Replace a proof template', params: z.object({ id: z.uuid() }), body: templateBody, response: { 200: templateView, 400: errorBody, 403: errorBody, 404: errorBody } } }, async (request) => {
    const t = editor(request)
    const { definition, biometricPolicy } = split(request.body)
    validateTemplate(definition)
    const [row] = await deps.db
      .update(proofTemplates)
      .set({ name: definition.name, definition, biometricPolicy, updatedAt: new Date() })
      .where(and(eq(proofTemplates.tenantId, t.id), eq(proofTemplates.id, request.params.id)))
      .returning()
    if (!row) throw notFound('proof template')
    return view(row)
  })

  app.get('/v1/proof-templates/:id/biometric-policy', { schema: { tags: ['proofs'], summary: 'Biometric policy of a proof template', params: z.object({ id: z.uuid() }), response: { 200: z.object({ templateId: z.string(), biometricPolicy: biometricOverride }), 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(proofTemplates).where(and(eq(proofTemplates.tenantId, tenant(request).id), eq(proofTemplates.id, request.params.id)))
    if (!row) throw notFound('proof template')
    return { templateId: row.id, biometricPolicy: view(row).biometricPolicy }
  })

  app.put(
    '/v1/proof-templates/:id/biometric-policy',
    {
      schema: {
        tags: writeTags,
        summary: 'Set the biometric policy of a proof template',
        description: '`inherit` follows the tenant default, `off` never gates, `required` gates with the given thresholds. Applies to proof requests made from this template after the change.',
        params: z.object({ id: z.uuid() }),
        body: biometricOverride,
        response: { 200: z.object({ templateId: z.string(), biometricPolicy: biometricOverride }), 403: errorBody, 404: errorBody },
      },
    },
    async (request) => {
      const t = editor(request)
      const [row] = await deps.db
        .update(proofTemplates)
        .set({ biometricPolicy: request.body.mode === 'inherit' ? null : (request.body as Record<string, unknown>), updatedAt: new Date() })
        .where(and(eq(proofTemplates.tenantId, t.id), eq(proofTemplates.id, request.params.id)))
        .returning()
      if (!row) throw notFound('proof template')
      return { templateId: row.id, biometricPolicy: view(row).biometricPolicy }
    }
  )

  app.delete('/v1/proof-templates/:id', { schema: { tags: writeTags, summary: 'Delete a proof template', params: z.object({ id: z.uuid() }), response: { 200: z.object({ deleted: z.boolean() }), 403: errorBody, 404: errorBody } } }, async (request) => {
    const rows = await deps.db.delete(proofTemplates).where(and(eq(proofTemplates.tenantId, editor(request).id), eq(proofTemplates.id, request.params.id))).returning({ id: proofTemplates.id })
    if (rows.length === 0) throw notFound('proof template')
    return { deleted: true }
  })
}
