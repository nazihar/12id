/**
 * Console audit (Phase 4 C1). Every mutating request made through the console scope or with the
 * break-glass admin token is recorded with its actor; read routes that expose sensitive content opt
 * in with `config: { auditRead: true }`, and a read that revealed masked personal data to an operator is
 * recorded with its reason (Phase 7 H1). Customer API-key traffic is not audited here.
 *
 * Written after the response is sent, so a failed audit write is logged, never surfaced to the caller.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

import type { Database } from '../db/client.ts'
import { consoleAudit } from '../db/schema.ts'
import { isUuid } from './auth.ts'

declare module 'fastify' {
  interface FastifyContextConfig {
    auditRead?: boolean
  }
}

export function consoleAuditHook(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = request.tenant?.principal
    const who = principal?.kind === 'console' ? { actor: principal.actor, role: principal.role } : request.operator ? { actor: request.operator.actor, role: 'operator' } : null
    if (!who) return
    const mutating = request.method !== 'GET' && request.method !== 'HEAD'
    if (!mutating && request.routeOptions.config?.auditRead !== true && !request.auditReason) return

    const route = request.routeOptions.url ?? request.url.split('?')[0]
    const paramId = (request.params as { id?: unknown } | undefined)?.id
    const tenantId = request.tenant?.id ?? (route.startsWith('/admin/tenants/:id') && isUuid(paramId) ? paramId : null)
    try {
      await db.insert(consoleAudit).values({ actor: who.actor, role: who.role, tenantId, method: request.method, route, statusCode: reply.statusCode, requestId: String(request.id), reason: request.auditReason ?? null })
    } catch (error) {
      request.log.error({ err: error, actor: who.actor, route }, 'console audit write failed')
    }
  }
}
