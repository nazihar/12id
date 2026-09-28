/**
 * Connections, credentials and proofs (P4). Commands go to agent-service and return 202 with the
 * record id; the mirror row is written immediately so GET works before the first outbox event
 * arrives, and progress reaches the customer through webhooks or polling.
 *
 * Ids exposed here are the agent's Credo record ids, always scoped by tenant.
 */
import { type SQL, and, desc, eq, inArray, or } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { AgentClient } from '../../agent-client.ts'
import type { BiometricClient } from '../../biometric-client.ts'
import { type GateEngine, biometricLogView, gatesFor } from '../../biometric/gate.ts'
import { effectivePolicy, runGated } from '../../biometric/gating.ts'
import type { Database } from '../../db/client.ts'
import { connections, credentials, proofTemplates, proofs } from '../../db/schema.ts'
import { type ErasureDeps, type Requester, eraseConnection, eraseExchange } from '../../erasure.ts'
import { expandTemplate, templateDefinition } from '../../templates.ts'
import { connectionView, credentialView, expiryOf, proofView, toConnectionView, toCredentialView, toProofView } from '../../views.ts'
import { assertTenantReady, type TenantContext } from '../auth.ts'
import { cleanReason, maskConnection, maskCredential, maskProof, masked } from '../personal-data.ts'
import { containsI, createdBetween, createdRange, listPage, many, oneOrMany, pageOf, pageQuery, searchQuery } from '../list.ts'
import { PlatformError, badRequest, notFound } from '../errors.ts'
import { resolveCredentialDefinition } from './catalogue.ts'

export interface ExchangeDeps {
  db: Database
  agent: AgentClient
  /** Phase 6; absent when biometric-service is not configured (nothing is gated). */
  biometric?: BiometricClient
  gates?: GateEngine
  /** Phase 7 H1: agent, biometric-service and the webhook queue, for erasure. */
  erasure: ErasureDeps
}

const errorBody = z.object({ error: z.string(), reason: z.string() })
const externalId = z.string().min(1).max(200).optional()
const recordId = z.string().min(1).max(100)

/** List filters shared by the three exchange kinds (Phase 4 C9). `q` and `externalId` are contains matches. */
const exchangeListQuery = pageQuery.extend(createdRange.shape).extend(searchQuery.shape).extend({
  state: oneOrMany(z.string().min(1).max(50)).describe('One or more states; repeat the parameter for several.'),
  externalId: z.string().trim().min(1).max(200).optional().describe('Case-insensitive contains match on the external id.'),
})
type ExchangeListQuery = z.infer<typeof exchangeListQuery>
const listDescription = 'Newest first (`createdAt` descending), paged with `page` and `pageSize`.'
type ExchangeTable = typeof connections | typeof credentials | typeof proofs

function exchangeFilters(table: ExchangeTable, tenantId: string, query: ExchangeListQuery, searchColumns: AnyPgColumn[]): SQL[] {
  const filters: SQL[] = [eq(table.tenantId, tenantId), ...createdBetween(table.createdAt, query)]
  const states = many(query.state)
  if (states.length) filters.push(inArray(table.state, states))
  if (query.externalId) filters.push(containsI(table.externalId, query.externalId))
  const q = query.q
  if (q) filters.push(or(...searchColumns.map((col) => containsI(col, q)))!)
  return filters
}

/** Phase 6: the tenant's reference face image for a biometric-gated exchange. Used once, never returned. */
const biometricInput = z
  .object({ referenceImage: z.string().min(100).max(7_000_000).describe('Base64 JPEG or PNG, at most 5 MB decoded, one face.') })
  .optional()
  .describe('Required when the biometric policy for this credential definition or proof template applies; ignored otherwise.')
// A 5 MB image is about 6.7 MB of base64.
const GATED_BODY_LIMIT = 8 * 1024 * 1024

const same = <T>(view: T) => view

