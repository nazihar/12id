/**
 * Outbox retention (Phase 7 H1). Rows the platform has acknowledged are only history: the platform's
 * mirror tables hold the state. They carry the customer's correlation id, so they are deleted once
 * they are `retentionDays` past acknowledgement. Unacknowledged rows are never touched, so a stopped
 * consumer loses nothing.
 */
import { and, isNotNull, lt, sql } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { Database } from '../db/client.ts'
import { outbox } from '../db/schema.ts'

const DAY = 24 * 60 * 60 * 1000

/** Deletes acknowledged rows older than the cutoff, in batches. Returns how many were deleted. */
export async function pruneOutbox(db: Database, retentionDays: number, now = new Date(), batch = 5_000): Promise<number> {
  if (retentionDays <= 0) return 0
  const cutoff = new Date(now.getTime() - retentionDays * DAY)
  let total = 0
  for (;;) {
    const due = db.select({ id: outbox.id }).from(outbox).where(and(isNotNull(outbox.deliveredAt), lt(outbox.deliveredAt, cutoff))).limit(batch)
    const result = await db.delete(outbox).where(sql`${outbox.id} in (${due})`)
    const deleted = result.rowCount ?? 0
    total += deleted
    if (deleted < batch) return total
  }
}

/** Runs `pruneOutbox` every `intervalMs`. Returns a stop function. */
export function startOutboxPrune(db: Database, options: { retentionDays: number; intervalMs: number }, logger: PinoLogger) {
  const log = logger.child({ component: 'outbox-prune' })
  if (options.retentionDays <= 0) return async () => undefined
  let running: Promise<unknown> = Promise.resolve()
  const timer = setInterval(() => {
    running = pruneOutbox(db, options.retentionDays).then(
      (deleted) => deleted > 0 && log.info({ deleted, retentionDays: options.retentionDays }, 'acknowledged outbox rows pruned'),
      (error: unknown) => log.error({ err: error }, 'outbox prune failed')
    )
  }, options.intervalMs)
  return async () => {
    clearInterval(timer)
    await running
  }
}
