import { keepPreviousData, queryOptions } from '@tanstack/react-query'

import type { ApiKeySearch, CatalogueSearch, DeliverySearch, ExchangeSearch, TemplateSearch, WalletSearch } from '@/features/tenant-data/list.schemas'

import { listMembers } from './members.functions'
import type { MemberSearch } from './members.schemas'
import {
  getPortalBiometricAdoption,
  getPortalBiometrics,
  getPortalCatalogue,
  getPortalTemplate,
  getPortalWebhook,
  listPortalApiKeys,
  listPortalCatalogue,
  listPortalDeliveries,
  listPortalExchanges,
  listPortalTemplates,
  listPortalWallets,
} from './portal-data.functions'
import { listMyOrganizations } from './portal-session.functions'

// Keyed by organization slug: the server functions resolve the tenant from the active organization,
// so the cache must never serve one organization's data under another.
export const portalKey = (slug: string, ...rest: unknown[]) => ['portal', slug, ...rest]

// Lists are keyed by their URL search (Phase 4 C9); the previous page stays on screen while the next loads.
const list = { placeholderData: keepPreviousData }

export const myOrganizationsQuery = () => queryOptions({ queryKey: ['portal', 'my-organizations'], queryFn: () => listMyOrganizations() })
/** Every schema and credential definition, for the template builder and the Overview counts. */
export const portalCatalogueQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'catalogue', 'all'), queryFn: () => getPortalCatalogue() })
export const portalCataloguePageQuery = (slug: string, search: CatalogueSearch = {}) =>
  queryOptions({ queryKey: portalKey(slug, 'catalogue', 'page', search), queryFn: () => listPortalCatalogue({ data: search }), ...list })
export const portalTemplatesQuery = (slug: string, search: TemplateSearch = {}) =>
  queryOptions({ queryKey: portalKey(slug, 'templates', 'page', search), queryFn: () => listPortalTemplates({ data: search }), ...list })
export const portalTemplateQuery = (slug: string, templateId: string) =>
  queryOptions({ queryKey: portalKey(slug, 'templates', 'one', templateId), queryFn: () => getPortalTemplate({ data: { templateId } }) })
export const portalExchangesQuery = (slug: string, search: ExchangeSearch = {}) =>
  queryOptions({ queryKey: portalKey(slug, 'exchanges', search), queryFn: () => listPortalExchanges({ data: search }), ...list })
export const portalWalletsQuery = (slug: string, search: WalletSearch = {}) =>
  queryOptions({ queryKey: portalKey(slug, 'wallets', search), queryFn: () => listPortalWallets({ data: search }), ...list })
export const portalWebhookQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'webhook'), queryFn: () => getPortalWebhook() })
export const portalDeliveriesQuery = (slug: string, search: DeliverySearch = {}) =>
  queryOptions({ queryKey: portalKey(slug, 'webhook-deliveries', search), queryFn: () => listPortalDeliveries({ data: search }), ...list })
export const portalApiKeysQuery = (slug: string, search: ApiKeySearch = {}) =>
  queryOptions({ queryKey: portalKey(slug, 'api-keys', search), queryFn: () => listPortalApiKeys({ data: search }), ...list })
export const portalMembersQuery = (slug: string, search: MemberSearch = {}) =>
  queryOptions({ queryKey: portalKey(slug, 'members', search), queryFn: () => listMembers({ data: search }), ...list })
export const portalBiometricsQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'biometrics'), queryFn: () => getPortalBiometrics() })
export const portalBiometricAdoptionQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'biometrics', 'adoption'), queryFn: () => getPortalBiometricAdoption() })
