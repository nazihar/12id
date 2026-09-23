/**
 * The §4.8 wake path, server half (P7). The mediator POSTs `{ connectionId }` once per message
 * it queues for a holder; the platform maps that to a wallet and tells the customer backend to
 * push the device (`wallet.sync_requested`). The platform holds no push credentials.
 *
 * Mapping: mediator connection id → its out-of-band id (read-only query on the mediator's
 * database) → the wallet the invitation was minted for. Cached on the wallet row after the
 * first hit. Debounced per wallet, because the mediator fires even while the app is polling.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { Database } from './db/client.ts'
import { wallets } from './db/schema.ts'
import type { MediatorClient } from './mediator-client.ts'
import { type EndpointLookup, enqueueEvent } from './webhooks/events.ts'

export interface WakeDeps {
  db: Database
  mediator: Pick<MediatorClient, 'outOfBandIdForConnection'>
  endpoints: EndpointLookup
  logger: PinoLogger
  debounceMs: number
  now?: () => Date
}

export type WakeOutcome = 'unknown_connection' | 'debounced' | 'no_endpoint' | 'requested'

export async function handleMediatorWebhook(deps: WakeDeps, connectionId: string): Promise<WakeOutcome> {
  const now = deps.now?.() ?? new Date()
  let [wallet] = await deps.db.select().from(wallets).where(and(eq(wallets.mediatorConnectionId, connectionId), isNull(wallets.revokedAt)))
  if (!wallet) {
    const oobId = await deps.mediator.outOfBandIdForConnection(connectionId)
    if (!oobId) return 'unknown_connection'
    ;[wallet] = await deps.db.select().from(wallets).where(and(eq(wallets.mediatorOobId, oobId), isNull(wallets.revokedAt)))
    if (!wallet) return 'unknown_connection'
    // The first webhook for a connection also proves the wallet connected (review M10).
    await deps.db.update(wallets).set({ mediatorConnectionId: connectionId, connectedAt: wallet.connectedAt ?? now }).where(eq(wallets.id, wallet.id))
  }
  if (wallet.lastSyncRequestedAt && now.getTime() - wallet.lastSyncRequestedAt.getTime() < deps.debounceMs) return 'debounced'

  // Claim the window atomically so two webhooks in the same instant emit one event.
  const claimed = await deps.db
    .update(wallets)
    .set({ lastSyncRequestedAt: now })
    .where(and(eq(wallets.id, wallet.id), wallet.lastSyncRequestedAt ? eq(wallets.lastSyncRequestedAt, wallet.lastSyncRequestedAt) : isNull(wallets.lastSyncRequestedAt)))
    .returning({ id: wallets.id })
  if (claimed.length === 0) return 'debounced'

  const deliveryId = await enqueueEvent(deps.db, deps.endpoints, wallet.tenantId, 'wallet.sync_requested', {
    walletId: wallet.id,
    externalId: wallet.externalId,
    requestedAt: now.toISOString(),
  })
  deps.logger.info({ walletId: wallet.id, tenantId: wallet.tenantId, deliveryId }, 'wallet sync requested')
  return deliveryId === null ? 'no_endpoint' : 'requested'
}
