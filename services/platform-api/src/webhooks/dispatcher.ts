/**
 * Webhook delivery worker (P7). Postgres is the queue:
 *   claim:   SELECT … WHERE status='pending' AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED
 *            → status='sending' (one transaction, so several replicas could share the table);
 *   deliver: POST with the signed body, 2xx = delivered;
 *   retry:   exponential backoff with jitter, capped at one hour; after `maxAttempts` → dead.
 *
 * A crash mid-send leaves rows in `sending`; `recoverStale` returns them to `pending` on start.
 * Ordering across deliveries is not guaranteed: consumers must use the event's `state` and
 * `updatedAt`, not arrival order.
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { Database } from '../db/client.ts'
import { webhookDeliveries, webhookEndpoints } from '../db/schema.ts'
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signPayload } from './signer.ts'

export interface DispatcherOptions {
  db: Database
  logger: PinoLogger
  timeoutMs: number
  maxAttempts: number
  batch?: number
  fetch?: typeof fetch
  now?: () => Date
  random?: () => number
}

/** 5 s, 10 s, 20 s, … capped at 1 h, ±20 % jitter. Pure, for tests. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 3_600_000)
  const jitter = 1 + (random() * 0.4 - 0.2)
  return Math.round(base * jitter)
}

export interface DeliveryAttempt {
  ok: boolean
  statusCode?: number
  error?: string
}

/** One HTTP attempt; never throws. */
export async function deliverOnce(
  doFetch: typeof fetch,
  delivery: { url: string; body: string; eventType: string; eventId: string; secret: string },
  timeoutMs: number,
  nowSeconds: number
): Promise<DeliveryAttempt> {
  try {
    const response = await doFetch(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': '12id-webhooks/1',
        [EVENT_HEADER]: delivery.eventType,
        [DELIVERY_HEADER]: delivery.eventId,
        [SIGNATURE_HEADER]: signPayload(delivery.secret, delivery.body, nowSeconds),
      },
      body: delivery.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Drain the body so the socket is reusable; the content is irrelevant.
    await response.arrayBuffer().catch(() => undefined)
    return { ok: response.status >= 200 && response.status < 300, statusCode: response.status }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

export function createDispatcher(options: DispatcherOptions) {
  const log = options.logger.child({ component: 'webhooks' })
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const random = options.random ?? Math.random
  const batch = options.batch ?? 20
  let inFlight = 0

  async function claim() {
    return options.db.transaction(async (tx) => {
      const due = await tx.execute<{ id: number }>(
        sql`select id from ${webhookDeliveries} where ${webhookDeliveries.status} = 'pending' and ${webhookDeliveries.nextAttemptAt} <= ${now()} order by ${webhookDeliveries.nextAttemptAt} limit ${batch} for update skip locked`
      )
      const ids = due.rows.map((row) => Number(row.id))
      if (ids.length === 0) return []
      return tx
        .update(webhookDeliveries)
        // next_attempt_at doubles as the claim time, which is what recoverStale measures against.
        .set({ status: 'sending', nextAttemptAt: now() })
        .where(inArray(webhookDeliveries.id, ids))
        .returning({ id: webhookDeliveries.id, tenantId: webhookDeliveries.tenantId, eventId: webhookDeliveries.eventId, eventType: webhookDeliveries.eventType, body: webhookDeliveries.body, url: webhookDeliveries.url, attempts: webhookDeliveries.attempts })
    })
  }

  /** Claims due deliveries and attempts each once. Returns how many were attempted. */
  async function runOnce(): Promise<number> {
    const claimed = await claim()
    for (const delivery of claimed) {
      inFlight += 1
      try {
        const [endpoint] = await options.db.select({ secret: webhookEndpoints.secret }).from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, delivery.tenantId))
        const attempt = delivery.attempts + 1
        const result = endpoint
          ? await deliverOnce(doFetch, { ...delivery, secret: endpoint.secret }, options.timeoutMs, Math.floor(now().getTime() / 1000))
          : { ok: false, error: 'webhook endpoint removed' }
        if (result.ok) {
          await options.db.update(webhookDeliveries).set({ status: 'delivered', attempts: attempt, lastStatusCode: result.statusCode ?? null, lastError: null, deliveredAt: now() }).where(eq(webhookDeliveries.id, delivery.id))
          log.info({ deliveryId: delivery.id, tenantId: delivery.tenantId, eventType: delivery.eventType, attempt }, 'webhook delivered')
        } else {
          const dead = attempt >= options.maxAttempts || !endpoint
          const error = result.error ?? `HTTP ${result.statusCode}`
          await options.db
            .update(webhookDeliveries)
            .set({
              status: dead ? 'dead' : 'pending',
              attempts: attempt,
              lastStatusCode: result.statusCode ?? null,
              lastError: error.slice(0, 500),
              nextAttemptAt: dead ? now() : new Date(now().getTime() + backoffMs(attempt, random)),
            })
            .where(eq(webhookDeliveries.id, delivery.id))
          log[dead ? 'error' : 'warn']({ deliveryId: delivery.id, tenantId: delivery.tenantId, eventType: delivery.eventType, attempt, error, statusCode: result.statusCode }, dead ? 'webhook dead-lettered' : 'webhook attempt failed')
        }
      } finally {
        inFlight -= 1
      }
    }
    return claimed.length
  }

  /** Rows left in `sending` by a crash go back to `pending`. Call once at start. */
  async function recoverStale(olderThanMs = 120_000) {
    const cutoff = new Date(now().getTime() - olderThanMs)
    const result = await options.db
      .update(webhookDeliveries)
      .set({ status: 'pending' })
      .where(and(eq(webhookDeliveries.status, 'sending'), lte(webhookDeliveries.nextAttemptAt, cutoff)))
    if (result.rowCount) log.warn({ recovered: result.rowCount }, 'recovered stale sending deliveries')
    return result.rowCount ?? 0
  }

  function start(pollMs: number) {
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    const tick = async () => {
      if (stopped) return
      try {
        const attempted = await runOnce()
        // Keep going without waiting while there is a backlog.
        timer = setTimeout(tick, attempted > 0 ? 0 : pollMs)
      } catch (error) {
        log.error({ err: error }, 'webhook worker tick failed')
        timer = setTimeout(tick, pollMs)
      }
    }
    void recoverStale().then(tick, tick)
    return async () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  return { runOnce, recoverStale, start, inFlight: () => inFlight }
}

export type Dispatcher = ReturnType<typeof createDispatcher>
