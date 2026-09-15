/**
 * Optional `Idempotency-Key` on customer POSTs and PUTs (P3). Same tenant + key + same body → the
 * stored response is replayed; same key with a different body → 422. Entries expire after a TTL.
 *
 * The key is reserved when the request arrives, so two requests with the same key never both run:
 * the second answers 409 `idempotency_in_progress` until the first finishes. A 5xx releases the
 * key (the request may be retried as new); a reservation older than a minute is taken over, which
 * covers a process that died mid-request.
 *
 * Routes whose response holds a secret either opt out (`idempotency: false`) or store a redacted
 * body and answer replays themselves (`idempotency: { store, replay }`): no secret is ever stored.
 */
import { createHash } from 'node:crypto'

import { and, eq, isNull, lt } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Database } from '../db/client.ts'
import { idempotencyKeys } from '../db/schema.ts'

export const IDEMPOTENCY_HEADER = 'idempotency-key'
export const IN_PROGRESS_TAKEOVER_MS = 60_000

export interface IdempotencyReplay {
  /** What is stored instead of a 2xx response body; drop secrets here. */
  store: (body: unknown) => unknown
  /** Answers a replay of a 2xx response from what `store` kept. */
  replay: (request: FastifyRequest, reply: FastifyReply, stored: { statusCode: number; body: unknown }) => Promise<FastifyReply>
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `false`: no idempotency for the route. An object: redacted storage and a custom replay. */
    idempotency?: false | IdempotencyReplay
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

/** Registers the two hooks on a scope whose routes are all tenant-authenticated. */
export function useIdempotency(app: FastifyInstance, db: Database) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'POST' && request.method !== 'PUT') return
    const config = request.routeOptions.config?.idempotency
    if (config === false) return
    const key = request.headers[IDEMPOTENCY_HEADER]
    if (typeof key !== 'string' || key.length === 0) return
    if (key.length > 200) return reply.code(400).send({ error: 'bad_request', reason: 'Idempotency-Key is longer than 200 characters' })
    const tenant = request.tenant
    if (!tenant) return
    const hash = requestHash(request.method, request.url, request.body)
    const row = and(eq(idempotencyKeys.tenantId, tenant.id), eq(idempotencyKeys.key, key))

    const reserved = await db.insert(idempotencyKeys).values({ tenantId: tenant.id, key, requestHash: hash }).onConflictDoNothing().returning({ key: idempotencyKeys.key })
    if (reserved.length === 1) {
      request.idempotency = { key, requestHash: hash }
      return
    }

    const [stored] = await db.select().from(idempotencyKeys).where(row)
    if (stored && stored.requestHash !== hash) {
      return reply.code(422).send({ error: 'idempotency_mismatch', reason: 'Idempotency-Key was already used with a different request' })
    }
    if (!stored || stored.completedAt === null || stored.statusCode === null) {
      const takenOver = await db
        .update(idempotencyKeys)
        .set({ createdAt: new Date() })
        .where(and(row, isNull(idempotencyKeys.completedAt), lt(idempotencyKeys.createdAt, new Date(Date.now() - IN_PROGRESS_TAKEOVER_MS))))
        .returning({ key: idempotencyKeys.key })
      if (takenOver.length === 1) {
        request.idempotency = { key, requestHash: hash }
        return
      }
      return reply
        .code(409)
        .header('retry-after', '1')
        .send({ error: 'idempotency_in_progress', reason: 'A request with this Idempotency-Key is still being processed; retry shortly' })
    }

    reply.header('idempotent-replayed', 'true')
    if (config && stored.statusCode < 300) {
      return config.replay(request, reply, { statusCode: stored.statusCode, body: JSON.parse(stored.responseBody ?? 'null') })
    }
    return reply.code(stored.statusCode).send(stored.responseBody)
  })

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const marker = request.idempotency
    if (!marker || !request.tenant) return payload
    const row = and(eq(idempotencyKeys.tenantId, request.tenant.id), eq(idempotencyKeys.key, marker.key))
    if (reply.statusCode >= 500) {
      await db.delete(idempotencyKeys).where(and(row, isNull(idempotencyKeys.completedAt)))
      return payload
    }
    let body = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : JSON.stringify(payload ?? null)
    const config = request.routeOptions.config?.idempotency
    if (config && reply.statusCode < 300) body = JSON.stringify(config.store(JSON.parse(body)))
    await db.update(idempotencyKeys).set({ statusCode: reply.statusCode, responseBody: body, completedAt: new Date() }).where(row)
    return payload
  })
}

export async function expireIdempotencyKeys(db: Database, ttlMs: number) {
  const result = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - ttlMs)))
  return result.rowCount ?? 0
}
