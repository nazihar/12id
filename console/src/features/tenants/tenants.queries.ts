import { keepPreviousData, queryOptions } from '@tanstack/react-query'

import type { ApiKeySearch } from '@/features/tenant-data/list.schemas'

import { getTenantOrganization } from './tenant-owner.functions'
import { getTenant, getTenantOverview, listApiKeys } from './tenants.functions'
import type { TenantListSearch } from './tenants.schemas'
import type { MemberSearch } from '@/features/portal/members.schemas'

export const tenantOverviewQuery = (search: TenantListSearch = {}) =>
  queryOptions({
    queryKey: ['ops', 'tenant-overview', search],
    queryFn: () => getTenantOverview({ data: search }),
    placeholderData: keepPreviousData,
  })

export const tenantQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ['ops', 'tenant', tenantId],
    queryFn: () => getTenant({ data: { tenantId } }),
  })

export const tenantApiKeysQuery = (tenantId: string, search: ApiKeySearch = {}) =>
  queryOptions({
    queryKey: ['ops', 'tenant', tenantId, 'api-keys', search],
    queryFn: () => listApiKeys({ data: { tenantId, ...search } }),
    placeholderData: keepPreviousData,
  })

export const tenantOrganizationQuery = (tenantId: string, search: Omit<MemberSearch, 'tab'> = {}) =>
  queryOptions({
    queryKey: ['ops', 'tenant', tenantId, 'organization', search],
    queryFn: () => getTenantOrganization({ data: { tenantId, ...search } }),
    placeholderData: keepPreviousData,
  })
