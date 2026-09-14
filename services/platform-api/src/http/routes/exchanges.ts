/**
 * Connections, credentials and proofs (P4). Commands go to agent-service and return 202 with the
 * record id; the mirror row is written immediately so GET works before the first outbox event
 * arrives, and progress reaches the customer through webhooks or polling.
 *
 * Ids exposed here are the agent's Credo record ids, always scoped by tenant.
 */
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { AgentClient } from '../../agent-client.ts'
import type { Database } from '../../db/client.ts'
import { connections, credentials, proofTemplates, proofs } from '../../db/schema.ts'
import { expandTemplate, templateDefinition } from '../../templates.ts'
import { connectionView, credentialView, proofView, toConnectionView, toCredentialView, toProofView } from '../../views.ts'
import { assertTenantReady, type TenantContext } from '../auth.ts'
import { badRequest, notFound } from '../errors.ts'
import { resolveCredentialDefinition } from './catalogue.ts'

export interface ExchangeDeps {
  db: Database
  agent: AgentClient
}

const errorBody = z.object({ error: z.string(), reason: z.string() })
const externalId = z.string().min(1).max(200).optional()
const recordId = z.string().min(1).max(100)

export const exchangeRoutes = (deps: ExchangeDeps): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => {
    const t = request.tenant as TenantContext
    assertTenantReady(t)
    return t
  }

  // --- connections -------------------------------------------------------------------
  app.post(
    '/v1/connections/invitations',
    {
      schema: {
        tags: ['connections'],
        summary: 'Create a connection invitation',
        description: 'Returns an out-of-band invitation URL for the holder app to open or scan (encode the URL in a QR code). `multiUse: true` serves kiosk and web-embed cases where many wallets connect through one invitation.',
        body: z.object({ multiUse: z.boolean().default(false), alias: z.string().max(200).optional(), externalId }),
        response: { 201: z.object({ invitationId: z.string(), invitationUrl: z.string(), multiUse: z.boolean() }), 409: errorBody },
      },
    },
    async (request, reply) => {
      const t = tenant(request)
      const result = await deps.agent.createInvitation(t.agentTenantId, { multiUse: request.body.multiUse, alias: request.body.alias, correlationId: request.body.externalId })
      return reply.code(201).send({ invitationId: result.outOfBandId, invitationUrl: result.invitationUrl, multiUse: result.multiUse })
    }
  )

  app.get(
    '/v1/connections',
    { schema: { tags: ['connections'], summary: 'List connections', querystring: z.object({ invitationId: z.string().optional(), state: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: z.array(connectionView) } } },
    async (request) => {
      const t = tenant(request)
      const filters = [eq(connections.tenantId, t.id)]
      if (request.query.invitationId) filters.push(eq(connections.invitationId, request.query.invitationId))
      if (request.query.state) filters.push(eq(connections.state, request.query.state))
      const rows = await deps.db.select().from(connections).where(and(...filters)).orderBy(desc(connections.createdAt)).limit(request.query.limit)
      return rows.map(toConnectionView)
    }
  )

  app.get('/v1/connections/:id', { schema: { tags: ['connections'], summary: 'Get a connection', params: z.object({ id: recordId }), response: { 200: connectionView, 404: errorBody } } }, async (request) => {
    const t = tenant(request)
    const [row] = await deps.db.select().from(connections).where(and(eq(connections.tenantId, t.id), eq(connections.recordId, request.params.id)))
    if (!row) throw notFound('connection')
    return toConnectionView(row)
  })

  // --- credentials -------------------------------------------------------------------
  app.post(
    '/v1/credentials/offer',
    {
      schema: {
        tags: ['credentials'],
        summary: 'Offer a credential',
        description: 'Asynchronous. Returns the exchange immediately in state `offer-sent`; `credential-issued` means the holder received it, `done` that it acknowledged. Attribute values are strings; `expiresAt` is epoch seconds as a string and must be in the future. `credentialDefinitionId` accepts the catalogue id or the ledger id.',
        body: z.object({ connectionId: recordId, credentialDefinitionId: z.string().min(1).max(300), attributes: z.record(z.string(), z.string()), externalId }),
        response: { 202: credentialView, 400: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request, reply) => {
      const t = tenant(request)
      const credDef = await resolveCredentialDefinition(deps.agent, t, request.body.credentialDefinitionId)
      const result = await deps.agent.offerCredential(t.agentTenantId, {
        connectionId: request.body.connectionId,
        credentialDefinitionObjectId: credDef.id,
        values: request.body.attributes,
        correlationId: request.body.externalId,
      })
      const [row] = await deps.db
        .insert(credentials)
        .values({ tenantId: t.id, recordId: result.credentialExchangeId, connectionId: request.body.connectionId, state: result.state, threadId: result.threadId, externalId: request.body.externalId ?? null, credentialDefinitionId: credDef.unqualifiedId, attributes: request.body.attributes })
        .onConflictDoUpdate({ target: [credentials.tenantId, credentials.recordId], set: { credentialDefinitionId: credDef.unqualifiedId, attributes: request.body.attributes } })
        .returning()
      return reply.code(202).send(toCredentialView(row))
    }
  )

  app.get(
    '/v1/credentials',
    { schema: { tags: ['credentials'], summary: 'List credential exchanges', querystring: z.object({ connectionId: z.string().optional(), state: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: z.array(credentialView) } } },
    async (request) => {
      const t = tenant(request)
      const filters = [eq(credentials.tenantId, t.id)]
      if (request.query.connectionId) filters.push(eq(credentials.connectionId, request.query.connectionId))
      if (request.query.state) filters.push(eq(credentials.state, request.query.state))
      const rows = await deps.db.select().from(credentials).where(and(...filters)).orderBy(desc(credentials.createdAt)).limit(request.query.limit)
      return rows.map(toCredentialView)
    }
  )

  app.get('/v1/credentials/:id', { schema: { tags: ['credentials'], summary: 'Get a credential exchange', params: z.object({ id: recordId }), response: { 200: credentialView, 404: errorBody } } }, async (request) => {
    const t = tenant(request)
    const [row] = await deps.db.select().from(credentials).where(and(eq(credentials.tenantId, t.id), eq(credentials.recordId, request.params.id)))
    if (!row) throw notFound('credential exchange')
    return toCredentialView(row)
  })

  // --- proofs ------------------------------------------------------------------------
  app.post(
    '/v1/proofs/request',
    {
      schema: {
        tags: ['proofs'],
        summary: 'Request a proof',
        description: 'Asynchronous. Either a stored `templateId` or an inline `request` in the template shape. Every group automatically checks `expiresAt >= now`. When the exchange reaches `done`, `verified` and the `disclosed` attributes are available.',
        body: z
          .object({ connectionId: recordId, templateId: z.uuid().optional(), request: templateDefinition.optional(), externalId })
          .refine((b) => (b.templateId ? 1 : 0) + (b.request ? 1 : 0) === 1, { message: 'provide exactly one of templateId or request' }),
        response: { 202: proofView, 400: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request, reply) => {
      const t = tenant(request)
      let definition = request.body.request
      if (request.body.templateId) {
        const [template] = await deps.db.select().from(proofTemplates).where(and(eq(proofTemplates.tenantId, t.id), eq(proofTemplates.id, request.body.templateId)))
        if (!template) throw notFound('proof template')
        definition = templateDefinition.parse(template.definition)
      }
      if (!definition) throw badRequest('provide exactly one of templateId or request')
      const catalogue = await deps.agent.listCatalogue(t.agentTenantId)
      const groups = expandTemplate(definition, catalogue)
      const result = await deps.agent.requestProof(t.agentTenantId, { connectionId: request.body.connectionId, name: definition.name, groups, correlationId: request.body.externalId })
      const [row] = await deps.db
        .insert(proofs)
        .values({ tenantId: t.id, recordId: result.proofExchangeId, connectionId: request.body.connectionId, state: result.state, threadId: result.threadId, externalId: request.body.externalId ?? null, templateId: request.body.templateId ?? null })
        .onConflictDoUpdate({ target: [proofs.tenantId, proofs.recordId], set: { templateId: request.body.templateId ?? null } })
        .returning()
      return reply.code(202).send(toProofView(row))
    }
  )

  app.get(
    '/v1/proofs',
    { schema: { tags: ['proofs'], summary: 'List proof exchanges', querystring: z.object({ connectionId: z.string().optional(), state: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: z.array(proofView) } } },
    async (request) => {
      const t = tenant(request)
      const filters = [eq(proofs.tenantId, t.id)]
      if (request.query.connectionId) filters.push(eq(proofs.connectionId, request.query.connectionId))
      if (request.query.state) filters.push(eq(proofs.state, request.query.state))
      const rows = await deps.db.select().from(proofs).where(and(...filters)).orderBy(desc(proofs.createdAt)).limit(request.query.limit)
      return rows.map(toProofView)
    }
  )

  app.get('/v1/proofs/:id', { schema: { tags: ['proofs'], summary: 'Get a proof exchange', params: z.object({ id: recordId }), response: { 200: proofView, 404: errorBody } } }, async (request) => {
    const t = tenant(request)
    const [row] = await deps.db.select().from(proofs).where(and(eq(proofs.tenantId, t.id), eq(proofs.recordId, request.params.id)))
    if (!row) throw notFound('proof exchange')
    return toProofView(row)
  })
}
