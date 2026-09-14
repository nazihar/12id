/**
 * Outbox feed for the platform API (Phase 3 P0). The consumer keeps its own cursor and polls
 * `id > afterId`; `ack` only records delivery for observability.
 *
 * Ordering caveat: outbox rows are inserted asynchronously by the listener, so a row with a
 * lower id can commit *after* a higher one was already read. Rows younger than `settleMs` are
 * held back, which closes that window for anything but a stalled insert.
 */
import { and, gt, lte, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../db/client.ts'
import { outbox } from '../db/schema.ts'

export interface OutboxDeps {
  db: Database
  /** Rows younger than this are not served yet. Default 2 s. */
  settleMs?: number
}

export const outboxRowView = z.object({
  id: z.number().int(),
  tenantId: z.string(),
  recordType: z.enum(['connection', 'credential', 'proof']),
  recordId: z.string(),
  threadId: z.string().nullable(),
  state: z.string(),
  previousState: z.string().nullable(),
  correlationId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
})
export type OutboxRowView = z.infer<typeof outboxRowView>

export const outboxRoutes = (deps: OutboxDeps): FastifyPluginAsyncZod => async (app) => {
  const settleMs = deps.settleMs ?? 2_000

  app.get(
    '/outbox',
    { schema: { querystring: z.object({ afterId: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }), response: { 200: z.object({ rows: z.array(outboxRowView) }) } } },
    async (request) => {
      const settled = new Date(Date.now() - settleMs)
      const rows = await deps.db
        .select()
        .from(outbox)
        .where(and(gt(outbox.id, request.query.afterId), lte(outbox.createdAt, settled)))
        .orderBy(outbox.id)
        .limit(request.query.limit)
      return { rows }
    }
  )

  app.post('/outbox/ack', { schema: { body: z.object({ upToId: z.number().int().min(0) }), response: { 200: z.object({ acknowledged: z.number().int() }) } } }, async (request) => {
    const result = await deps.db
      .update(outbox)
      .set({ deliveredAt: new Date() })
      .where(and(lte(outbox.id, request.body.upToId), sql`${outbox.deliveredAt} is null`))
    return { acknowledged: result.rowCount ?? 0 }
  })
}
