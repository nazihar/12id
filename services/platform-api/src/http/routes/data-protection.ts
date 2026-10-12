/**
 * Data protection settings and log (Phase 7 H1):
 *   - the tenant's retention period: read by anyone of the tenant, changed from the console only, by an
 *     owner, admin or operator (review K1: setup is the console's);
 *   - the erasure log: every erasure made on request, with who and why, never the data;
 *   - the audit log's own period (implement/22 C15): console only, read and changed by the same roles.
 *     It is a separate setting, and a longer one, because the audit outlasts the data it describes.
 */
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { AUDIT_RETENTION_MAX_DAYS, AUDIT_RETENTION_MIN_DAYS, effectiveAuditRetentionDays, validAuditRetentionDays } from '../../audit-retention.ts'
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

const auditRetentionView = z.object({
  auditRetentionDays: z.number().int().describe('The period in force, in days; 0 = audit rows are kept.'),
  tenantSetting: z.number().int().nullable().describe('The tenant\'s own setting; null = the deployment default applies.'),
  platformDefault: z.number().int(),
  minimumDays: z.number().int().describe('The shortest period that can be set (other than 0).'),
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

export const dataProtectionRoutes = (deps: { db: Database; defaultRetentionDays: number; defaultAuditRetentionDays: number }): FastifyPluginAsyncZod => async (app) => {
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

  // --- the audit log's period (console only) ---------------------------------------------------
  const auditView = (tenantSetting: number | null) => ({
    auditRetentionDays: effectiveAuditRetentionDays(tenantSetting, deps.defaultAuditRetentionDays),
    tenantSetting,
    platformDefault: deps.defaultAuditRetentionDays,
    minimumDays: AUDIT_RETENTION_MIN_DAYS,
  })
  const auditTags = ['data protection', CONSOLE_ONLY_TAG]

  app.get(
    '/v1/audit-retention',
    {
      schema: {
        tags: auditTags,
        summary: 'Get the audit log period',
        description: 'How long an audit row of this tenant is kept before it is deleted. Sign-ins and rows that belong to no tenant follow the deployment default.',
        response: { 200: auditRetentionView, 403: errorBody },
      },
    },
    async (request) => {
      const t = requireConsolePrincipal(tenant(request), 'the audit log period is read in the console')
      const [row] = await deps.db.select({ auditRetentionDays: tenants.auditRetentionDays }).from(tenants).where(eq(tenants.id, t.id))
      return auditView(row?.auditRetentionDays ?? null)
    }
  )

  app.put(
    '/v1/audit-retention',
    {
      schema: {
        tags: auditTags,
        summary: 'Set the audit log period',
        body: z.object({
          auditRetentionDays: z
            .number()
            .int()
            .refine(validAuditRetentionDays, `must be 0 (keep) or ${AUDIT_RETENTION_MIN_DAYS} to ${AUDIT_RETENTION_MAX_DAYS}`)
            .nullable()
            .describe('Days, a year to ten years; 0 = keep everything; null = the deployment default.'),
        }),
        response: { 200: auditRetentionView, 400: errorBody, 403: errorBody },
      },
    },
    async (request) => {
      const t = requireConsolePrincipal(tenant(request), 'the audit log period is set in the console')
      if (t.principal.kind === 'console' && t.principal.role === 'member') throw new PlatformError(403, 'forbidden', 'members cannot change the audit log period')
      await deps.db.update(tenants).set({ auditRetentionDays: request.body.auditRetentionDays, updatedAt: new Date() }).where(eq(tenants.id, t.id))
      return auditView(request.body.auditRetentionDays)
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
