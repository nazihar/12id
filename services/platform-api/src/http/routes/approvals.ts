/**
 * Approval by a second person (implement/22-console-feedback.md C17): the switch, and the requests
 * that wait. Console only, in two scopes with the same routes:
 *
 *   /v1/…     one tenant's requests (its members, and operators acting for it)
 *   /admin/…  requests that belong to no tenant: changes to operator accounts
 *
 * How a request comes to exist: a held route answers `202 { approval }` (`approvals/gate.ts`), or the
 * console posts one for an action it performs itself (members, operators), which platform-api cannot
 * hold because it never sees it.
 */
import { type SQL, and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { ApprovalGate } from '../../approvals/gate.ts'
import { type Actor, type ChangeRequest, assertApplicable, cancel, changeRequestScope, changeRequestView, createRequest, decide, findRequest, finish, held, toChangeRequestView } from '../../approvals/requests.ts'
import { APPROVAL_TYPES, type ApprovalTypeId, OPERATOR_CONSOLE_TYPE_IDS, TENANT_CONSOLE_TYPE_IDS } from '../../approvals/types.ts'
import type { Database } from '../../db/client.ts'
import { CHANGE_REQUEST_STATUSES, changeRequests, tenants } from '../../db/schema.ts'
import { type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { PlatformError } from '../errors.ts'
import { listPage, many, newestFirst, oneOrMany, pageOf, pageQuery } from '../list.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

const errorBody = z.object({ error: z.string(), reason: z.string() })

const typeView = z.object({ id: z.string(), label: z.string(), apply: z.enum(['on_approval', 'by_requester']), executor: z.enum(['platform', 'console']) })
const settingView = z.object({
  required: z.boolean(),
  /** Every kind of change that waits for a second person when this is on. */
  types: z.array(typeView),
})
const types = (keep: (id: ApprovalTypeId) => boolean) =>
  (Object.keys(APPROVAL_TYPES) as ApprovalTypeId[]).filter(keep).map((id) => ({ id, label: APPROVAL_TYPES[id].label, apply: APPROVAL_TYPES[id].apply, executor: APPROVAL_TYPES[id].executor }))
const isOperatorType = (id: ApprovalTypeId) => (OPERATOR_CONSOLE_TYPE_IDS as readonly string[]).includes(id)

const listQuery = pageQuery.extend({ status: oneOrMany(z.string().max(20)).describe('One or more of: pending, approved, applied, rejected, cancelled, expired, failed.') })
const idParams = z.object({ id: z.uuid() })
const applyView = z.object({
  request: changeRequestView,
  /** A platform change: the route's own answer. A new API key or signing secret is in it, once. */
  result: z.object({ statusCode: z.number().int(), body: z.unknown() }).nullable(),
  /** A console change: what the console performs now; it reports the outcome to `…/applied`. */
  payload: z.record(z.string(), z.unknown()).nullable(),
})

interface Scope {
  /** `/v1` or `/admin`. */
  base: string
  tags: string[]
  /** The tenant the caller acts for (null: the operator area) and who the caller is. */
  resolve: (request: FastifyRequest) => { tenantId: string | null; actor: Actor }
  /** Whether new requests are taken at all in this scope right now. */
  required: (request: FastifyRequest) => boolean
  consoleTypes: readonly [ApprovalTypeId, ...ApprovalTypeId[]]
}

export interface ApprovalRouteDeps {
  db: Database
  gate: ApprovalGate
  /** A request was rejected, cancelled or expired: release what it held outside this database. */
  onDiscard?: (row: ChangeRequest) => Promise<void>
}

function requestRoutes(zapp: Parameters<FastifyPluginAsyncZod>[0], deps: ApprovalRouteDeps, scope: Scope) {
  // The gate replays a stored call through the app itself.
  const app = zapp as unknown as FastifyInstance
  const path = `${scope.base}/change-requests`
  const discard = async (row: ChangeRequest) => {
    await deps.onDiscard?.(row).catch((error: unknown) => app.log.error({ err: error, changeRequest: row.id }, 'releasing a discarded change request failed'))
    return row
  }
  const load = async (request: FastifyRequest, id: string) => {
    const { tenantId, actor } = scope.resolve(request)
    const row = await findRequest(deps.db, tenantId, id)
    if (row.status === 'expired') await discard(row)
    return { row, actor }
  }

  zapp.get(
    path,
    { schema: { tags: scope.tags, summary: 'List change requests', description: 'Newest first, paged. `status` keeps one or more states; the open ones are `pending` and `approved`.', querystring: listQuery, response: { 200: pageOf(changeRequestView), 403: errorBody } } },
    async (request) => {
      const { tenantId } = scope.resolve(request)
      const filters: SQL[] = [changeRequestScope(tenantId)]
      const asked = many(request.query.status)
      const statuses = CHANGE_REQUEST_STATUSES.filter((status) => asked.includes(status))
      if (asked.length > 0 && statuses.length !== asked.length) throw new PlatformError(400, 'bad_request', `status must be one of ${CHANGE_REQUEST_STATUSES.join(', ')}`)
      if (statuses.length > 0) filters.push(inArray(changeRequests.status, statuses))
      const page = await listPage(deps.db, { table: changeRequests, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(changeRequests).where(where).orderBy(...newestFirst(changeRequests.requestedAt, changeRequests.id)).limit(limit).offset(offset)
      )
      return { ...page, items: page.items.map(toChangeRequestView) }
    }
  )

  zapp.get(`${path}/:id`, { schema: { tags: scope.tags, summary: 'Get a change request', params: idParams, response: { 200: changeRequestView, 403: errorBody, 404: errorBody } } }, async (request) => toChangeRequestView((await load(request, request.params.id)).row))

  zapp.post(
    path,
    {
      schema: {
        tags: scope.tags,
        summary: 'Ask for a change the console performs itself',
        description: 'Account actions (members, operators) run through the console, so the console stores the request here and performs the action once it is approved. `payload` is what it needs for that; it must hold no secret.',
        body: z.object({ type: z.enum(scope.consoleTypes), payload: z.record(z.string(), z.unknown()) }),
        response: { 201: changeRequestView, 403: errorBody, 409: errorBody },
      },
    },
    async (request, reply) => {
      const { tenantId, actor } = scope.resolve(request)
      if (!scope.required(request)) throw new PlatformError(409, 'approvals_off', 'changes do not need a second person here; make the change directly')
      if (Buffer.byteLength(JSON.stringify(request.body.payload), 'utf8') > 4096) throw new PlatformError(400, 'bad_request', 'the request is too large')
      const row = await createRequest(deps.db, { tenantId, typeId: request.body.type, call: { params: {}, body: request.body.payload }, actor, payload: request.body.payload })
      return reply.code(201).send(toChangeRequestView(row))
    }
  )

  zapp.post(
    `${path}/:id/approve`,
    {
      schema: {
        tags: scope.tags,
        summary: 'Approve a change request',
        description: 'Not by the person who asked, and only by a role that could have made the change. Most changes take effect at once: the stored call is made again, and if it no longer fits the request ends as `failed` with the reason. A change that hands out a secret, or that the console performs, stays `approved` until the person who asked applies it.',
        params: idParams,
        response: { 200: changeRequestView, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request) => {
      const { row, actor } = await load(request, request.params.id)
      const approved = await decide(deps.db, row, actor, 'approved')
      if (approved.executor !== 'platform' || approved.apply !== 'on_approval') return toChangeRequestView(approved)
      return toChangeRequestView((await deps.gate.apply(app, approved)).request)
    }
  )

  zapp.post(
    `${path}/:id/reject`,
    { schema: { tags: scope.tags, summary: 'Reject a change request', params: idParams, body: z.object({ reason: z.string().trim().min(3).max(500) }), response: { 200: changeRequestView, 403: errorBody, 404: errorBody, 409: errorBody } } },
    async (request) => {
      const { row, actor } = await load(request, request.params.id)
      return toChangeRequestView(await discard(await decide(deps.db, row, actor, 'rejected', request.body.reason)))
    }
  )

  zapp.post(`${path}/:id/cancel`, { schema: { tags: scope.tags, summary: 'Cancel your own change request', params: idParams, response: { 200: changeRequestView, 403: errorBody, 404: errorBody, 409: errorBody } } }, async (request) => {
    const { row, actor } = await load(request, request.params.id)
    return toChangeRequestView(await discard(await cancel(deps.db, row, actor)))
  })

  zapp.post(
    `${path}/:id/apply`,
    {
      // The answer may hold a secret that is shown once: never stored for a replay, never in the audit.
      config: { idempotency: false },
      schema: {
        tags: scope.tags,
        summary: 'Apply an approved change request',
        description: 'Only the person who asked. A platform change is made now and its answer returned (a new API key or signing secret is shown here, once). For a console change the stored `payload` is returned; the console performs it and reports to `…/applied`.',
        params: idParams,
        response: { 200: applyView, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request) => {
      const { row, actor } = await load(request, request.params.id)
      assertApplicable(row, actor)
      if (row.executor === 'platform') {
        const result = await deps.gate.apply(app, row)
        return { request: toChangeRequestView(result.request), result: { statusCode: result.statusCode, body: result.body }, payload: null }
      }
      // Taken once: a second click does not perform the action a second time.
      const [taken] = await deps.db.update(changeRequests).set({ appliedAt: new Date() }).where(and(eq(changeRequests.id, row.id), eq(changeRequests.status, 'approved'))).returning()
      if (!taken) throw new PlatformError(409, 'conflict', 'this request is no longer waiting to be applied')
      return { request: toChangeRequestView(taken), result: null, payload: taken.payload ?? {} }
    }
  )

  zapp.post(
    `${path}/:id/applied`,
    {
      schema: {
        tags: scope.tags,
        summary: 'Report the outcome of a console change',
        params: idParams,
        body: z.object({ ok: z.boolean(), error: z.string().max(1000).optional() }),
        response: { 200: changeRequestView, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request) => {
      const { row, actor } = await load(request, request.params.id)
      assertApplicable(row, actor)
      if (row.executor !== 'console') throw new PlatformError(409, 'conflict', 'this change is applied by the platform, not reported')
      return toChangeRequestView(await finish(deps.db, row, request.body.ok ? { ok: true } : { ok: false, error: request.body.error ?? 'the console could not make the change' }))
    }
  )
}

/** One tenant's switch and requests. Registered in the customer scope, so the caller is already resolved. */
export const tenantApprovalRoutes = (deps: ApprovalRouteDeps): FastifyPluginAsyncZod => async (app) => {
  const tags = ['approvals', CONSOLE_ONLY_TAG]
  const consoleTenant = (request: { tenant?: TenantContext }) => requireConsolePrincipal(request.tenant as TenantContext, 'approvals are managed from the console')
  const actorOf = (tenant: TenantContext): Actor => {
    if (tenant.principal.kind !== 'console') throw new PlatformError(403, 'forbidden', 'approvals are managed from the console')
    return { id: tenant.principal.actor, label: tenant.principal.actorLabel, role: tenant.principal.role }
  }
  const view = (required: boolean) => ({ required, types: types((id) => !isOperatorType(id)) })

  app.get('/v1/approvals', { schema: { tags, summary: 'Whether sensitive changes need a second person, and which', response: { 200: settingView, 403: errorBody } } }, async (request) => view(consoleTenant(request).approvalsRequired === true))

  app.put(
    '/v1/approvals',
    {
      config: { approval: 'approvals.disable' },
      schema: {
        tags,
        summary: 'Require a second person for sensitive changes, or stop',
        description: 'Switching on takes effect at once. Switching off is itself a change that waits for a second person.',
        body: z.object({ required: z.boolean() }),
        response: { 200: settingView, ...held, 403: errorBody },
      },
    },
    async (request) => {
      const t = consoleTenant(request)
      const actor = actorOf(t)
      if (actor.role === 'member') throw new PlatformError(403, 'forbidden', 'members cannot change this')
      await deps.db.update(tenants).set({ approvalsRequired: request.body.required, updatedAt: new Date() }).where(eq(tenants.id, t.id))
      return view(request.body.required)
    }
  )

  requestRoutes(app, deps, {
    base: '/v1',
    tags,
    resolve: (request) => {
      const t = consoleTenant(request)
      return { tenantId: t.id, actor: actorOf(t) }
    },
    required: (request) => (request.tenant as TenantContext).approvalsRequired === true,
    consoleTypes: TENANT_CONSOLE_TYPE_IDS,
  })
}

/**
 * Requests that belong to no tenant: changes to operator accounts. Registered in the operator scope.
 * The break-glass admin token reads them and decides nothing: it is nobody in particular, so it
 * cannot be "a second person".
 */
export const operatorApprovalRoutes = (deps: ApprovalRouteDeps & { required: boolean }): FastifyPluginAsyncZod => async (app) => {
  const tags = ['admin', CONSOLE_ONLY_TAG]
  app.get('/admin/approvals', { schema: { tags, summary: 'Whether changes to operator accounts need a second operator', response: { 200: settingView } } }, async () => ({ required: deps.required, types: types(isOperatorType) }))

  requestRoutes(app, deps, {
    base: '/admin',
    tags,
    resolve: (request) => {
      const operator = request.operator
      if (!operator) throw new PlatformError(403, 'forbidden', 'operator role required')
      if (operator.via !== 'console' && request.method !== 'GET') throw new PlatformError(403, 'forbidden', 'the break-glass token cannot ask for or decide a change')
      return { tenantId: null, actor: { id: operator.actor, label: operator.actorLabel, role: 'operator' } }
    },
    required: () => deps.required,
    consoleTypes: OPERATOR_CONSOLE_TYPE_IDS,
  })
}

