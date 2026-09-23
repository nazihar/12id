/**
 * Webhook delivery worker (P7). Postgres is the queue:
 *   claim:   SELECT … WHERE status='pending' AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED
 *            → status='sending' (one transaction, so several replicas could share the table);
 *   deliver: POST with the signed body to the endpoint's current URL, 2xx = delivered;
 *   retry:   exponential backoff with jitter, capped at one hour; after `maxAttempts` → dead.
 *
 * Deliveries run concurrently in a pool of `concurrency` slots, shared fairly (review M2): the
 * claim takes each tenant's oldest due row first, then each tenant's second, and so on; and while
 * other tenants have deliveries due, a tenant already holding `perTenant` slots is skipped. When
 * nobody else is waiting, one tenant may use every slot, so a single-tenant install is never
 * throttled. A slow endpoint therefore delays only its own tenant's deliveries.
 *
 * A crash mid-send leaves rows in `sending`; `recoverStale` returns them to `pending` on start.
 * Ordering across deliveries is not guaranteed: consumers must use the event's `state` and
 * `updatedAt`, not arrival order.
 */
import { and, eq, lte, sql } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { Database } from '../db/client.ts'
import { webhookDeliveries, webhookEndpoints } from '../db/schema.ts'
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signPayload, signingSecrets } from './signer.ts'

