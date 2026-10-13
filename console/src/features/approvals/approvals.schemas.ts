/**
 * Approval by a second person (implement/22-console-feedback.md C19): the Approvals pages' URL state
 * and the wording shared by the three of them. Client-safe.
 */
import { z } from 'zod'

import { listSearch } from '@/lib/list-search'

export const APPROVAL_TABS = ['waiting', 'history'] as const
export type ApprovalTab = (typeof APPROVAL_TABS)[number]

export const approvalSearch = listSearch.pick({ page: true, pageSize: true }).extend({ tab: z.enum(APPROVAL_TABS).optional() })
export type ApprovalSearch = z.infer<typeof approvalSearch>

export const decisionInput = z.object({ id: z.uuid(), action: z.enum(['approve', 'reject']), reason: z.string().trim().min(3).max(500).optional() })
export const requestInput = z.object({ id: z.uuid() })

export type RequestStatus = 'pending' | 'approved' | 'applied' | 'rejected' | 'cancelled' | 'expired' | 'failed'

/** What a status means for a reader, given how the change is applied. */
export function statusText(request: { status: RequestStatus; apply: 'on_approval' | 'by_requester'; requestedByLabel: string | null; mine: boolean }): string {
  switch (request.status) {
    case 'pending':
      return 'waiting for a second person'
    case 'approved':
      return request.mine ? 'approved: apply it now' : `approved: waiting for ${request.requestedByLabel ?? 'the person who asked'} to apply it`
    case 'applied':
      return 'approved and applied'
    case 'rejected':
      return 'rejected'
    case 'cancelled':
      return 'cancelled by the person who asked'
    case 'expired':
      return 'expired: nobody decided or applied it in time'
    case 'failed':
      return 'approved, but it could not be applied'
  }
}

/** What applying an approved request hands back: nothing, or a secret to show once. */
export interface AppliedResult {
  status: RequestStatus
  /** Why it could not be applied. */
  error: string | null
  secret: { kind: 'api_key' | 'webhook_secret'; value: string } | null
}
