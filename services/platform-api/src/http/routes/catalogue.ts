/**
 * Schema and credential-definition catalogue (P4): a thin, read-through layer over agent-service,
 * which owns the ledger objects and both identifier forms (4-init §2.7.2).
 *
 * Reads take an API key or the console. Publishing and deprecation are console only (review K1):
 * ledger objects are immutable, so a leaked API key must not be able to write them.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { type AgentClient, type AgentLedgerObject, LEDGER_OBJECT_STATUSES } from '../../agent-client.ts'
import { assertTenantReady, type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { notFound } from '../errors.ts'
import { pageOf, pageQuery, searchQuery } from '../list.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'
import { held } from '../../approvals/requests.ts'

export interface CatalogueDeps {
  agent: AgentClient
}

const errorBody = z.object({ error: z.string(), reason: z.string() })
const catalogueListQuery = pageQuery.extend(searchQuery.shape).extend({ status: z.enum(LEDGER_OBJECT_STATUSES).optional() })
const listDescription = 'Newest first, paged with `page` and `pageSize`.'

export const schemaView = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  attributes: z.array(z.string()).nullable(),
  status: z.string(),
  /** Legacy unqualified id: what appears in offers and on the ledger browser. */
  schemaId: z.string().nullable(),
  qualifiedId: z.string().nullable(),
  lastError: z.string().nullable(),
})

export const credentialDefinitionView = z.object({
  id: z.string(),
  schemaId: z.string().nullable(),
  schemaName: z.string(),
  schemaVersion: z.string(),
  tag: z.string(),
  status: z.string(),
  /** Legacy unqualified id: what appears in offers and proof restrictions. */
  credentialDefinitionId: z.string().nullable(),
  qualifiedId: z.string().nullable(),
  lastError: z.string().nullable(),
})

export const toSchemaView = (o: AgentLedgerObject) => ({ id: o.id, name: o.name, version: o.version, attributes: o.attributes ?? null, status: o.status, schemaId: o.unqualifiedId, qualifiedId: o.qualifiedId, lastError: o.lastError })
export const toCredentialDefinitionView = (o: AgentLedgerObject) => ({ id: o.id, schemaId: o.schemaObjectId ?? null, schemaName: o.name, schemaVersion: o.version, tag: o.tag, status: o.status, credentialDefinitionId: o.unqualifiedId, qualifiedId: o.qualifiedId, lastError: o.lastError })

/** Accepts the catalogue id or the unqualified ledger id of a published credential definition. */
export async function resolveCredentialDefinition(agent: AgentClient, tenant: TenantContext, idOrLedgerId: string): Promise<AgentLedgerObject> {
  const catalogue = await agent.listCatalogue(tenant.agentTenantId)
  const match = catalogue.find((o) => o.kind === 'credential_definition' && (o.id === idOrLedgerId || o.unqualifiedId === idOrLedgerId))
  if (!match) throw notFound('credential definition')
  return match
}

export const catalogueRoutes = (deps: CatalogueDeps): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => {
    const t = request.tenant as TenantContext
    assertTenantReady(t)
    return t
  }
  const publisher = (request: { tenant?: TenantContext }) => tenant({ tenant: requireConsolePrincipal(request.tenant as TenantContext, 'the catalogue is published from the console') })
  const writeTags = ['catalogue', CONSOLE_ONLY_TAG]

  app.post(
    '/v1/schemas',
    {
      config: { approval: 'catalogue.schema' },
      schema: {
        tags: writeTags,
        summary: 'Publish a schema',
        description: 'Attributes are strings on the wire (no nested values, no native numbers). `expiresOn` (the expiry date as `YYYYMMDD`, UTC) is mandatory: v1 has no revocation, so every credential carries an expiry that every proof request checks. An attribute named `id` is refused: wallets treat it as the credential subject\'s identifier and cannot store the credential.',
        body: z.object({
          name: z.string().min(1).max(200),
          version: z.string().regex(/^\d+(\.\d+){0,2}$/, 'version like 1.0'),
          // Refused here as well as in agent-service, so that a request held for approval is not doomed (C17).
          attributes: z
            .array(z.string().min(1).max(100))
            .min(1)
            .max(125)
            .refine((attributes) => !attributes.includes('id'), "id is reserved: wallets treat it as the credential subject's identifier and cannot store the credential; use a specific name such as memberId"),
        }),
        response: { 201: schemaView, ...held, 400: errorBody, 403: errorBody, 409: errorBody, 422: errorBody },
      },
    },
    async (request, reply) => reply.code(201).send(toSchemaView(await deps.agent.publishSchema(publisher(request).agentTenantId, request.body)))
  )

  app.get(
    '/v1/schemas',
    { schema: { tags: ['catalogue'], summary: 'List schemas', description: `${listDescription} \`q\` matches the schema name.`, querystring: catalogueListQuery, response: { 200: pageOf(schemaView) } } },
    async (request) => {
      const page = await deps.agent.listCataloguePage(tenant(request).agentTenantId, { kind: 'schema', ...request.query })
      return { ...page, items: page.items.map(toSchemaView) }
    }
  )

  app.post(
    '/v1/schemas/:id/deprecation',
    {
      schema: {
        tags: writeTags,
        summary: 'Deprecate or reactivate a schema version',
        description: 'A deprecated version refuses new offers; credentials already issued under it stay verifiable and templates with `versions: "all"` keep accepting them.',
        params: z.object({ id: z.uuid() }),
        body: z.object({ deprecated: z.boolean() }),
        response: { 200: z.object({ status: z.string() }), 400: errorBody, 403: errorBody, 404: errorBody },
      },
    },
    async (request) => deps.agent.setSchemaDeprecated(publisher(request).agentTenantId, request.params.id, request.body.deprecated)
  )

  app.post(
    '/v1/credential-definitions',
    {
      config: { approval: 'catalogue.cred_def' },
      schema: {
        tags: writeTags,
        summary: 'Publish a credential definition',
        description: 'Published without revocation support (v1 decision, cannot be changed later for this definition).',
        body: z.object({ schemaId: z.uuid(), tag: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('default') }),
        response: { 201: credentialDefinitionView, ...held, 400: errorBody, 403: errorBody, 404: errorBody, 409: errorBody, 422: errorBody },
      },
    },
    async (request, reply) =>
      reply.code(201).send(toCredentialDefinitionView(await deps.agent.publishCredentialDefinition(publisher(request).agentTenantId, { schemaObjectId: request.body.schemaId, tag: request.body.tag })))
  )

  app.get(
    '/v1/credential-definitions',
    {
      schema: { tags: ['catalogue'], summary: 'List credential definitions', description: `${listDescription} \`q\` matches the schema name or the tag.`, querystring: catalogueListQuery, response: { 200: pageOf(credentialDefinitionView) } },
    },
    async (request) => {
      const page = await deps.agent.listCataloguePage(tenant(request).agentTenantId, { kind: 'credential_definition', ...request.query })
      return { ...page, items: page.items.map(toCredentialDefinitionView) }
    }
  )
}
