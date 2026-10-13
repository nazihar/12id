import { keepPreviousData, queryOptions } from '@tanstack/react-query'

import { APPROVALS_KEY } from '@/lib/held'

import { getOpsApprovals, getPortalApprovals, listOpsChangeRequests, listOpsOpenChanges, listPortalChangeRequests, listPortalOpenChanges } from './approvals.functions'
import type { ApprovalSearch } from './approvals.schemas'

// Requests are made by other people, so a cached list is out of date in a way the viewer cannot know:
// the lists and the setting are read again on every visit (FRESH), whatever the app's default is.
const FRESH = { staleTime: 0 } as const

// Every key starts with APPROVALS_KEY: a form that had its change held invalidates that one key and
// the lists, the sidebar's count and the notices all refresh (lib/held.ts).

export const portalApprovalsKey = (slug: string) => [...APPROVALS_KEY, 'portal', slug] as const
export const portalApprovalsQuery = (slug: string) => queryOptions({ queryKey: [...portalApprovalsKey(slug), 'setting'], queryFn: () => getPortalApprovals(), ...FRESH })
export const portalChangeRequestsQuery = (slug: string, search: ApprovalSearch = {}) =>
  queryOptions({ queryKey: [...portalApprovalsKey(slug), 'list', search], queryFn: () => listPortalChangeRequests({ data: search }), placeholderData: keepPreviousData, ...FRESH })
/** What waits right now: the sidebar's count and the notices. A few seconds old is fine for both. */
export const portalOpenChangesQuery = (slug: string) => queryOptions({ queryKey: [...portalApprovalsKey(slug), 'open'], queryFn: () => listPortalOpenChanges(), staleTime: 10_000 })

/** `tenantId` absent: the operator area's own requests (operator accounts). */
export const opsApprovalsKey = (tenantId?: string) => [...APPROVALS_KEY, 'ops', tenantId ?? 'operators'] as const
export const opsApprovalsQuery = (tenantId?: string) => queryOptions({ queryKey: [...opsApprovalsKey(tenantId), 'setting'], queryFn: () => getOpsApprovals({ data: { tenantId } }), ...FRESH })
export const opsChangeRequestsQuery = (tenantId: string | undefined, search: ApprovalSearch = {}) =>
  queryOptions({ queryKey: [...opsApprovalsKey(tenantId), 'list', search], queryFn: () => listOpsChangeRequests({ data: { tenantId, ...search } }), placeholderData: keepPreviousData, ...FRESH })
export const opsOpenChangesQuery = (tenantId?: string) => queryOptions({ queryKey: [...opsApprovalsKey(tenantId), 'open'], queryFn: () => listOpsOpenChanges({ data: { tenantId } }), staleTime: 10_000 })

export type ApprovalsOverview = Awaited<ReturnType<typeof getPortalApprovals>>
export type ChangeRequestRow = Awaited<ReturnType<typeof listPortalChangeRequests>>['items'][number]
export type OpenChange = Awaited<ReturnType<typeof listPortalOpenChanges>>['items'][number]
