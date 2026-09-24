/**
 * Internal command routes (A2/A5). No customer auth here: the Phase 3 platform API owns that and
 * is the only caller. Every route is scoped by tenant id in the path.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { LEDGER_OBJECT_KINDS, LEDGER_OBJECT_STATUSES, tenants } from '../db/schema.ts'

import { type CatalogueDeps, publishCredentialDefinition, publishSchema } from '../ledger/catalogue.ts'
import { schemaInput } from '../ledger/schema-input.ts'
import { listCatalogue, listCataloguePage, setSchemaDeprecated } from '../ledger/deprecation.ts'
import { reconcileOnce } from '../exchanges/reconcile.ts'
import { ExchangeInputError } from '../exchanges/builders.ts'
import {
  ExchangeError,
  type ExchangeDeps,
  createInvitation,
  getConnection,
  getCredentialExchange,
  abandonExchange,
  acceptPresentation,
  getProofExchange,
  issueCredential,
  listConnections,
  offerCredential,
  requestProof,
} from '../exchanges/exchanges.ts'
import { type OnboardingDeps, createTenantRecord, onboardTenant } from '../tenants/onboarding.ts'
import { EndorsementRefusedError } from '../endorser/endorser-client.ts'
import { type OutboxDeps, outboxRoutes } from './outbox-routes.ts'
import { WireIdentifierError } from '@12id/credo-base/ids.ts'

export interface CommandDeps {
  onboarding: OnboardingDeps
  catalogue: CatalogueDeps
  exchanges: ExchangeDeps
  outbox: OutboxDeps
}

const tenantParams = z.object({ tenantId: z.string().min(1) })
const correlation = z.string().min(1).max(200).optional()
const errorBody = z.object({ error: z.string(), reason: z.string() })

const ledgerObjectView = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  version: z.string(),
  tag: z.string(),
  status: z.string(),
  qualifiedId: z.string().nullable(),
  unqualifiedId: z.string().nullable(),
  lastError: z.string().nullable(),
})
const catalogueItemView = ledgerObjectView.extend({ schemaObjectId: z.string().nullable(), attributes: z.array(z.string()).nullable() })

export const commandRoutes = (deps: CommandDeps): FastifyPluginAsyncZod => async (app) => {
  // Map domain errors to status codes; everything else stays a generic 500 (internalApiErrorHandler).
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ExchangeError) return reply.code(error.status).send({ error: 'exchange', reason: error.message })
    const validation = (error as { validation?: unknown; message?: string }).validation
    if (error instanceof ExchangeInputError || error instanceof WireIdentifierError || validation) {
      return reply.code(400).send({ error: 'bad_request', reason: (error as Error).message })
    }
    if (error instanceof EndorsementRefusedError) return reply.code(422).send({ error: 'endorsement_refused', reason: error.message })
    // Fastify's own client errors (empty JSON body, payload too large) carry a 4xx statusCode.
    const statusCode = (error as { statusCode?: number }).statusCode
    if (statusCode && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: 'bad_request', reason: (error as Error).message })
    request.log.error({ err: error }, 'command failed')
    return reply.code(500).send({ error: 'internal', reason: 'internal error' })
  })

  // --- tenants -----------------------------------------------------------------------
  app.post('/tenants', { schema: { body: z.object({ label: z.string().min(1).max(200) }), response: { 202: z.object({ tenantId: z.string(), status: z.string() }) } } }, async (request, reply) => {
    const tenantId = await createTenantRecord(deps.onboarding, request.body.label)
    // Onboarding writes the ledger; run it without holding the request open.
    void onboardTenant(deps.onboarding, tenantId).catch(() => undefined)
    return reply.code(202).send({ tenantId, status: 'pending' })
  })

  app.get('/tenants/:tenantId', { schema: { params: tenantParams, response: { 200: z.object({ tenantId: z.string(), label: z.string(), status: z.string(), did: z.string().nullable(), lastError: z.string().nullable() }), 404: errorBody } } }, async (request, reply) => {
    const [row] = await deps.onboarding.db.select().from(tenants).where(eq(tenants.id, request.params.tenantId))
    if (!row) return reply.code(404).send({ error: 'not_found', reason: `unknown tenant ${request.params.tenantId}` })
    return { tenantId: row.id, label: row.label, status: row.status, did: row.did, lastError: row.lastError }
  })

  app.post('/tenants/:tenantId/onboard', { schema: { params: tenantParams, response: { 200: z.object({ tenantId: z.string(), status: z.string(), did: z.string().nullable() }) } } }, async (request) => {
    const row = await onboardTenant(deps.onboarding, request.params.tenantId)
    return { tenantId: row.id, status: row.status, did: row.did }
  })

  // --- catalogue ---------------------------------------------------------------------
  app.post('/tenants/:tenantId/schemas', { schema: { params: tenantParams, body: schemaInput, response: { 200: ledgerObjectView, 400: errorBody, 422: errorBody } } }, async (request) => {
    return publishSchema(deps.catalogue, request.params.tenantId, request.body)
  })

  app.post(
    '/tenants/:tenantId/credential-definitions',
    { schema: { params: tenantParams, body: z.object({ schemaObjectId: z.uuid(), tag: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('default') }), response: { 200: ledgerObjectView, 422: errorBody } } },
    async (request) => publishCredentialDefinition(deps.catalogue, request.params.tenantId, request.body.schemaObjectId, request.body.tag)
  )

  app.get('/tenants/:tenantId/catalogue', { schema: { params: tenantParams, response: { 200: z.array(catalogueItemView) } } }, async (request) =>
    listCatalogue(deps.catalogue.db, request.params.tenantId)
  )

  // One kind, paged, newest first (Phase 4 C9). The unpaged route above stays for lookups that need everything.
  app.get(
    '/tenants/:tenantId/catalogue/page',
    {
      schema: {
        params: tenantParams,
        querystring: z.object({
          kind: z.enum(LEDGER_OBJECT_KINDS),
          status: z.enum(LEDGER_OBJECT_STATUSES).optional(),
          q: z.string().trim().min(1).max(100).optional(),
          page: z.coerce.number().int().min(1).max(100_000).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        }),
        response: { 200: z.object({ items: z.array(catalogueItemView), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() }) },
      },
    },
    async (request) => listCataloguePage(deps.catalogue.db, request.params.tenantId, request.query)
  )

  app.post(
    '/tenants/:tenantId/schemas/:schemaObjectId/deprecation',
    { schema: { params: tenantParams.extend({ schemaObjectId: z.uuid() }), body: z.object({ deprecated: z.boolean() }), response: { 200: z.object({ status: z.string() }) } } },
    async (request) => ({ status: await setSchemaDeprecated(deps.catalogue.db, request.params.tenantId, request.params.schemaObjectId, request.body.deprecated) })
  )

  // Operator trigger for the stuck-exchange job (runs on an interval anyway).
  app.post('/admin/reconcile', { schema: { body: z.object({ ttlMs: z.number().int().positive() }), response: { 200: z.object({ abandoned: z.number() }) } } }, async (request) => ({
    abandoned: await reconcileOnce(deps.exchanges.agent, deps.exchanges.db, { ttlMs: request.body.ttlMs }, deps.exchanges.logger),
  }))

  // --- exchanges ---------------------------------------------------------------------
  app.post(
    '/tenants/:tenantId/invitations',
    { schema: { params: tenantParams, body: z.object({ multiUse: z.boolean().default(false), correlationId: correlation, alias: z.string().max(200).optional() }), response: { 200: z.object({ outOfBandId: z.string(), invitationUrl: z.string(), multiUse: z.boolean() }) } } },
    async (request) => createInvitation(deps.exchanges, request.params.tenantId, request.body)
  )

  app.get(
    '/tenants/:tenantId/connections',
    { schema: { params: tenantParams, querystring: z.object({ outOfBandId: z.string().optional() }), response: { 200: z.array(z.object({ id: z.string(), state: z.string(), theirLabel: z.string().nullable(), outOfBandId: z.string().nullable(), createdAt: z.date() })) } } },
    async (request) => listConnections(deps.exchanges, request.params.tenantId, request.query.outOfBandId)
  )

  const connectionView = z.object({ id: z.string(), state: z.string(), theirLabel: z.string().nullable(), outOfBandId: z.string().nullable(), createdAt: z.date() })
  app.get('/tenants/:tenantId/connections/:id', { schema: { params: tenantParams.extend({ id: z.string() }), response: { 200: connectionView, 404: errorBody } } }, async (request) =>
    getConnection(deps.exchanges, request.params.tenantId, request.params.id)
  )

  app.post(
    '/tenants/:tenantId/credentials/offer',
    {
      schema: {
        params: tenantParams,
        body: z.object({ connectionId: z.string().min(1), credentialDefinitionObjectId: z.uuid(), values: z.record(z.string(), z.string()), correlationId: correlation, hold: z.boolean().optional() }),
        response: { 202: z.object({ credentialExchangeId: z.string(), threadId: z.string(), state: z.string() }), 400: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request, reply) => reply.code(202).send(await offerCredential(deps.exchanges, request.params.tenantId, request.body))
  )

  app.get(
    '/tenants/:tenantId/credentials/:id',
    { schema: { params: tenantParams.extend({ id: z.string() }), response: { 200: z.object({ id: z.string(), state: z.string(), threadId: z.string(), connectionId: z.string().nullable(), errorMessage: z.string().nullable(), credentialDefinitionId: z.string().nullable(), attributes: z.record(z.string(), z.string()) }), 404: errorBody } } },
    async (request) => getCredentialExchange(deps.exchanges, request.params.tenantId, request.params.id)
  )

  const predicate = z.object({ name: z.string(), type: z.enum(['>=', '>', '<=', '<']), value: z.number().int() })
  app.post(
    '/tenants/:tenantId/proofs/request',
    {
      schema: {
        params: tenantParams,
        body: z.object({
          connectionId: z.string().min(1),
          name: z.string().min(1).max(100),
          groups: z.array(z.object({ key: z.string(), attributes: z.array(z.string()), credentialDefinitionIds: z.array(z.string()).min(1), predicates: z.array(predicate).optional() })).min(1),
          correlationId: correlation,
          hold: z.boolean().optional(),
        }),
        response: { 202: z.object({ proofExchangeId: z.string(), threadId: z.string(), state: z.string() }), 400: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request, reply) => reply.code(202).send(await requestProof(deps.exchanges, request.params.tenantId, request.body))
  )

  app.get(
    '/tenants/:tenantId/proofs/:id',
    {
      schema: {
        params: tenantParams.extend({ id: z.string() }),
        response: {
          200: z.object({ id: z.string(), state: z.string(), threadId: z.string(), connectionId: z.string().nullable(), isVerified: z.boolean().nullable(), errorMessage: z.string().nullable(), disclosed: z.record(z.string(), z.record(z.string(), z.string())) }),
          404: errorBody,
        },
      },
    },
    async (request) => getProofExchange(deps.exchanges, request.params.tenantId, request.params.id)
  )

  // --- biometric gate hold points (Phase 6 B2) ----------------------------------------
  const exchangeParams = tenantParams.extend({ id: z.string().min(1) })
  const transition = z.object({ id: z.string(), state: z.string() })
  const abandonBody = z.object({ reason: z.string().min(1).max(500) })

  app.post('/tenants/:tenantId/credentials/:id/issue', { schema: { params: exchangeParams, response: { 200: transition, 404: errorBody, 409: errorBody } } }, async (request) =>
    issueCredential(deps.exchanges, request.params.tenantId, request.params.id)
  )
  app.post('/tenants/:tenantId/credentials/:id/abandon', { schema: { params: exchangeParams, body: abandonBody, response: { 200: transition, 404: errorBody } } }, async (request) =>
    abandonExchange(deps.exchanges, request.params.tenantId, 'credential', request.params.id, request.body.reason)
  )
  app.post('/tenants/:tenantId/proofs/:id/accept', { schema: { params: exchangeParams, response: { 200: transition, 404: errorBody, 409: errorBody } } }, async (request) =>
    acceptPresentation(deps.exchanges, request.params.tenantId, request.params.id)
  )
  app.post('/tenants/:tenantId/proofs/:id/abandon', { schema: { params: exchangeParams, body: abandonBody, response: { 200: transition, 404: errorBody } } }, async (request) =>
    abandonExchange(deps.exchanges, request.params.tenantId, 'proof', request.params.id, request.body.reason)
  )

  // --- outbox feed for the platform API (Phase 3 P0) --------------------------------
  await app.register(outboxRoutes(deps.outbox))
}