export interface DispatcherOptions {
  db: Database
  logger: PinoLogger
  timeoutMs: number
  maxAttempts: number
  /** Deliveries in flight at once (default 8). */
  concurrency?: number
  /** Slots one tenant may hold while other tenants have deliveries due (default 2). */
  perTenant?: number
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

/** One HTTP attempt; never throws. `secrets` newest first (several during a rotation). */
export async function deliverOnce(
  doFetch: typeof fetch,
  delivery: { url: string; body: string; eventType: string; eventId: string; secrets: string | string[] },
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
        [SIGNATURE_HEADER]: signPayload(delivery.secrets, delivery.body, nowSeconds),
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

type Claimed = { id: number; tenantId: string; eventId: string; eventType: string; body: string; attempts: number }

export function createDispatcher(options: DispatcherOptions) {
  const log = options.logger.child({ component: 'webhooks' })
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const random = options.random ?? Math.random
  const concurrency = options.concurrency ?? 8
  const perTenant = options.perTenant ?? 2
  let inFlight = 0
  const tenantInFlight = new Map<string, number>()
  let onSlotFreed: (() => void) | undefined

  /** Up to `limit` due rows, round-robin across tenants, skipping `exclude`. Marks them `sending`. */
  async function claim(limit: number, exclude: string[]): Promise<Claimed[]> {
    if (limit <= 0) return []
    return options.db.transaction(async (tx) => {
      const skip = exclude.length > 0 ? sql`and tenant_id not in (${sql.join(exclude.map((tenantId) => sql`${tenantId}::uuid`), sql`, `)})` : sql``
      const due = await tx.execute<{ id: number }>(sql`
        select id from ${webhookDeliveries} where id in (
          select id from (
            select id, next_attempt_at, row_number() over (partition by tenant_id order by next_attempt_at, id) as turn
            from ${webhookDeliveries}
            where status = 'pending' and next_attempt_at <= ${now()} ${skip}
          ) ranked
          order by turn, next_attempt_at
          limit ${limit}
        )
        for update skip locked`)
      const ids = due.rows.map((row) => Number(row.id))
      if (ids.length === 0) return []
      return tx
        .update(webhookDeliveries)
        // next_attempt_at doubles as the claim time, which is what recoverStale measures against.
        .set({ status: 'sending', nextAttemptAt: now() })
        .where(sql`${webhookDeliveries.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
        .returning({ id: webhookDeliveries.id, tenantId: webhookDeliveries.tenantId, eventId: webhookDeliveries.eventId, eventType: webhookDeliveries.eventType, body: webhookDeliveries.body, attempts: webhookDeliveries.attempts })
    })
  }

  /** One attempt, recorded. The URL and secrets are the endpoint's current ones (review M8, M9). */
  async function attempt(delivery: Claimed) {
    const [endpoint] = await options.db
      .select({ url: webhookEndpoints.url, secret: webhookEndpoints.secret, previousSecret: webhookEndpoints.previousSecret, rotatedAt: webhookEndpoints.rotatedAt })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.tenantId, delivery.tenantId))
    const attemptNo = delivery.attempts + 1
    const sentAt = now()
    const result: DeliveryAttempt = endpoint
      ? await deliverOnce(doFetch, { ...delivery, url: endpoint.url, secrets: signingSecrets(endpoint, sentAt) }, options.timeoutMs, Math.floor(sentAt.getTime() / 1000))
      : { ok: false, error: 'webhook endpoint removed' }
    // Record where this attempt went; a removed endpoint leaves the last URL in place.
    const sentTo = endpoint ? { url: endpoint.url } : {}
    if (result.ok) {
      await options.db.update(webhookDeliveries).set({ status: 'delivered', attempts: attemptNo, lastStatusCode: result.statusCode ?? null, lastError: null, deliveredAt: now(), ...sentTo }).where(eq(webhookDeliveries.id, delivery.id))
      log.info({ deliveryId: delivery.id, tenantId: delivery.tenantId, eventType: delivery.eventType, attempt: attemptNo }, 'webhook delivered')
      return
    }
    const dead = attemptNo >= options.maxAttempts || !endpoint
    const error = result.error ?? `HTTP ${result.statusCode}`
    await options.db
      .update(webhookDeliveries)
      .set({
        status: dead ? 'dead' : 'pending',
        attempts: attemptNo,
        lastStatusCode: result.statusCode ?? null,
        lastError: error.slice(0, 500),
        nextAttemptAt: dead ? now() : new Date(now().getTime() + backoffMs(attemptNo, random)),
        ...sentTo,
      })
      .where(eq(webhookDeliveries.id, delivery.id))
    log[dead ? 'error' : 'warn']({ deliveryId: delivery.id, tenantId: delivery.tenantId, eventType: delivery.eventType, attempt: attemptNo, error, statusCode: result.statusCode }, dead ? 'webhook dead-lettered' : 'webhook attempt failed')
  }

  function launch(delivery: Claimed): Promise<void> {
    inFlight += 1
    tenantInFlight.set(delivery.tenantId, (tenantInFlight.get(delivery.tenantId) ?? 0) + 1)
    return attempt(delivery)
      .catch((error: unknown) => log.error({ err: error, deliveryId: delivery.id }, 'webhook attempt crashed'))
      .finally(() => {
        inFlight -= 1
        const left = (tenantInFlight.get(delivery.tenantId) ?? 1) - 1
        if (left > 0) tenantInFlight.set(delivery.tenantId, left)
        else tenantInFlight.delete(delivery.tenantId)
        onSlotFreed?.()
      })
  }

  /** Claims into the free slots and starts each delivery. Resolves once they have started. */
  async function fill(): Promise<Array<Promise<void>>> {
    const free = concurrency - inFlight
    if (free <= 0) return []
    const busy = [...tenantInFlight].filter(([, n]) => n >= perTenant).map(([tenantId]) => tenantId)
    let rows = await claim(free, busy)
    // Nobody else is waiting: the tenants at their share may take the remaining slots.
    if (rows.length < free && busy.length > 0) rows = rows.concat(await claim(free - rows.length, []))
    return rows.map(launch)
  }

  /** Claims due deliveries into the free slots and waits for those attempts. Returns how many ran. */
  async function runOnce(): Promise<number> {
    const started = await fill()
    await Promise.all(started)
    return started.length
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
    let filling = false
    let again = false
    const pump = async () => {
      if (stopped) return
      if (filling) {
        again = true
        return
      }
      filling = true
      try {
        do {
          again = false
          await fill()
        } while (again && !stopped)
      } catch (error) {
        log.error({ err: error }, 'webhook worker tick failed')
      } finally {
        filling = false
      }
    }
    // A finished attempt frees a slot: refill at once instead of waiting for the next poll.
    onSlotFreed = () => void pump()
    const tick = async () => {
      await pump()
      if (!stopped) timer = setTimeout(tick, pollMs)
    }
    void recoverStale().then(tick, tick)
    return async () => {
      stopped = true
      onSlotFreed = undefined
      if (timer) clearTimeout(timer)
    }
  }

  return { runOnce, recoverStale, start, inFlight: () => inFlight }
}

export type Dispatcher = ReturnType<typeof createDispatcher>
