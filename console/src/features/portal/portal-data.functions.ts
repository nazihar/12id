/**
 * Tenant portal data (stage 4b), through the console scope for the tenant the member's active
 * organization maps to. Reads need membership; changes need the role's permission and name the
 * organization the page was showing.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { DELIVERY_STATUSES, WEBHOOK_EVENT_TYPES } from '@/features/tenant-data/types'
import { EXPIRY_ATTRIBUTE, templateDefinition } from '@/lib/template-schema'
import { tenantMiddleware } from '@/server/middleware'
import { PlatformCallError, platformFor, unwrap } from '@/server/platform.server'

import { assertSameOrganization, organizationInput } from './organization-input'

const LIST_LIMIT = 200
const attributeName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'attribute names are 1-100 characters of letters, digits, _ . -')

// --- catalogue ------------------------------------------------------------------------------

export const getPortalCatalogue = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => {
    const platform = platformFor(context.principal)
    const [schemas, credentialDefinitions] = await Promise.all([platform.GET('/v1/schemas'), platform.GET('/v1/credential-definitions')])
    return { schemas: unwrap(schemas), credentialDefinitions: unwrap(credentialDefinitions) }
  })

/** Publishes a schema on the ledger. `expiresAt` is always included: v1 credentials expire instead of being revoked. */
export const publishSchema = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ catalogue: ['publish'] })])
  .validator(
    organizationInput.extend({
      name: z.string().trim().min(1).max(200),
      version: z.string().regex(/^\d+(\.\d+){0,2}$/, 'use a version like 1.0'),
      attributes: z.array(attributeName).min(1).max(124),
    })
  )
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const attributes = [...new Set([...data.attributes.filter((a) => a !== EXPIRY_ATTRIBUTE), EXPIRY_ATTRIBUTE])]
    return unwrap(await platformFor(context.principal).POST('/v1/schemas', { body: { name: data.name, version: data.version, attributes } }))
  })

export const publishCredentialDefinition = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ catalogue: ['publish'] })])
  .validator(organizationInput.extend({ schemaId: z.uuid(), tag: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('default') }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/credential-definitions', { body: { schemaId: data.schemaId, tag: data.tag } }))
  })

export const setSchemaDeprecated = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ catalogue: ['deprecate'] })])
  .validator(organizationInput.extend({ schemaId: z.uuid(), deprecated: z.boolean() }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/schemas/{id}/deprecation', { params: { path: { id: data.schemaId } }, body: { deprecated: data.deprecated } }))
  })

// --- proof templates ------------------------------------------------------------------------

export const listPortalTemplates = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/v1/proof-templates')))

export const createPortalTemplate = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ template: ['create'] })])
  .validator(organizationInput.extend({ definition: templateDefinition }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/proof-templates', { body: data.definition }))
  })

export const updatePortalTemplate = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ template: ['update'] })])
  .validator(organizationInput.extend({ templateId: z.uuid(), definition: templateDefinition }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).PUT('/v1/proof-templates/{id}', { params: { path: { id: data.templateId } }, body: data.definition }))
  })

export const deletePortalTemplate = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ template: ['delete'] })])
  .validator(organizationInput.extend({ templateId: z.uuid() }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).DELETE('/v1/proof-templates/{id}', { params: { path: { id: data.templateId } } }))
  })

// --- exchanges and wallets ------------------------------------------------------------------

export const listPortalConnections = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/v1/connections', { params: { query: { limit: LIST_LIMIT } } })))

export const listPortalCredentials = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/v1/credentials', { params: { query: { limit: LIST_LIMIT } } })))

export const listPortalProofs = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/v1/proofs', { params: { query: { limit: LIST_LIMIT } } })))

export const listPortalWallets = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/v1/wallets', { params: { query: { limit: LIST_LIMIT } } })))

/** A connection invitation for testing with a holder app (the customer backend normally creates these). */
export const createPortalInvitation = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ exchange: ['create'] })])
  .validator(organizationInput.extend({ multiUse: z.boolean(), alias: z.string().trim().max(200).optional() }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/connections/invitations', { body: { multiUse: data.multiUse, alias: data.alias || undefined } }))
  })

// --- webhooks -------------------------------------------------------------------------------

export const getPortalWebhook = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => {
    try {
      return unwrap(await platformFor(context.principal).GET('/v1/webhook'))
    } catch (error) {
      if (error instanceof PlatformCallError && error.status === 404) return null
      throw error
    }
  })

/** Returns the signing secret only when the endpoint is created. */
export const setPortalWebhook = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ webhook: ['update'] })])
  .validator(
    organizationInput.extend({
      url: z.url().refine((url) => url.startsWith('https://'), 'webhook URLs must use https'),
      events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
    })
  )
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).PUT('/v1/webhook', { body: { url: data.url, events: data.events } }))
  })

export const rotatePortalWebhookSecret = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ webhook: ['rotate'] })])
  .validator(organizationInput)
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/webhook/rotate-secret'))
  })

export const deletePortalWebhook = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ webhook: ['update'] })])
  .validator(organizationInput)
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).DELETE('/v1/webhook'))
  })

export const listPortalDeliveries = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(z.object({ status: z.enum(DELIVERY_STATUSES).optional() }))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/webhook/deliveries', { params: { query: { status: data.status, limit: LIST_LIMIT } } })))

export const getPortalDelivery = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(z.object({ deliveryId: z.number().int().positive() }))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/webhook/deliveries/{id}', { params: { path: { id: data.deliveryId } } })))

export const retryPortalDelivery = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ webhook: ['retry'] })])
  .validator(organizationInput.extend({ deliveryId: z.number().int().positive() }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/webhook/deliveries/{id}/retry', { params: { path: { id: data.deliveryId } } }))
  })

// --- API keys -------------------------------------------------------------------------------

export const listPortalApiKeys = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/v1/api-keys')))

export const createPortalApiKey = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ apiKey: ['create'] })])
  .validator(organizationInput.extend({ label: z.string().trim().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/api-keys', { body: { label: data.label } }))
  })

export const revokePortalApiKey = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ apiKey: ['revoke'] })])
  .validator(organizationInput.extend({ apiKeyId: z.uuid() }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).DELETE('/v1/api-keys/{id}', { params: { path: { id: data.apiKeyId } } }))
  })