/** Erasure body (Phase 7 H1). Operators must give a reason; the tenant's own people may. */
const eraseBody = z.object({ reason: z.string().max(500).optional().describe('Why the data is erased; recorded in the audit log. Required from operators.') }).nullish()
const eraseDescription = (what: string) =>
  `Removes the personal data of ${what} everywhere the platform holds it (the exchange record in the agent, webhook delivery bodies, biometric scores) and keeps the record itself with its ids, state and timestamps, so lists and history stay whole. Only finished exchanges (\`done\`, \`abandoned\`, \`declined\`) can be erased; a running one answers 409. Repeating the call is harmless. A \`record.erased\` webhook follows. The credential in the holder's wallet is not affected.`

/** Who is erasing: an API key, or a console owner, admin or operator (never a member). */
function requesterOf(request: { tenant?: TenantContext; body?: unknown; auditReason?: string }): Requester {
  const principal = (request.tenant as TenantContext).principal
  if (principal.kind === 'apiKey') return { via: 'api_key', actor: principal.apiKeyId }
  if (principal.role === 'member') throw new PlatformError(403, 'forbidden', 'members cannot erase personal data')
  const reason = cleanReason((request.body as { reason?: unknown } | undefined)?.reason)
  if (principal.role === 'operator' && !reason) throw new PlatformError(400, 'reason_required', "operators must give a reason to erase a tenant's data")
  if (reason) request.auditReason = `erase: ${reason}`
  return { via: 'console', actor: principal.actor, role: principal.role, reason }
}

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
    {
      schema: {
        tags: ['connections'],
        summary: 'List connections',
        description: `${listDescription} \`q\` matches the external id or the holder's label.`,
        querystring: exchangeListQuery.extend({ invitationId: z.string().optional() }),
        response: { 200: pageOf(connectionView) },
      },
    },
    async (request) => {
      const t = tenant(request)
      const filters = exchangeFilters(connections, t.id, request.query, [connections.externalId, connections.theirLabel])
      if (request.query.invitationId) filters.push(eq(connections.invitationId, request.query.invitationId))
      const page = await listPage(deps.db, { table: connections, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(connections).where(where).orderBy(desc(connections.createdAt), desc(connections.recordId)).limit(limit).offset(offset)
      )
      const hide = masked(request)
      return { ...page, items: page.items.map((r) => (hide ? maskConnection(toConnectionView(r)) : toConnectionView(r))) }
    }
  )

  app.get('/v1/connections/:id', { schema: { tags: ['connections'], summary: 'Get a connection', params: z.object({ id: recordId }), response: { 200: connectionView, 404: errorBody } } }, async (request) => {
    const t = tenant(request)
    const [row] = await deps.db.select().from(connections).where(and(eq(connections.tenantId, t.id), eq(connections.recordId, request.params.id)))
    if (!row) throw notFound('connection')
    return masked(request) ? maskConnection(toConnectionView(row)) : toConnectionView(row)
  })

  // --- credentials -------------------------------------------------------------------
  app.post(
    '/v1/credentials/offer',
    {
      schema: {
        tags: ['credentials'],
        summary: 'Offer a credential',
        description: 'Asynchronous. Returns the exchange immediately in state `offer-sent`; `credential-issued` means the holder received it, `done` that it acknowledged. Attribute values are strings; `expiresAt` is epoch seconds as a string and must be in the future. `credentialDefinitionId` accepts the catalogue id or the ledger id.',
        body: z.object({ connectionId: recordId, credentialDefinitionId: z.string().min(1).max(300), attributes: z.record(z.string(), z.string()), externalId, biometric: biometricInput }),
        response: { 202: credentialView, 400: errorBody, 404: errorBody, 409: errorBody, 422: errorBody },
      },
      bodyLimit: GATED_BODY_LIMIT,
    },
    async (request, reply) => {
      const t = tenant(request)
      const credDef = await resolveCredentialDefinition(deps.agent, t, request.body.credentialDefinitionId)
      const policy = deps.biometric ? await effectivePolicy(deps.db, t.id, { kind: 'credentialDefinition', id: credDef.id }) : null
      const result = await runGated(deps, { tenantId: t.id, recordType: 'credential', policy, referenceImage: request.body.biometric?.referenceImage }, {
        send: (hold) =>
          deps.agent.offerCredential(t.agentTenantId, {
            connectionId: request.body.connectionId,
            credentialDefinitionObjectId: credDef.id,
            values: request.body.attributes,
            correlationId: request.body.externalId,
            ...(hold ? { hold } : {}),
          }),
        recordOf: (r) => ({ recordId: r.credentialExchangeId, threadId: r.threadId }),
        mirror: async (tx, r) => {
          await tx
            .insert(credentials)
            .values({ tenantId: t.id, recordId: r.credentialExchangeId, connectionId: request.body.connectionId, state: r.state, threadId: r.threadId, externalId: request.body.externalId ?? null, credentialDefinitionId: credDef.unqualifiedId, attributes: request.body.attributes, expiresAt: expiryOf(request.body.attributes) })
            .onConflictDoUpdate({ target: [credentials.tenantId, credentials.recordId], set: { credentialDefinitionId: credDef.unqualifiedId, attributes: request.body.attributes, expiresAt: expiryOf(request.body.attributes) } })
        },
      })
      const [row] = await deps.db.select().from(credentials).where(and(eq(credentials.tenantId, t.id), eq(credentials.recordId, result.credentialExchangeId)))
      const gates = await gatesFor(deps.db, t.id, 'credential', [row!.recordId])
      return reply.code(202).send(toCredentialView(row!, gates.get(row!.recordId)))
    }
  )

  app.get(
    '/v1/credentials',
    {
      schema: {
        tags: ['credentials'],
        summary: 'List credential exchanges',
        description: `${listDescription} \`q\` matches the external id.`,
        querystring: exchangeListQuery.extend({ connectionId: z.string().optional() }),
        response: { 200: pageOf(credentialView) },
      },
    },
    async (request) => {
      const t = tenant(request)
      const filters = exchangeFilters(credentials, t.id, request.query, [credentials.externalId])
      if (request.query.connectionId) filters.push(eq(credentials.connectionId, request.query.connectionId))
      const page = await listPage(deps.db, { table: credentials, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(credentials).where(where).orderBy(desc(credentials.createdAt), desc(credentials.recordId)).limit(limit).offset(offset)
      )
      const gates = await gatesFor(deps.db, t.id, 'credential', page.items.map((r) => r.recordId))
      const hide = masked(request)
      return { ...page, items: page.items.map((r) => (hide ? maskCredential : same)(toCredentialView(r, gates.get(r.recordId)))) }
    }
  )

  app.get('/v1/credentials/:id', { schema: { tags: ['credentials'], summary: 'Get a credential exchange', params: z.object({ id: recordId }), response: { 200: credentialView, 404: errorBody } } }, async (request) => {
    const t = tenant(request)
    const [row] = await deps.db.select().from(credentials).where(and(eq(credentials.tenantId, t.id), eq(credentials.recordId, request.params.id)))
    if (!row) throw notFound('credential exchange')
    const gates = await gatesFor(deps.db, t.id, 'credential', [row.recordId])
    return (masked(request) ? maskCredential : same)(toCredentialView(row, gates.get(row.recordId)))
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
          .object({ connectionId: recordId, templateId: z.uuid().optional(), request: templateDefinition.optional(), externalId, biometric: biometricInput })
          .refine((b) => (b.templateId ? 1 : 0) + (b.request ? 1 : 0) === 1, { message: 'provide exactly one of templateId or request' }),
        response: { 202: proofView, 400: errorBody, 404: errorBody, 409: errorBody, 422: errorBody },
      },
      bodyLimit: GATED_BODY_LIMIT,
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
      const policy = deps.biometric ? await effectivePolicy(deps.db, t.id, { kind: 'template', id: request.body.templateId ?? null }) : null
      const result = await runGated(deps, { tenantId: t.id, recordType: 'proof', policy, referenceImage: request.body.biometric?.referenceImage }, {
        send: (hold) => deps.agent.requestProof(t.agentTenantId, { connectionId: request.body.connectionId, name: definition.name, groups, correlationId: request.body.externalId, ...(hold ? { hold } : {}) }),
        recordOf: (r) => ({ recordId: r.proofExchangeId, threadId: r.threadId }),
        mirror: async (tx, r) => {
          await tx
            .insert(proofs)
            .values({ tenantId: t.id, recordId: r.proofExchangeId, connectionId: request.body.connectionId, state: r.state, threadId: r.threadId, externalId: request.body.externalId ?? null, templateId: request.body.templateId ?? null })
            .onConflictDoUpdate({ target: [proofs.tenantId, proofs.recordId], set: { templateId: request.body.templateId ?? null } })
        },
      })
      const [row] = await deps.db.select().from(proofs).where(and(eq(proofs.tenantId, t.id), eq(proofs.recordId, result.proofExchangeId)))
      const gates = await gatesFor(deps.db, t.id, 'proof', [row!.recordId])
      return reply.code(202).send(toProofView(row!, gates.get(row!.recordId)))
    }
  )

  app.get(
    '/v1/proofs',
    {
      schema: {
        tags: ['proofs'],
        summary: 'List proof exchanges',
        description: `${listDescription} \`q\` matches the external id.`,
        querystring: exchangeListQuery.extend({ connectionId: z.string().optional() }),
        response: { 200: pageOf(proofView) },
      },
    },
    async (request) => {
      const t = tenant(request)
      const filters = exchangeFilters(proofs, t.id, request.query, [proofs.externalId])
      if (request.query.connectionId) filters.push(eq(proofs.connectionId, request.query.connectionId))
      const page = await listPage(deps.db, { table: proofs, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(proofs).where(where).orderBy(desc(proofs.createdAt), desc(proofs.recordId)).limit(limit).offset(offset)
      )
      const gates = await gatesFor(deps.db, t.id, 'proof', page.items.map((r) => r.recordId))
      const hide = masked(request)
      return { ...page, items: page.items.map((r) => (hide ? maskProof : same)(toProofView(r, gates.get(r.recordId)))) }
    }
  )

  app.get('/v1/proofs/:id', { schema: { tags: ['proofs'], summary: 'Get a proof exchange', params: z.object({ id: recordId }), response: { 200: proofView, 404: errorBody } } }, async (request) => {
    const t = tenant(request)
    const [row] = await deps.db.select().from(proofs).where(and(eq(proofs.tenantId, t.id), eq(proofs.recordId, request.params.id)))
    if (!row) throw notFound('proof exchange')
    const gates = await gatesFor(deps.db, t.id, 'proof', [row.recordId])
    return (masked(request) ? maskProof : same)(toProofView(row, gates.get(row.recordId)))
  })

  // --- erasure (Phase 7 H1) ---------------------------------------------------------
  const agentTenant = (t: TenantContext) => ({ id: t.id, agentTenantId: t.agentTenantId })

  app.post(
    '/v1/credentials/:id/erase',
    {
      schema: { tags: ['credentials'], summary: 'Erase the personal data of a credential exchange', description: eraseDescription('this credential exchange (its attribute values)'), params: z.object({ id: recordId }), body: eraseBody, response: { 200: credentialView, 400: errorBody, 403: errorBody, 404: errorBody, 409: errorBody } },
    },
    async (request) => {
      const t = tenant(request)
      await eraseExchange(deps.erasure, agentTenant(t), 'credential', request.params.id, requesterOf(request))
      const [row] = await deps.db.select().from(credentials).where(and(eq(credentials.tenantId, t.id), eq(credentials.recordId, request.params.id)))
      const gates = await gatesFor(deps.db, t.id, 'credential', [row!.recordId])
      return toCredentialView(row!, gates.get(row!.recordId))
    }
  )

  app.post(
    '/v1/proofs/:id/erase',
    {
      schema: { tags: ['proofs'], summary: 'Erase the personal data of a proof exchange', description: eraseDescription('this proof exchange (its disclosed values)'), params: z.object({ id: recordId }), body: eraseBody, response: { 200: proofView, 400: errorBody, 403: errorBody, 404: errorBody, 409: errorBody } },
    },
    async (request) => {
      const t = tenant(request)
      await eraseExchange(deps.erasure, agentTenant(t), 'proof', request.params.id, requesterOf(request))
      const [row] = await deps.db.select().from(proofs).where(and(eq(proofs.tenantId, t.id), eq(proofs.recordId, request.params.id)))
      const gates = await gatesFor(deps.db, t.id, 'proof', [row!.recordId])
      return toProofView(row!, gates.get(row!.recordId))
    }
  )

  app.post(
    '/v1/connections/:id/erase',
    {
      schema: {
        tags: ['connections'],
        summary: 'Erase a connection and every exchange on it',
        description: `${eraseDescription('this connection (the holder\'s label) and of every credential and proof exchange on it')} The agent drops the connection, so the holder can no longer reach this tenant through it. \`erasedExchanges\` lists the exchanges erased along with it.`,
        params: z.object({ id: recordId }),
        body: eraseBody,
        response: { 200: connectionView.extend({ erasedExchanges: z.object({ credentials: z.array(z.string()), proofs: z.array(z.string()) }) }), 400: errorBody, 403: errorBody, 404: errorBody, 409: errorBody },
      },
    },
    async (request) => {
      const t = tenant(request)
      const erased = await eraseConnection(deps.erasure, agentTenant(t), request.params.id, requesterOf(request))
      const [row] = await deps.db.select().from(connections).where(and(eq(connections.tenantId, t.id), eq(connections.recordId, request.params.id)))
      return { ...toConnectionView(row!), erasedExchanges: erased }
    }
  )

  // --- biometric log (Phase 6) ------------------------------------------------------
  const logDescription = 'Every step of the biometric gate for this exchange, oldest first: attempts with liveness and match scores against the thresholds, decisions, and what the platform did with the exchange. Never contains images. `biometric` is null when the exchange was not gated.'

  app.get(
    '/v1/credentials/:id/biometric-log',
    { schema: { tags: ['credentials'], summary: 'Biometric log of a credential exchange', description: logDescription, params: z.object({ id: recordId }), response: { 200: biometricLogView, 404: errorBody } }, config: { auditRead: true } },
    async (request) => {
      const t = tenant(request)
      const [row] = await deps.db.select({ recordId: credentials.recordId }).from(credentials).where(and(eq(credentials.tenantId, t.id), eq(credentials.recordId, request.params.id)))
      if (!row) throw notFound('credential exchange')
      return deps.gates ? deps.gates.log(t.id, 'credential', row.recordId) : { biometric: null, events: [] }
    }
  )

  app.get(
    '/v1/proofs/:id/biometric-log',
    { schema: { tags: ['proofs'], summary: 'Biometric log of a proof exchange', description: logDescription, params: z.object({ id: recordId }), response: { 200: biometricLogView, 404: errorBody } }, config: { auditRead: true } },
    async (request) => {
      const t = tenant(request)
      const [row] = await deps.db.select({ recordId: proofs.recordId }).from(proofs).where(and(eq(proofs.tenantId, t.id), eq(proofs.recordId, request.params.id)))
      if (!row) throw notFound('proof exchange')
      return deps.gates ? deps.gates.log(t.id, 'proof', row.recordId) : { biometric: null, events: [] }
    }
  )
}
