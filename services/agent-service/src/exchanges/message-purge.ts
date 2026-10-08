/**
 * Deletes a finished exchange's stored DIDComm messages (offer, request, credential; request,
 * presentation) from the tenant wallet, and keeps the exchange record.
 *
 * Why: Credo finds a stored message through four or five encrypted tags, most of which hold the same
 * value on every message, so each lookup costs more with every message the tenant keeps
 * (19-phase-9-production-findings.md, "After v0.2.0"). Without this the messages stay until the
 * platform's retention erases the exchange.
 *
 * When: only after the platform acknowledged the final outbox row. Its consumer reads the messages
 * once more at the final state (a proof's disclosed attributes, a credential's definition id), and
 * it acknowledges a batch after applying all of it.
 */
import { DidCommMessageRepository } from '@credo-ts/didcomm'
import { and, gt, inArray } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { RootAgent } from '../agent/root-agent.ts'
import type { Database } from '../db/client.ts'
import { outbox, outboxPurgeDue } from '../db/schema.ts'

export interface PurgeOptions {
  batch?: number
  /** Checked between batches and tenants, so a shutdown does not wait for a backlog. */
  stopped?: () => boolean
}

/** One run over every due row. Returns how many exchanges were purged and how many messages that deleted. */
export async function purgeFinishedMessages(agent: RootAgent, db: Database, logger: PinoLogger, options: PurgeOptions = {}) {
  const batch = options.batch ?? 200
  const stopped = options.stopped ?? (() => false)
  let exchanges = 0
  let messages = 0
  // A row that fails stays due for the next run; the cursor keeps this run moving past it.
  let afterId = 0
  while (!stopped()) {
    const due = await db
      .select({ id: outbox.id, tenantId: outbox.tenantId, recordId: outbox.recordId })
      .from(outbox)
      .where(and(gt(outbox.id, afterId), outboxPurgeDue(outbox)))
      .orderBy(outbox.id)
      .limit(batch)
    if (due.length === 0) break
    afterId = due[due.length - 1].id

    const byTenant = new Map<string, typeof due>()
    for (const row of due) byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row])

    for (const [tenantId, rows] of byTenant) {
      if (stopped()) break
      const purged: number[] = []
      await agent.modules.tenants
        .withTenantAgent({ tenantId }, async (t) => {
          const repository = t.dependencyManager.resolve(DidCommMessageRepository)
          for (const row of rows) {
            try {
              // The same lookup and delete as Credo's deleteById(..., { deleteAssociatedDidCommMessages: true }).
              const stored = await repository.findByQuery(t.context, { associatedRecordId: row.recordId })
              for (const message of stored) await repository.delete(t.context, message)
              messages += stored.length
              purged.push(row.id)
            } catch (error) {
              logger.warn({ err: error, tenantId, recordId: row.recordId }, 'could not delete stored messages; retried on the next run')
            }
          }
        })
        .catch((error: unknown) => logger.error({ err: error, tenantId }, 'message purge failed for tenant'))
      if (purged.length > 0) {
        await db.update(outbox).set({ messagesPurgedAt: new Date() }).where(inArray(outbox.id, purged))
        exchanges += purged.length
      }
    }
    if (due.length < batch) break
  }
  return { exchanges, messages }
}

/** Runs `purgeFinishedMessages` every `intervalMs` (0 = off), one run at a time. Returns a stop function. */
export function startMessagePurge(agent: RootAgent, db: Database, options: { intervalMs: number }, logger: PinoLogger) {
  const log = logger.child({ component: 'message-purge' })
  if (options.intervalMs <= 0) return async () => undefined
  let stopped = false
  let running: Promise<unknown> | null = null
  const timer = setInterval(() => {
    if (running) return
    running = purgeFinishedMessages(agent, db, log, { stopped: () => stopped })
      .then(
        (result) => result.exchanges > 0 && log.info(result, 'stored messages of finished exchanges deleted'),
        (error: unknown) => log.error({ err: error }, 'message purge failed')
      )
      .finally(() => {
        running = null
      })
  }, options.intervalMs)
  return async () => {
    stopped = true
    clearInterval(timer)
    await running
  }
}
