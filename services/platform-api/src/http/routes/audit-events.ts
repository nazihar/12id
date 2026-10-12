/**
 * What the console reports to the audit (implement/22-console-feedback.md C13). Sign-ins, account
 * changes (operators, members, invitations) and exports happen inside the console and never pass
 * through platform-api, so they used to leave no audit row. The console's server posts each one here;
 * the row joins `console_audit` with `method = 'EVENT'` and the event type as its route, so the one
 * audit log and its viewer cover them.
 *
 * Console token only. A failed sign-in has no user, and inviting a member is an owner's act, so
 * neither an actor nor the operator role can be required. The edge answers 404 for /admin/* and for
 * any request that carries the console token.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { consoleAudit } from '../../db/schema.ts'
import { auditDetail } from '../audit-changes.ts'
import { cleanActorLabel, isActorId, requireConsoleToken } from '../auth.ts'
import { PlatformError } from '../errors.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

/** `method` of a row that came through this route. */
export const AUDIT_EVENT_METHOD = 'EVENT'

export const AUDIT_EVENT_TYPES = [
  'auth.sign_in',
  'auth.sign_in_failed',
  'auth.second_factor_failed',
  'auth.sign_out',
  'auth.password_reset_requested',
  'auth.password_reset',
  'auth.two_factor_enrolled',
  'account.operator_invited',
  'account.operator_updated',
  'account.operator_role_changed',
  'account.operator_banned',
  'account.operator_unbanned',
  'account.operator_sessions_revoked',
  'account.operator_deleted',
  'account.organization_created',
  'account.member_invited',
  'account.invitation_cancelled',
  'account.invitation_accepted',
  'account.member_role_changed',
  'account.member_removed',
  'export.run',
] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

/** The audit viewer's kinds: a change made through platform-api, or one family of events. */
export const AUDIT_KINDS = { change: null, 'sign-in': 'auth.', account: 'account.', export: 'export.' } as const
export type AuditKind = keyof typeof AUDIT_KINDS

const ANONYMOUS = 'anonymous'
const eventBody = z.object({
  type: z.enum(AUDIT_EVENT_TYPES),
  outcome: z.enum(['success', 'failure']),
  actor: z.string().max(200).optional().describe('The console user id; absent when nobody is signed in.'),
  actorLabel: z.string().max(1000).optional().describe("The actor's email, or the address a failed sign-in was tried for."),
  role: z.string().regex(/^[a-z][a-z,_-]{0,39}$/).optional(),
  tenantId: z.uuid().optional(),
  detail: z.record(z.string(), z.unknown()).optional().describe('A few facts about the event. Secrets and personal data are replaced; over 2 KB only the size is kept.'),
})

export const auditEventRoutes = (deps: { db: Database; consoleToken?: string }): FastifyPluginAsyncZod => async (app) => {
  app.addHook('onRequest', requireConsoleToken(deps.consoleToken))

  app.post(
    '/admin/audit/events',
    {
      schema: {
        tags: ['admin', CONSOLE_ONLY_TAG],
        summary: 'Record a console event in the audit log',
        description: 'A sign-in, an account change or an export, reported by the console server. Stored as an audit row with method `EVENT` and the type as its route.',
        security: [{ consoleToken: [] }],
        body: eventBody,
        response: { 201: z.object({ recorded: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const { type, outcome, tenantId, detail } = request.body
      if (request.body.actor !== undefined && !isActorId(request.body.actor)) throw new PlatformError(400, 'bad_request', 'malformed actor')
      await deps.db.insert(consoleAudit).values({
        actor: request.body.actor ?? ANONYMOUS,
        actorLabel: cleanActorLabel(request.body.actorLabel) ?? null,
        role: request.body.role ?? 'none',
        tenantId: tenantId ?? null,
        method: AUDIT_EVENT_METHOD,
        route: type,
        // A refused sign-in is a 401 like any other; other failures have no better code.
        statusCode: outcome === 'success' ? 200 : type.startsWith('auth.') ? 401 : 400,
        requestId: String(request.id),
        changes: auditDetail(detail),
      })
      return reply.code(201).send({ recorded: true })
    }
  )
}
