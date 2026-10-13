/**
 * The hold (implement/22-console-feedback.md C17). One `preHandler` for every route that opts in
 * with `config: { approval: '<type>' }`:
 *
 *   - a console caller of a tenant that requires approval does not reach the handler: the validated
 *     call is stored as a change request and the answer is `202 { approval }`;
 *   - an API key never reaches these routes' handlers anyway (they are console-only, review K1), and
 *     a tenant that does not require approval is untouched.
 *
 * Applying an approved request makes the stored call again, inside this process, with
 * `app.inject`. So the route's own validation and checks run a second time against the state of
 * that moment, the normal audit row is written, and nothing about a route has to be written twice.
 * The call carries a marker only this process can produce; the gate lets it through after checking
 * that it names an approved request for exactly this route.
 */
import { randomBytes } from 'node:crypto'

import { tokenMatches } from '@12id/credo-base/internal-token.ts'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Database } from '../db/client.ts'
import { changeRequests } from '../db/schema.ts'
import { PlatformError } from '../http/errors.ts'
import { CONSOLE_ACTOR_HEADER, CONSOLE_ACTOR_LABEL_HEADER, CONSOLE_ROLE_HEADER, CONSOLE_TENANT_HEADER, CONSOLE_TOKEN_HEADER, type ConsoleRole } from '../http/auth.ts'
import { type Actor, type ChangeRequest, assertRole, createRequest, finish, toChangeRequestView } from './requests.ts'
import { APPROVAL_TYPES, type ApprovalTypeId, type HeldCall } from './types.ts'

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The route's change needs a second person where the tenant requires it (approvals/types.ts). */
    approval?: ApprovalTypeId
  }
  interface FastifyRequest {
    /** A held call of a `custom` type: the handler stores the request itself. */
    approvalHold?: { typeId: ApprovalTypeId; call: HeldCall; actor: Actor }
    /** This call applies an approved request. */
    approvedChange?: { id: string; approvedBy: string }
    /** This call was stored as a change request instead of being made. */
    heldChange?: string
  }
}

export const REPLAY_HEADER = 'x-approved-change'

export interface ApplyResult {
  ok: boolean
  statusCode: number
  /** The route's answer; for a new API key or signing secret it holds the secret, shown once. */
  body: unknown
  request: ChangeRequest
}

export type ApprovalGate = ReturnType<typeof createApprovalGate>

export function createApprovalGate(deps: { db: Database; consoleToken: string | undefined }) {
  // Known to this process only: nobody outside can claim to be applying an approved request.
  const replaySecret = randomBytes(32).toString('hex')

  async function preHandler(request: FastifyRequest, reply: FastifyReply) {
    const typeId = request.routeOptions.config?.approval
    if (!typeId) return
    const tenant = request.tenant
    if (!tenant || tenant.principal.kind !== 'console') return

    const marker = request.headers[REPLAY_HEADER]
    if (marker !== undefined) {
      const [id, secret] = typeof marker === 'string' ? marker.split(':') : []
      const refuse = () => reply.code(403).send({ error: 'forbidden', reason: 'not an approved change' })
      if (!id || !tokenMatches(secret, replaySecret)) return refuse()
      const [row] = await deps.db.select().from(changeRequests).where(and(eq(changeRequests.id, id), eq(changeRequests.tenantId, tenant.id), eq(changeRequests.status, 'approved')))
      if (!row || row.type !== typeId || row.method !== request.method || row.route !== request.url) return refuse()
      request.approvedChange = { id: row.id, approvedBy: row.decidedByLabel ?? row.decidedBy ?? 'unknown' }
      return
    }

    if (!tenant.approvalsRequired) return
    const type = APPROVAL_TYPES[typeId]
    const call: HeldCall = { params: (request.params ?? {}) as Record<string, string>, body: request.body }
    if ('holds' in type && type.holds && !type.holds(call)) return
    const actor: Actor = { id: tenant.principal.actor, label: tenant.principal.actorLabel, role: tenant.principal.role }
    if ('custom' in type && type.custom) {
      assertRole(typeId, actor.role, 'ask for')
      request.approvalHold = { typeId, call, actor }
      return
    }
    const before = 'before' in type && type.before ? await type.before(deps.db, tenant.id, call) : undefined
    const row = await createRequest(deps.db, { tenantId: tenant.id, typeId, call, actor, replay: { method: request.method, route: request.url }, before })
    request.heldChange = row.id
    return reply.code(202).send({ approval: toChangeRequestView(row) })
  }

  /** Makes the stored call of an approved platform request, as the person who asked, and closes the request. */
  async function apply(app: FastifyInstance, row: ChangeRequest): Promise<ApplyResult> {
    if (row.executor !== 'platform' || !row.method || !row.route || !row.tenantId) throw new Error(`change request ${row.id} is not a stored platform call`)
    if (!deps.consoleToken) throw new Error('the console scope is disabled; an approved change cannot be applied')
    const headers: Record<string, string> = {
      [CONSOLE_TOKEN_HEADER]: deps.consoleToken,
      [CONSOLE_ACTOR_HEADER]: row.requestedBy,
      [CONSOLE_ROLE_HEADER]: row.requestedByRole as ConsoleRole,
      [CONSOLE_TENANT_HEADER]: row.tenantId,
      [REPLAY_HEADER]: `${row.id}:${replaySecret}`,
    }
    if (row.requestedByLabel) headers[CONSOLE_ACTOR_LABEL_HEADER] = encodeURIComponent(row.requestedByLabel)
    // Two Apply clicks, or an approval and a retry, must not make the call twice: only one of them
    // takes the request. If this process dies before it finishes, the request stays approved and
    // untaken by nobody, and expires.
    const [taken] = await deps.db.update(changeRequests).set({ appliedAt: new Date() }).where(and(eq(changeRequests.id, row.id), eq(changeRequests.status, 'approved'), isNull(changeRequests.appliedAt))).returning({ id: changeRequests.id })
    if (!taken) throw new PlatformError(409, 'conflict', 'this request is already being applied')
    const response = await app.inject({ method: row.method as 'POST', url: row.route, headers, ...(row.body === null || row.body === undefined ? {} : { payload: row.body as Record<string, unknown> }) })
    let body: unknown = null
    try {
      body = response.json()
    } catch {
      body = null
    }
    const ok = response.statusCode < 400
    const reason = (body as { reason?: unknown } | null)?.reason
    const request = await finish(deps.db, row, ok ? { ok: true } : { ok: false, error: typeof reason === 'string' ? reason : `the change was refused (${response.statusCode})` })
    return { ok, statusCode: response.statusCode, body, request }
  }

  return { preHandler, apply }
}
