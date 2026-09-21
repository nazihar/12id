import { queryOptions } from '@tanstack/react-query'

import {
  getCatalogue,
  getTenantBiometrics,
  getWebhookEndpoint,
  listConnections,
  listCredentials,
  listProofTemplates,
  listProofs,
  listWallets,
  listWebhookDeliveries,
} from './tenant-data.functions'

import type { DeliveryStatus } from './types'

export type { DeliveryStatus }

const key = (tenantId: string, ...rest: string[]) => ['ops', 'tenant', tenantId, ...rest]

export const catalogueQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'catalogue'), queryFn: () => getCatalogue({ data: { tenantId } }) })

export const proofTemplatesQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'proof-templates'), queryFn: () => listProofTemplates({ data: { tenantId } }) })

export const connectionsQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'connections'), queryFn: () => listConnections({ data: { tenantId } }) })

export const credentialsQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'credentials'), queryFn: () => listCredentials({ data: { tenantId } }) })

export const proofsQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'proofs'), queryFn: () => listProofs({ data: { tenantId } }) })

export const walletsQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'wallets'), queryFn: () => listWallets({ data: { tenantId } }) })

export const webhookEndpointQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'webhook'), queryFn: () => getWebhookEndpoint({ data: { tenantId } }) })

export const webhookDeliveriesQuery = (tenantId: string, status?: DeliveryStatus) =>
  queryOptions({ queryKey: key(tenantId, 'webhook-deliveries', status ?? 'all'), queryFn: () => listWebhookDeliveries({ data: { tenantId, status } }) })
export const tenantBiometricsQuery = (tenantId: string) => queryOptions({ queryKey: key(tenantId, 'biometrics'), queryFn: () => getTenantBiometrics({ data: { tenantId } }) })
