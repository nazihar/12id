import { queryOptions } from '@tanstack/react-query'

import type { DeliveryStatus } from '@/features/tenant-data/types'

import { listMembers } from './members.functions'
import {
  getPortalCatalogue,
  getPortalWebhook,
  listPortalApiKeys,
  listPortalConnections,
  listPortalCredentials,
  listPortalDeliveries,
  listPortalProofs,
  listPortalTemplates,
  listPortalWallets,
} from './portal-data.functions'
import { listMyOrganizations } from './portal-session.functions'

// Keyed by organization slug: the server functions resolve the tenant from the active organization,
// so the cache must never serve one organization's data under another.
export const portalKey = (slug: string, ...rest: string[]) => ['portal', slug, ...rest]

export const myOrganizationsQuery = () => queryOptions({ queryKey: ['portal', 'my-organizations'], queryFn: () => listMyOrganizations() })
export const portalCatalogueQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'catalogue'), queryFn: () => getPortalCatalogue() })
export const portalTemplatesQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'templates'), queryFn: () => listPortalTemplates() })
export const portalConnectionsQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'connections'), queryFn: () => listPortalConnections() })
export const portalCredentialsQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'credentials'), queryFn: () => listPortalCredentials() })
export const portalProofsQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'proofs'), queryFn: () => listPortalProofs() })
export const portalWalletsQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'wallets'), queryFn: () => listPortalWallets() })
export const portalWebhookQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'webhook'), queryFn: () => getPortalWebhook() })
export const portalDeliveriesQuery = (slug: string, status?: DeliveryStatus) =>
  queryOptions({ queryKey: portalKey(slug, 'webhook-deliveries', status ?? 'all'), queryFn: () => listPortalDeliveries({ data: { status } }) })
export const portalApiKeysQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'api-keys'), queryFn: () => listPortalApiKeys() })
export const portalMembersQuery = (slug: string) => queryOptions({ queryKey: portalKey(slug, 'members'), queryFn: () => listMembers() })
