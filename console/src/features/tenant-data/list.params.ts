/** Maps a list's URL search to the platform-api query of that list (Phase 4 C9). Client-safe, pure. */
import { createdParams, pageParams } from '@/lib/list-search'

import type { ApiKeySearch, CatalogueSearch, DeliverySearch, ExchangeSearch, WalletSearch } from './list.schemas'

export const exchangeQueryParams = (search: ExchangeSearch) => ({ ...pageParams(search), ...createdParams(search), state: search.state })

export const walletQueryParams = (search: WalletSearch) => ({ ...pageParams(search), ...createdParams(search), status: search.status })

export const deliveryQueryParams = (search: DeliverySearch) => ({ ...pageParams(search), ...createdParams(search), status: search.status, eventType: search.eventType })

export const apiKeyQueryParams = (search: ApiKeySearch) => ({ ...pageParams(search), status: search.status })

export const catalogueQueryParams = (search: CatalogueSearch) => ({ ...pageParams(search), status: search.status })
