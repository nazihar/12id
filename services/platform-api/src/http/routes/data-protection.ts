/**
 * Data protection settings and log (Phase 7 H1):
 *   - the tenant's retention period: read by anyone of the tenant, changed from the console only, by an
 *     owner, admin or operator (review K1: setup is the console's);
 *   - the erasure log: every erasure made on request, with who and why, never the data.
 */
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { ERASURE_RECORD_TYPES, erasures, tenants } from '../../db/schema.ts'
import { effectiveRetentionDays } from '../../retention.ts'
import { type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { PlatformError } from '../errors.ts'
import { listPage, newestFirst, pageOf, pageQuery } from '../list.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

const errorBody = z.object({ error: z.string(), reason: z.string() })
const MAX_DAYS = 3650

const retentionView = z.object({
  retentionDays: z.number().int().describe('The period in force, in days; 0 = kept until erased on request.'),
  tenantSetting: z.number().int().nullable().describe('The tenant\'s own setting; null = the platform default applies.'),
  platformDefault: z.number().int(),
})

const erasureView = z.object({
  id: z.number().int(),
  recordType: z.enum(ERASURE_RECORD_TYPES),
  recordId: z.string(),
  via: z.string().describe('`api_key` or `console`.'),
  actor: z.string().describe('The API key id, or the console user id.'),
  role: z.string().nullable(),
  reason: z.string().nullable(),
  at: z.iso.datetime(),
})

export const dataProtectionRoutes = (deps: { db: Database; defaultRetentionDays: number }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => request.tenant as TenantContext
  const view = (tenantSetting: number | null) => ({ retentionDays: effectiveRetentionDays(tenantSetting, deps.defaultRetentionDays), tenantSetting, platformDefault: deps.defaultRetentionDays })

  app.get(
    '/v1/data-retention',
    {
      schema: {
        tags: ['data protection'],
        summary: 'Get the retention period',
        description: 'How long the personal data of a finished exchange is kept before it is scrubbed: credential attribute values, disclosed proof values, webhook delivery bodies and biometric scores. The exchange records themselves stay. Changed in the console.',
        response: { 200: retentionView },
      },
    },
    async (request) => {
      const [row] = await deps.db.select({ retentionDays: tenants.retentionDays }).from(tenants).where(eq(tenants.id, tenant(request).id))
      return view(row?.retentionDays ?? null)
    }
  )

  app.put(
    '/v1/data-retention',
    {
      schema: {
        tags: ['data protection', CONSOLE_ONLY_TAG],
        summary: 'Set the retention period',
        body: z.object({ retentionDays: z.number().int().min(0).max(MAX_DAYS).nullable().describe('Days; 0 = keep until erased on request; null = the platform default.') }),
        response: { 200: retentionView, 403: errorBody },
      },
    },
    async (request) => {
      const t = requireConsolePrincipal(tenant(request), 'the retention period is set in the console')
      if (t.principal.kind === 'console' && t.principal.role === 'member') throw new PlatformError(403, 'forbidden', 'members cannot change the retention period')
      await deps.db.update(tenants).set({ retentionDays: request.body.retentionDays, updatedAt: new Date() }).where(eq(tenants.id, t.id))
      return view(request.body.retentionDays)
    }
  )

  app.get(
    '/v1/erasures',
    {
      schema: {
        tags: ['data protection'],
        summary: 'List erasures',
        description: 'Erasures made on request, newest first, paged. Scrubs made by the retention period are not listed; the exchange shows `erasedAt`.',
        querystring: pageQuery,
        response: { 200: pageOf(erasureView) },
      },
    },
    async (request) => {
      const where = [eq(erasures.tenantId, tenant(request).id)]
      const page = await listPage(deps.db, { table: erasures, where, ...request.query }, (w, limit, offset) =>
        deps.db.select().from(erasures).where(w).orderBy(...newestFirst(erasures.at, erasures.id)).limit(limit).offset(offset)
      )
      return { ...page, items: page.items.map((r) => ({ ...r, at: r.at.toISOString() })) }
    }
  )
}
