/**
 * Client-safe search schemas of the Verification page and the customer page
 * (implement/22-console-feedback.md C10, C11). As with every list (Phase 4 C9), one schema is the
 * route's `validateSearch`, the server function's validator and the platform-api query, so the URL,
 * the cache key and the request agree.
 */
import { z } from 'zod'

import { DASHBOARD_RANGES } from '@/features/dashboard/dashboard.schemas'
import { CREDENTIAL_STATES, PROOF_STATES } from '@/features/tenant-data/list.schemas'
import { createdParams, datedListSearch, pageParams } from '@/lib/list-search'

export const CHECK_STATUSES = ['pending', 'passed', 'failed', 'expired', 'cancelled'] as const
export type CheckStatus = (typeof CHECK_STATUSES)[number]
export const CHECK_KINDS = ['credential', 'proof'] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

/** Why biometric-service turns an attempt down (services/biometric-service). An unknown reason is shown as stored. */
const REASON_LABELS: Record<string, string> = {
  liveness_below_threshold: 'Liveness below the minimum',
  match_below_threshold: 'Face did not match the reference',
  no_face: 'No face found',
  vendor_failed: 'The provider could not decide',
  vendor_expired: 'The provider session ran out',
  unknown: 'No reason recorded',
}
export const CHECK_REASONS = ['liveness_below_threshold', 'match_below_threshold', 'no_face', 'vendor_failed', 'vendor_expired'] as const
export const reasonLabel = (reason: string) => REASON_LABELS[reason] ?? reason
export const KIND_LABELS: Record<CheckKind, string> = { credential: 'Issuance', proof: 'Proof' }

export const checkStatusOptions = CHECK_STATUSES.map((value) => ({ value, label: value }))
export const checkKindOptions = CHECK_KINDS.map((value) => ({ value, label: KIND_LABELS[value] }))
export const checkReasonOptions = CHECK_REASONS.map((value) => ({ value, label: reasonLabel(value) }))

/** One page of face checks. `q` is the external id of the exchange a check guards. */
export const checkSearch = datedListSearch.extend({
  status: z.array(z.enum(CHECK_STATUSES)).min(1).max(CHECK_STATUSES.length).optional(),
  recordType: z.enum(CHECK_KINDS).optional(),
  reason: z.string().min(1).max(100).optional(),
})
export type CheckSearch = z.infer<typeof checkSearch>

export const checkQueryParams = (search: CheckSearch, connectionId?: string) => ({ ...pageParams(search), ...createdParams(search), status: search.status, recordType: search.recordType, reason: search.reason, connectionId })

export const VERIFICATION_TABS = ['proofs', 'checks'] as const
export type VerificationTab = (typeof VERIFICATION_TABS)[number]

/** The Verification page: the window and the tab, plus the face-checks list under the second tab. */
export const verificationSearch = checkSearch.extend({ tab: z.enum(VERIFICATION_TABS).optional(), days: z.literal(DASHBOARD_RANGES).optional() })
export type VerificationSearch = z.infer<typeof verificationSearch>

export const CUSTOMER_TABS = ['credentials', 'proofs', 'checks'] as const
export type CustomerTab = (typeof CUSTOMER_TABS)[number]
export const CUSTOMER_STATES: Record<CustomerTab, readonly string[]> = { credentials: CREDENTIAL_STATES, proofs: PROOF_STATES, checks: CHECK_STATUSES }

/** The customer page: one connection's credential exchanges, proof exchanges or face checks (`tab`), paged and filtered by state. */
export const customerSearch = datedListSearch.omit({ q: true }).extend({
  tab: z.enum(CUSTOMER_TABS).optional(),
  state: z.array(z.string().min(1).max(50)).min(1).max(20).optional(),
})
export type CustomerSearch = z.infer<typeof customerSearch>

export const connectionInput = z.object({ connectionId: z.string().min(1).max(100) })
