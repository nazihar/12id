/**
 * Search schemas of the tenant data lists (Phase 4 C9), client-safe: each is a route's
 * `validateSearch` (through `parseListSearch`) and the matching server function's validator, so the
 * URL, the cache key and the platform-api query agree.
 */
import { z } from 'zod'

import { datedListSearch, listSearch } from '@/lib/list-search'

import { DELIVERY_STATUSES, WEBHOOK_EVENT_TYPES } from './types'

/** Issuer and verifier states of Credo's v1 protocols (DidExchangeState, CredentialState, ProofState). */
export const CONNECTION_STATES = ['invitation-sent', 'request-received', 'response-sent', 'completed', 'abandoned'] as const
export const CREDENTIAL_STATES = ['offer-sent', 'request-received', 'credential-issued', 'done', 'declined', 'abandoned'] as const
export const PROOF_STATES = ['request-sent', 'presentation-received', 'done', 'declined', 'abandoned'] as const

export const EXCHANGE_TABS = ['connections', 'credentials', 'proofs'] as const
export type ExchangeTab = (typeof EXCHANGE_TABS)[number]
export const EXCHANGE_STATES: Record<ExchangeTab, readonly string[]> = { connections: CONNECTION_STATES, credentials: CREDENTIAL_STATES, proofs: PROOF_STATES }

/** One page of one exchange kind; the tab says which. `q` is the external id (connections: also the holder label). */
export const exchangeSearch = datedListSearch.extend({
  tab: z.enum(EXCHANGE_TABS).optional(),
  state: z.array(z.string().min(1).max(50)).min(1).max(20).optional(),
})
export type ExchangeSearch = z.infer<typeof exchangeSearch>

export const ACTIVE_REVOKED = ['active', 'revoked'] as const
export const walletSearch = datedListSearch.extend({ status: z.enum(ACTIVE_REVOKED).optional() })
export type WalletSearch = z.infer<typeof walletSearch>

export const deliverySearch = datedListSearch.omit({ q: true }).extend({ status: z.enum(DELIVERY_STATUSES).optional(), eventType: z.enum(WEBHOOK_EVENT_TYPES).optional() })
export type DeliverySearch = z.infer<typeof deliverySearch>

export const apiKeySearch = listSearch.extend({ status: z.enum(ACTIVE_REVOKED).optional() })
export type ApiKeySearch = z.infer<typeof apiKeySearch>

export const templateSearch = listSearch
export type TemplateSearch = z.infer<typeof templateSearch>

export const CATALOGUE_TABS = ['schemas', 'definitions'] as const
export const CATALOGUE_STATUSES = ['pending', 'awaiting_endorsement', 'endorsed', 'published', 'deprecated', 'failed'] as const
export const catalogueSearch = listSearch.extend({ tab: z.enum(CATALOGUE_TABS).optional(), status: z.enum(CATALOGUE_STATUSES).optional() })
export type CatalogueSearch = z.infer<typeof catalogueSearch>

export const stateOptions = (states: readonly string[]) => states.map((value) => ({ value, label: value }))
export const deliveryStatusOptions = DELIVERY_STATUSES.map((value) => ({ value, label: value }))
export const eventTypeOptions = WEBHOOK_EVENT_TYPES.map((value) => ({ value, label: value }))
export const activeRevokedOptions = ACTIVE_REVOKED.map((value) => ({ value, label: value }))
export const catalogueStatusOptions = CATALOGUE_STATUSES.map((value) => ({ value, label: value.replace('_', ' ') }))
