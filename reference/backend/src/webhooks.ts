/**
 * 12id webhooks: how to check that an event really comes from the platform, and what this backend
 * does with each one. Everything in 12id is asynchronous, so these events are where the work happens.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type { Tenant } from './config.ts'
import type { Platform } from './platform.ts'
import type { Store, User } from './store.ts'

export interface WebhookEvent {
  id: string
  type: string
  createdAt: string
  tenantId: string
  data: Record<string, unknown>
}

/**
 * `X-12id-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`, each v1 = HMAC-SHA256(secret, "<t>.<raw body>").
 * Any matching v1 is valid: for a day after you rotate the secret, events carry the new and the old one.
 */
export function verifySignature(secret: string, header: string, rawBody: string, nowSeconds = Date.now() / 1000): boolean {
  const parts = header.split(',').map((part) => part.split('=') as [string, string | undefined])
  const timestamp = parts.find(([key]) => key === 't')?.[1]
  if (!timestamp || Math.abs(nowSeconds - Number(timestamp)) > 300) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'))
  return parts.some(([key, value]) => key === 'v1' && value !== undefined && value.length === expected.length && timingSafeEqual(Buffer.from(value), expected))
}

/** `YYYYMMDD` (UTC), the form 12id compares dates in. */
export function dateNumber(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

export function credentialAttributes(tenant: Tenant, user: { name: string; memberId: string }, now = new Date()): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const [name, value] of Object.entries(tenant.credential.attributes)) {
    attributes[name] = value.replaceAll('{name}', user.name).replaceAll('{memberId}', user.memberId)
  }
  attributes.expiresOn = dateNumber(new Date(now.getTime() + tenant.credential.validDays * 86_400_000))
  return attributes
}

/** The user's photo on file, in the shape offers and proof requests take; nothing when there is none. */
export function faceReference(store: Store, user: User): { biometric?: { referenceImage: string } } {
  const referenceImage = store.photo(user.id)
  return referenceImage ? { biometric: { referenceImage } } : {}
}

/**
 * Offers the user's credential on their connection. The Idempotency-Key covers what is offered and
 * which attempt it is:
 *  - a repeated webhook sends the same offer under the same key, and the platform answers from the first;
 *  - an offer the platform refused can be sent again once its content is fixed (the platform keeps a
 *    4xx answer for a key too, so reusing the key would repeat the refusal for a day);
 *  - after an offer was declined or timed out, the next one is a new attempt.
 */
export async function offerCredential(deps: Pick<WebhookDeps, 'platform' | 'store' | 'tenant'>, user: User, connectionId: string): Promise<void> {
  const offer = { connectionId, credentialDefinitionId: deps.tenant.credentialDefinitionId, attributes: credentialAttributes(deps.tenant, user), externalId: user.id, ...faceReference(deps.store, user) }
  const key = `offer:${user.id}:${user.offerAttempt ?? 0}:${createHash('sha256').update(JSON.stringify(offer)).digest('hex').slice(0, 24)}`
  const { state } = await deps.platform.offerCredential(offer, key)
  deps.store.saveUser({ ...deps.store.user(user.id)!, credentialState: state })
}

export interface WebhookDeps {
  platform: Platform
  store: Store
  tenant: Tenant
  log: (message: string) => void
}

/**
 * Events can arrive twice and out of order, so every branch is safe to repeat.
 * `externalId` is the reference we passed on the command: the user id, or the action id.
 */
export async function handleEvent(deps: WebhookDeps, event: WebhookEvent): Promise<void> {
  const { platform, store, tenant, log } = deps
  const state = String(event.data.state ?? '')
  const externalId = typeof event.data.externalId === 'string' ? event.data.externalId : null

  switch (event.type) {
    // The app accepted our invitation: remember the connection and offer the credential on it.
    case 'connection.state_changed': {
      const user = externalId ? store.user(externalId) : undefined
      if (!user || state !== 'completed') return
      const connectionId = String(event.data.id)
      if (user.connectionId === connectionId && user.credentialState) return
      store.saveUser({ ...user, connectionId })
      await offerCredential(deps, user, connectionId)
      log(`user ${user.id}: connected, credential offered`)
      return
    }

    // offer-sent → request-received → credential-issued (the wallet has it) → done (it acknowledged).
    case 'credential.state_changed': {
      const user = externalId ? store.user(externalId) : undefined
      if (!user) return
      const ended = state === 'abandoned' && user.credentialState !== 'abandoned'
      store.saveUser({ ...user, credentialState: state, offerAttempt: (user.offerAttempt ?? 0) + (ended ? 1 : 0) })
      return
    }

    // The answer to an action. `verified` is the platform's check of the proof; trust nothing else.
    case 'proof.state_changed': {
      const action = externalId ? store.action(externalId) : undefined
      if (!action || action.state !== 'pending') return
      if (state === 'done') {
        const disclosed = (event.data.disclosed ?? null) as Record<string, Record<string, string>> | null
        store.saveAction({ ...action, state: event.data.verified === true ? 'approved' : 'failed', disclosed })
        log(`action ${action.id}: ${event.data.verified === true ? 'approved' : 'proof not valid'}`)
      } else if (state === 'abandoned') {
        store.saveAction({ ...action, state: 'declined' })
        log(`action ${action.id}: declined or not answered`)
      }
      return
    }

    // One attempt at a face check ended. The scores are the organisation's audit trail; the exchange
    // itself moves on by its own events (the credential is issued, or the proof result is released).
    case 'biometric.check_completed':
      log(`face check for ${String(event.data.recordType)} ${String(event.data.recordId)}: ${String(event.data.status)} (liveness ${String(event.data.livenessScore)}, match ${String(event.data.matchScore)}, ${String(event.data.attemptsRemaining)} attempts left)`)
      return

    // Messages are waiting for this wallet. Send a silent push to that installation here (FCM, APNs);
    // its handler calls the SDK's sync(). This stand-in has no push: the app starts every exchange itself.
    case 'wallet.sync_requested':
      log(`wallet ${String(event.data.walletId)}: sync requested (a real backend sends its push now)`)
      return
  }
}
