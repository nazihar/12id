/**
 * Approval by a second person (implement/22-console-feedback.md C17–C19), the console's server side.
 *
 * platform-api keeps every request and the rules for deciding one. Two scopes with the same routes:
 * one tenant's requests (`/v1`, for its members and for operators acting for it) and the operator
 * area's (`/admin`, changes to operator accounts, which belong to no tenant).
 *
 * A change platform-api makes itself is held there. A change the console makes through Better Auth
 * (members, operators) never reaches platform-api, so the console asks here before it acts
 * (`askForAccountChange`) and performs the action when the approved request is applied
 * (`account-changes.server.ts`).
 */
import type { Held } from '@/lib/held'

import type { Principal } from './middleware'
import { platformFor, unwrap } from './platform.server'

/** A change request as platform-api answers it. */
export interface ApiChangeRequest {
  id: string
  tenantId: string | null
  type: string
  label: string
  executor: 'platform' | 'console'
  apply: 'on_approval' | 'by_requester'
  roles: string[]
  summary: string
  change?: unknown
  before?: unknown
  status: 'pending' | 'approved' | 'applied' | 'rejected' | 'cancelled' | 'expired' | 'failed'
  requestedBy: string
  requestedByLabel: string | null
  requestedByRole: string
  requestedAt: string
  decidedBy: string | null
  decidedByLabel: string | null
  decidedByRole: string | null
  decidedAt: string | null
  decisionReason: string | null
  appliedAt: string | null
  applyError: string | null
  expiresAt: string
}

/** The same, for the browser: the two free-form values as text, and whether the viewer is the one who asked. */
export interface ChangeRequestRow extends Omit<ApiChangeRequest, 'change' | 'before'> {
  change: string | null
  before: string | null
  mine: boolean
  /** The viewer's role may decide this kind of change (platform-api still refuses the person who asked). */
  decidable: boolean
}

const asText = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value, null, 2))

export const toRow = (request: ApiChangeRequest, principal: Principal): ChangeRequestRow => ({
  ...request,
  change: asText(request.change),
  before: asText(request.before),
  mine: request.requestedBy === principal.actor,
  decidable: request.roles.includes(principal.role),
})

export const WAITING = ['pending', 'approved'] as const
export const CLOSED = ['applied', 'rejected', 'cancelled', 'expired', 'failed'] as const

/**
 * The approvals routes of one scope. `tenantId` null: the operator area. A tenant member always acts
 * for their own tenant (`platformFor` refuses any other).
 */
export function approvalsFor(principal: Principal, tenantId: string | null) {
  const staff = principal.role === 'operator' || principal.role === 'auditor'
  const scope = tenantId === null && staff ? 'admin' : 'v1'
  const platform = platformFor(principal, tenantId === null ? {} : { tenantId })
  const at = (id: string) => ({ params: { path: { id } } })

  return {
    scope,
    async setting() {
      return unwrap(scope === 'admin' ? await platform.GET('/admin/approvals') : await platform.GET('/v1/approvals'))
    },
    async list(query: { status: readonly string[]; page: number; pageSize: 25 | 50 | 100 }) {
      const params = { params: { query: { status: [...query.status], page: query.page, pageSize: query.pageSize } } }
      const page = unwrap(scope === 'admin' ? await platform.GET('/admin/change-requests', params) : await platform.GET('/v1/change-requests', params))
      return { ...page, items: (page.items as ApiChangeRequest[]).map((item) => toRow(item, principal)) }
    },
    async ask(type: string, payload: Record<string, unknown>): Promise<Held> {
      const body = { type, payload } as never
      const created = unwrap(scope === 'admin' ? await platform.POST('/admin/change-requests', { body }) : await platform.POST('/v1/change-requests', { body })) as ApiChangeRequest
      return { held: { id: created.id, type: created.type, label: created.label, summary: created.summary, apply: created.apply } }
    },
    async approve(id: string) {
      return toRow(unwrap(scope === 'admin' ? await platform.POST('/admin/change-requests/{id}/approve', at(id)) : await platform.POST('/v1/change-requests/{id}/approve', at(id))) as ApiChangeRequest, principal)
    },
    async reject(id: string, reason: string) {
      const options = { ...at(id), body: { reason } }
      return toRow(unwrap(scope === 'admin' ? await platform.POST('/admin/change-requests/{id}/reject', options) : await platform.POST('/v1/change-requests/{id}/reject', options)) as ApiChangeRequest, principal)
    },
    async cancel(id: string) {
      return toRow(unwrap(scope === 'admin' ? await platform.POST('/admin/change-requests/{id}/cancel', at(id)) : await platform.POST('/v1/change-requests/{id}/cancel', at(id))) as ApiChangeRequest, principal)
    },
    /** Takes an approved request to apply it: a platform change is made now; a console change comes back as its payload. */
    async apply(id: string) {
      const taken = unwrap(scope === 'admin' ? await platform.POST('/admin/change-requests/{id}/apply', at(id)) : await platform.POST('/v1/change-requests/{id}/apply', at(id)))
      return taken as { request: ApiChangeRequest; result: { statusCode: number; body?: unknown } | null; payload: Record<string, unknown> | null }
    },
    async applied(id: string, outcome: { ok: true } | { ok: false; error: string }) {
      const options = { ...at(id), body: outcome }
      return toRow(unwrap(scope === 'admin' ? await platform.POST('/admin/change-requests/{id}/applied', options) : await platform.POST('/v1/change-requests/{id}/applied', options)) as ApiChangeRequest, principal)
    },
  }
}

/**
 * Before an account action (members, operators): where a second person is required, the action is
 * stored as a request and `{ held }` comes back; otherwise null, and the caller acts now.
 */
export async function askForAccountChange(principal: Principal, tenantId: string | null, type: string, payload: Record<string, unknown>): Promise<Held | null> {
  const approvals = approvalsFor(principal, tenantId)
  const { required } = await approvals.setting()
  return required ? approvals.ask(type, payload) : null
}
