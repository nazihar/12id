/**
 * platform-api client for server functions. Typed from platform-api's openapi.console.json
 * (`npm run openapi:client`). Every request carries the console-scope headers of the principal the
 * middleware produced; a client cannot be built without one.
 */
import createClient from 'openapi-fetch'

import type { Held } from '@/lib/held'
import { STAFF_ROLES, type StaffRole, staffCan } from '@/lib/permissions'

import { serverEnv } from './env.server'
import type { Principal } from './middleware'
import type { paths } from './platform-api'

/** A platform-api refusal, carrying its customer-safe `{ error, reason }` (platform-api never puts internals there). */
export class PlatformCallError extends Error {
  public readonly status: number
  public readonly code: string

  public constructor(status: number, code: string, reason: string) {
    super(reason)
    this.name = 'PlatformCallError'
    this.status = status
    this.code = code
  }
}

/** Returns the body of a successful call, or throws PlatformCallError. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.ok && result.data !== undefined) return result.data
  const body = result.error as { error?: string; reason?: string } | undefined
  throw new PlatformCallError(result.response.status, body?.error ?? 'platform_error', body?.reason ?? `platform-api answered ${result.response.status}`)
}

/** What platform-api answers with `202` from a held route (implement/22 C17). */
interface HeldBody {
  approval: { id: string; type: string; label: string; summary: string; apply: 'on_approval' | 'by_requester' }
}

/**
 * The body of a successful call, or `{ held }` when platform-api did not make the change because the
 * tenant requires a second person for it. A route that can answer `202` has that in its type, so a
 * caller that forgets this does not compile.
 */
export function unwrapHeld<T>(result: { data?: T; error?: unknown; response: Response }): Exclude<T, HeldBody> | Held {
  const body = unwrap(result)
  if (result.response.status !== 202) return body as Exclude<T, HeldBody>
  const { id, type, label, summary, apply } = (body as HeldBody).approval
  return { held: { id, type, label, summary, apply } }
}

/**
 * `revealReason` (operators only, Phase 7 H1): platform-api masks personal data for operators unless
 * a reason is sent; the reason is recorded in its audit log. An auditor sees the masks and cannot reveal.
 */
export function platformFor(principal: Principal, options: { tenantId?: string; revealReason?: string } = {}) {
  const env = serverEnv()
  let tenantId: string | null
  const staffRole = (STAFF_ROLES as readonly string[]).includes(principal.role) ? (principal.role as StaffRole) : null
  if (staffRole) {
    tenantId = options.tenantId ?? null
  } else {
    // Tenant members act for the tenant their membership resolved to, never one named by input.
    if (options.tenantId && options.tenantId !== principal.tenantId) throw new Error('tenant does not match the active organization')
    tenantId = principal.tenantId
  }
  const headers: Record<string, string> = {
    'x-console-token': env.CONSOLE_TOKEN,
    'x-console-actor': principal.actor,
    'x-console-role': principal.role,
  }
  // URI-encoded: a header cannot carry every character an address may hold.
  if (principal.email) headers['x-console-actor-label'] = encodeURIComponent(principal.email)
  if (tenantId) headers['x-console-tenant'] = tenantId
  if (options.revealReason && staffCan(staffRole, 'reveal')) headers['x-console-reveal-reason'] = encodeURIComponent(options.revealReason)
  return createClient<paths>({ baseUrl: env.PLATFORM_API_URL, headers })
}
