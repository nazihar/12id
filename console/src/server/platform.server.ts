/**
 * platform-api client for server functions. Typed from platform-api's openapi.console.json
 * (`npm run openapi:client`). Every request carries the console-scope headers of the principal the
 * middleware produced; a client cannot be built without one.
 */
import createClient from 'openapi-fetch'

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

export function platformFor(principal: Principal, options: { tenantId?: string } = {}) {
  const env = serverEnv()
  let tenantId: string | null
  if (principal.role === 'operator') {
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
  if (tenantId) headers['x-console-tenant'] = tenantId
  return createClient<paths>({ baseUrl: env.PLATFORM_API_URL, headers })
}
