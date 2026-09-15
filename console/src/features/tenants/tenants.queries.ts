import { queryOptions } from '@tanstack/react-query'

import { getTenantOrganization } from './tenant-owner.functions'
import { getTenant, getTenantOverview, listApiKeys } from './tenants.functions'

export const tenantOverviewQuery = () =>
  queryOptions({
    queryKey: ['ops', 'tenant-overview'],
    queryFn: () => getTenantOverview(),
  })

export const tenantQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ['ops', 'tenant', tenantId],
    queryFn: () => getTenant({ data: { tenantId } }),
  })

export const tenantApiKeysQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ['ops', 'tenant', tenantId, 'api-keys'],
    queryFn: () => listApiKeys({ data: { tenantId } }),
  })

export const tenantOrganizationQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ['ops', 'tenant', tenantId, 'organization'],
    queryFn: () => getTenantOrganization({ data: { tenantId } }),
  })
