/**
 * Optional `Idempotency-Key` on customer POSTs (P3). Same tenant + key + same body → the stored
 * response is replayed; same key with a different body → 422. Entries expire after a TTL.
 */
import { createHash } from 'node:crypto'

import { and, eq, lt } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Database } from '../db/client.ts'
import { idempotencyKeys } from '../db/schema.ts'

export const IDEMPOTENCY_HEADER = 'idempotency-key'

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `false` for routes whose response holds a secret that must not be stored for replays. */
    idempotency?: boolean
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { key: string; requestHash: string }
  }
}

export function requestHash(method: string, url: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${url}\n${JSON.stringify(body ?? null)}`).digest('hex')
}

/** Registers the two hooks on a scope whose routes are all API-key authenticated. */
export function useIdempotency(app: FastifyInstance, db: Database) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'POST' && request.method !== 'PUT') return
    if (request.routeOptions.config?.idempotency === false) return
    const key = request.headers[IDEMPOTENCY_HEADER]
    if (typeof key !== 'string' || key.length === 0) return
    if (key.length > 200) return reply.code(400).send({ error: 'bad_request', reason: 'Idempotency-Key is longer than 200 characters' })
    const tenant = request.tenant
    if (!tenant) return
    const hash = requestHash(request.method, request.url, request.body)
    const [stored] = await db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, tenant.id), eq(idempotencyKeys.key, key)))
    if (stored) {
      if (stored.requestHash !== hash) return reply.code(422).send({ error: 'idempotency_mismatch', reason: 'Idempotency-Key was already used with a different request' })
      return reply.code(stored.statusCode).header('idempotent-replayed', 'true').send(stored.responseBody)
    }
    request.idempotency = { key, requestHash: hash }
  })

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const marker = request.idempotency
    if (!marker || !request.tenant || reply.statusCode >= 500) return payload
    const body = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : JSON.stringify(payload ?? null)
    await db
      .insert(idempotencyKeys)
      .values({ tenantId: request.tenant.id, key: marker.key, requestHash: marker.requestHash, statusCode: reply.statusCode, responseBody: body })
      .onConflictDoNothing()
    return payload
  })
}

export async function expireIdempotencyKeys(db: Database, ttlMs: number) {
  const result = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - ttlMs)))
  return result.rowCount ?? 0
}
