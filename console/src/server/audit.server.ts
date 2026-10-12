/**
 * Events the console reports to platform-api's audit log (implement/22-console-feedback.md C13).
 * Sign-ins, account changes and exports happen here, through Better Auth and the console database,
 * and never pass through platform-api, so without this they leave no audit row.
 *
 * Best effort, like platform-api's own audit hook: a failed write is logged and never undoes or blocks
 * the action it describes.
 *
 * Relative imports only: auth.server.ts imports this, and the Better Auth CLI loads that file outside Vite.
 */
import { serverEnv } from './env.server'
import type { paths } from './platform-api'

type EventBody = paths['/admin/audit/events']['post']['requestBody']['content']['application/json']
export type AuditEventType = EventBody['type']

export interface AuditActor {
  id: string
  email: string
  /** The platform role (`operator`, `user`) or the organization role the action was taken with. */
  role?: string | null
}

export interface AuditEvent {
  type: AuditEventType
  outcome?: 'success' | 'failure'
  /** Who acted. Absent when nobody is signed in (a failed sign-in, a reset request). */
  actor?: AuditActor
  /** Without an actor: the address the attempt was made for. */
  actorLabel?: string
  tenantId?: string | null
  /** A few facts. platform-api replaces secrets and personal data and keeps at most 2 KB. */
  detail?: Record<string, unknown>
}

const TIMEOUT_MS = 3_000
const ROLE = /^[a-z][a-z,_-]{0,39}$/

export const actorOf = (user: { id: string; email: string; role?: string | null }, role?: string): AuditActor => ({ id: user.id, email: user.email, role: role ?? user.role })

/** The actor of a server function, from the principal its middleware produced. */
export const principalActor = (principal: { actor: string; email: string; role: string }): AuditActor => ({ id: principal.actor, email: principal.email, role: principal.role })

/** Where a request came from, as far as the proxy's headers say. */
export function requestFacts(request: Request | undefined, ip: string | null): Record<string, unknown> {
  const userAgent = request?.headers.get('user-agent')?.slice(0, 200)
  return { ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) }
}

export async function recordEvent(event: AuditEvent): Promise<void> {
  try {
    const env = serverEnv()
    const role = event.actor?.role?.toLowerCase()
    const body: EventBody = {
      type: event.type,
      outcome: event.outcome ?? 'success',
      actor: event.actor?.id,
      actorLabel: (event.actor?.email ?? event.actorLabel)?.slice(0, 320),
      role: role && ROLE.test(role) ? role : undefined,
      tenantId: event.tenantId ?? undefined,
      detail: event.detail && Object.keys(event.detail).length > 0 ? event.detail : undefined,
    }
    const response = await fetch(new URL('/admin/audit/events', env.PLATFORM_API_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': env.CONSOLE_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) console.error(`[audit] ${event.type} was not recorded: platform-api answered ${response.status}`)
  } catch (error) {
    console.error(`[audit] ${event.type} was not recorded`, error)
  }
}
