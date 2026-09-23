/**
 * Wallet and mediator housekeeping (review M10, M4), run on a timer by main.ts.
 *
 *   1. connected: a wallet not yet known to be connected gets `connected_at` when the mediator holds a
 *      connection made from its invitation (read-only query by out-of-band id, `platform_ro`). The
 *      wake path sets it too, on the first mediator webhook.
 *   2. never connected: a wallet still without a connection `unconnectedRevokeDays` after creation is
 *      revoked with `revoked_reason = 'never_connected'`. No message can have reached it, so the end
 *      user loses nothing; the app gets a 401 and its backend creates a new wallet.
 *   3. revoked: `revokedGraceDays` after any revocation, the wallet's mediator connection, mediation
 *      and queued messages are removed, so the mediator stops relaying for a wallet nobody maps.
 *   4. mediator: single-use invitations nobody accepted (`invitationTtlHours`) and queued messages
 *      older than `queueTtlDays` are deleted.
 *
 * Every step is idempotent (updates are guarded by the state they change, the mediator routes accept
 * a repeat), so a second replica running the same pass does no harm.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { Database } from './db/client.ts'
import { wallets } from './db/schema.ts'
import type { MediatorClient } from './mediator-client.ts'

export interface SweepDeps {
  db: Database
  mediator: Pick<MediatorClient, 'connectionsForOutOfBandIds' | 'removeConnection' | 'sweep'>
  logger: PinoLogger
  unconnectedRevokeDays: number
  revokedGraceDays: number
  invitationTtlHours: number
  queueTtlDays: number
  now?: () => Date
  batch?: number
}

export interface SweepReport {
  connected: number
  revokedNeverConnected: number
  mediationRemoved: number
  invitationsDeleted: number
  queuedDeleted: number
}

const DAY = 24 * 60 * 60 * 1000

export async function sweepOnce(deps: SweepDeps): Promise<SweepReport> {
  const now = deps.now?.() ?? new Date()
  const batch = deps.batch ?? 500
  const report: SweepReport = { connected: 0, revokedNeverConnected: 0, mediationRemoved: 0, invitationsDeleted: 0, queuedDeleted: 0 }
  const revokeBefore = new Date(now.getTime() - deps.unconnectedRevokeDays * DAY)

  // 1 + 2: every live wallet not yet known to be connected, in id order.
  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const page = await deps.db
      .select({ id: wallets.id, oobId: wallets.mediatorOobId, connectionId: wallets.mediatorConnectionId, createdAt: wallets.createdAt })
      .from(wallets)
      .where(and(isNull(wallets.revokedAt), isNull(wallets.connectedAt), gt(wallets.id, after)))
      .orderBy(asc(wallets.id))
      .limit(batch)
    if (page.length === 0) break
    after = page[page.length - 1].id
    const oobIds = page.map((w) => w.oobId).filter((id): id is string => id !== null)
    const found = await deps.mediator.connectionsForOutOfBandIds(oobIds)
    const connected = page.filter((w) => w.connectionId !== null || (w.oobId !== null && found.has(w.oobId))).map((w) => w.id)
    if (connected.length > 0) {
      const rows = await deps.db.update(wallets).set({ connectedAt: now }).where(and(inArray(wallets.id, connected), isNull(wallets.connectedAt))).returning({ id: wallets.id })
      report.connected += rows.length
    }
    const stale = page.filter((w) => !connected.includes(w.id) && w.createdAt < revokeBefore).map((w) => w.id)
    if (stale.length > 0) {
      const rows = await deps.db
        .update(wallets)
        .set({ revokedAt: now, revokedReason: 'never_connected' })
        .where(and(inArray(wallets.id, stale), isNull(wallets.revokedAt), isNull(wallets.connectedAt)))
        .returning({ id: wallets.id })
      report.revokedNeverConnected += rows.length
    }
    if (page.length < batch) break
  }

  // 3: revoked long enough ago; remove what the mediator still holds for them.
  const graceBefore = new Date(now.getTime() - deps.revokedGraceDays * DAY)
  for (;;) {
    const page = await deps.db
      .select({ id: wallets.id, oobId: wallets.mediatorOobId, connectionId: wallets.mediatorConnectionId })
      .from(wallets)
      .where(and(isNotNull(wallets.revokedAt), lt(wallets.revokedAt, graceBefore), isNull(wallets.mediationRemovedAt)))
      .orderBy(asc(wallets.id))
      .limit(batch)
    if (page.length === 0) break
    const found = await deps.mediator.connectionsForOutOfBandIds(page.map((w) => w.oobId).filter((id): id is string => id !== null))
    for (const wallet of page) {
      const connectionIds = new Set<string>([...(wallet.connectionId ? [wallet.connectionId] : []), ...(wallet.oobId ? (found.get(wallet.oobId) ?? []) : [])])
      for (const connectionId of connectionIds) await deps.mediator.removeConnection(connectionId)
      await deps.db.update(wallets).set({ mediationRemovedAt: now }).where(eq(wallets.id, wallet.id))
      report.mediationRemoved += 1
    }
    if (page.length < batch) break
  }

  // 4: the mediator's own leftovers.
  const swept = await deps.mediator.sweep({ invitationsOlderThanHours: deps.invitationTtlHours, queuedOlderThanDays: deps.queueTtlDays })
  report.invitationsDeleted = swept.invitations
  report.queuedDeleted = swept.queued

  deps.logger.info({ component: 'sweep', ...report }, 'wallet and mediator sweep done')
  return report
}

/** Runs `sweepOnce` every `intervalMs` (first pass after a minute). Returns a stop function. */
export function startSweep(deps: SweepDeps, intervalMs: number) {
  let stopped = false
  let running: Promise<unknown> = Promise.resolve()
  const tick = () => {
    if (stopped) return
    running = sweepOnce(deps).catch((error: unknown) => deps.logger.error({ err: error, component: 'sweep' }, 'wallet and mediator sweep failed'))
  }
  const first = setTimeout(tick, Math.min(60_000, intervalMs))
  const timer = setInterval(tick, intervalMs)
  return async () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
    await running
  }
}

