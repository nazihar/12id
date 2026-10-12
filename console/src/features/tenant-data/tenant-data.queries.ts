import { keepPreviousData, queryOptions } from '@tanstack/react-query'

import type { CatalogueSearch, DeliverySearch, ExchangeSearch, TemplateSearch, WalletSearch } from './list.schemas'
import {
  getTenantBiometrics,
  getWebhookEndpoint,
  listCatalogue,
  listExchanges,
  listProofTemplates,
  listWallets,
  listWebhookDeliveries, getTenantRetention, getTenantAuditRetention, listTenantErasures } from './tenant-data.functions'

import type { DeliveryStatus } from './types'

export type { DeliveryStatus }

const key = (tenantId: string, ...rest: unknown[]) => ['ops', 'tenant', tenantId, ...rest]

// Lists are keyed by their URL search; the previous page stays on screen while the next one loads.
export const catalogueQuery = (tenantId: string, search: CatalogueSearch = {}) =>
  queryOptions({ queryKey: key(tenantId, 'catalogue', search), queryFn: () => listCatalogue({ data: { tenantId, ...search } }), placeholderData: keepPreviousData })

export const proofTemplatesQuery = (tenantId: string, search: TemplateSearch = {}) =>
  queryOptions({ queryKey: key(tenantId, 'proof-templates', search), queryFn: () => listProofTemplates({ data: { tenantId, ...search } }), placeholderData: keepPreviousData })

export const exchangesQuery = (tenantId: string, search: ExchangeSearch = {}) =>
  queryOptions({ queryKey: key(tenantId, 'exchanges', search), queryFn: () => listExchanges({ data: { tenantId, ...search } }), placeholderData: keepPreviousData })

export const walletsQuery = (tenantId: string, search: WalletSearch = {}) =>
  queryOptions({ queryKey: key(tenantId, 'wallets', search), queryFn: () => listWallets({ data: { tenantId, ...search } }), placeholderData: keepPreviousData })

export const webhookEndpointQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'webhook'), queryFn: () => getWebhookEndpoint({ data: { tenantId } }) })

export const webhookDeliveriesQuery = (tenantId: string, search: DeliverySearch = {}) =>
  queryOptions({ queryKey: key(tenantId, 'webhook-deliveries', search), queryFn: () => listWebhookDeliveries({ data: { tenantId, ...search } }), placeholderData: keepPreviousData })

export const tenantBiometricsQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'biometrics'), queryFn: () => getTenantBiometrics({ data: { tenantId } }) })

// Phase 7 H1: the retention period and the erasure log.
export const tenantRetentionQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'data-protection', 'retention'), queryFn: () => getTenantRetention({ data: { tenantId } }) })
export const tenantAuditRetentionQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'data-protection', 'audit-retention'), queryFn: () => getTenantAuditRetention({ data: { tenantId } }) })
export const tenantErasuresQuery = (tenantId: string, page = 1) =>
  queryOptions({ queryKey: key(tenantId, 'data-protection', 'erasures', page), queryFn: () => listTenantErasures({ data: { tenantId, page } }), placeholderData: keepPreviousData })
