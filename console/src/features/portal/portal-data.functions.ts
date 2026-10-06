/**
 * Tenant portal data (stage 4b), through the console scope for the tenant the member's active
 * organization maps to. Reads need membership; changes need the role's permission and name the
 * organization the page was showing.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { biometricOverride, biometricProviderInput, biometricSettingsInput } from '@/features/portal/biometrics.schemas'
import { publishSchemaInput } from '@/features/portal/catalogue.schemas'
import { connectionInvitationInput } from '@/features/portal/exchanges.schemas'
import { webhookEndpointInput } from '@/features/portal/webhook.schemas'
import { apiKeyQueryParams, catalogueQueryParams, deliveryQueryParams, exchangeQueryParams, walletQueryParams } from '@/features/tenant-data/list.params'
import { apiKeySearch, catalogueSearch, deliverySearch, exchangeSearch, templateSearch, walletSearch } from '@/features/tenant-data/list.schemas'
import { allPages, pageParams } from '@/lib/list-search'
import { apiKeyLabel } from '@/features/tenants/tenants.schemas'
import { EXPIRY_ATTRIBUTE, templateDefinitionInput } from '@/lib/template-schema'
import { tenantMiddleware } from '@/server/middleware'
import { PlatformCallError, platformFor, unwrap } from '@/server/platform.server'

import { assertSameOrganization, organizationInput } from './organization-input'

// --- catalogue ------------------------------------------------------------------------------

/**
 * The whole catalogue, for the template builder's pickers and the Overview counts: platform-api
 * pages it, so every page of 100 is read (a tenant's catalogue is small; each item is a ledger write).
 */
export const getPortalCatalogue = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => {
    const platform = platformFor(context.principal)
    const [schemas, credentialDefinitions] = await Promise.all([
      allPages(async (page) => unwrap(await platform.GET('/v1/schemas', { params: { query: { page, pageSize: 100 } } }))),
      allPages(async (page) => unwrap(await platform.GET('/v1/credential-definitions', { params: { query: { page, pageSize: 100 } } }))),
    ])
    return { schemas, credentialDefinitions }
  })

/** One page of schemas or of credential definitions (`tab`), for the Catalogue page (Phase 4 C9). */
export const listPortalCatalogue = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(catalogueSearch)
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal)
    const query = catalogueQueryParams(data)
    if (data.tab === 'definitions') return { tab: 'definitions' as const, page: unwrap(await platform.GET('/v1/credential-definitions', { params: { query } })) }
    const [page, definitions] = await Promise.all([
      platform.GET('/v1/schemas', { params: { query } }).then(unwrap),
      // Which of this page's schemas already have a credential definition (one per schema).
      allPages(async (n) => unwrap(await platform.GET('/v1/credential-definitions', { params: { query: { page: n, pageSize: 100 } } }))),
    ])
    const onPage = new Set(page.items.map((schema) => schema.id))
    return { tab: 'schemas' as const, page, withDefinition: [...new Set(definitions.map((d) => d.schemaId).filter((id): id is string => id !== null && onPage.has(id)))] }
  })

/** Publishes a schema on the ledger. `expiresOn` is always included: v1 credentials expire instead of being revoked. */
export const publishSchema = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ catalogue: ['publish'] })])
  .validator(organizationInput.extend(publishSchemaInput.shape))
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
  .validator(templateSearch)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/proof-templates', { params: { query: pageParams(data) } })))

export const getPortalTemplate = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(z.object({ templateId: z.uuid() }))
  .handler(async ({ context, data }) => {
    try {
      return unwrap(await platformFor(context.principal).GET('/v1/proof-templates/{id}', { params: { path: { id: data.templateId } } }))
    } catch (error) {
      if (error instanceof PlatformCallError && error.status === 404) return null
      throw error
    }
  })

export const createPortalTemplate = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ template: ['create'] })])
  .validator(organizationInput.extend({ definition: templateDefinitionInput }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/proof-templates', { body: data.definition }))
  })

export const updatePortalTemplate = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ template: ['update'] })])
  .validator(organizationInput.extend({ templateId: z.uuid(), definition: templateDefinitionInput }))
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

/** One page of the exchange kind the search's tab names (connections by default). */
export const listPortalExchanges = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(exchangeSearch)
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal)
    const query = exchangeQueryParams(data)
    if (data.tab === 'credentials') return { tab: 'credentials' as const, page: unwrap(await platform.GET('/v1/credentials', { params: { query } })) }
    if (data.tab === 'proofs') return { tab: 'proofs' as const, page: unwrap(await platform.GET('/v1/proofs', { params: { query } })) }
    return { tab: 'connections' as const, page: unwrap(await platform.GET('/v1/connections', { params: { query } })) }
  })

export const listPortalWallets = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(walletSearch)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/wallets', { params: { query: walletQueryParams(data) } })))

/** A connection invitation for testing with a holder app (the customer backend normally creates these). */
export const createPortalInvitation = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ exchange: ['create'] })])
  .validator(organizationInput.extend(connectionInvitationInput.shape))
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
  .validator(organizationInput.extend(webhookEndpointInput.shape))
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
  .validator(deliverySearch)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/webhook/deliveries', { params: { query: deliveryQueryParams(data) } })))

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
  .validator(apiKeySearch)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/api-keys', { params: { query: apiKeyQueryParams(data) } })))

export const createPortalApiKey = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ apiKey: ['create'] })])
  .validator(organizationInput.extend({ label: apiKeyLabel }))
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

// --- biometric gate (Phase 6) -------------------------------------------------------------

/** One exchange's biometric log; any member may read it, and platform-api audits every read. */
export const getPortalBiometricLog = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(z.object({ kind: z.enum(['credential', 'proof']), id: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal)
    const params = { params: { path: { id: data.id } } }
    return unwrap(data.kind === 'credential' ? await platform.GET('/v1/credentials/{id}/biometric-log', params) : await platform.GET('/v1/proofs/{id}/biometric-log', params))
  })

export const getPortalBiometrics = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => {
    const platform = platformFor(context.principal)
    const [settings, providers] = await Promise.all([platform.GET('/v1/biometrics'), platform.GET('/v1/biometrics/providers')])
    return { settings: serializableSettings(unwrap(settings)), providers: unwrap(providers).providers.map(providerForm) }
  })

type RawSettings = { enabled: boolean; defaultPolicy: { required: boolean; minMatchScore: number; minLivenessScore: number; maxAttempts: number; ttlMinutes: number }; externalId: string; provider: { id: string; publicConfig: Record<string, unknown>; status: 'ok' | 'failed' | 'untested'; lastTestedAt: string | null; lastError: string | null } | null }

/** publicConfig values are strings in practice (region, role ARN); flatten so they cross the server boundary. */
function serializableSettings(settings: RawSettings) {
  return {
    ...settings,
    provider: settings.provider ? { ...settings.provider, publicConfig: Object.fromEntries(Object.entries(settings.provider.publicConfig).map(([k, v]) => [k, String(v)])) } : null,
  }
}

/** The provider's JSON Schema reduced to the string fields the form renders (enum → select). */
function providerForm(entry: { id: string; displayName: string; configSchema: Record<string, unknown>; captureModule: { provider: string; minVersion: number } }) {
  const properties = (entry.configSchema.properties ?? {}) as Record<string, { enum?: unknown[]; pattern?: string; description?: string }>
  return {
    id: entry.id,
    displayName: entry.displayName,
    captureProvider: entry.captureModule.provider,
    fields: Object.entries(properties).map(([key, property]) => ({
      key,
      options: Array.isArray(property.enum) ? property.enum.map(String) : null,
      pattern: property.pattern ?? null,
    })),
  }
}

export const savePortalBiometricProvider = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ biometrics: ['update'] })])
  .validator(organizationInput.extend(biometricProviderInput.shape))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    // Write-only: platform-api stores nothing; biometric-service keeps the config encrypted.
    return serializableSettings(unwrap(await platformFor(context.principal).PUT('/v1/biometrics/provider', { body: { providerId: data.providerId, config: data.config } })))
  })

export const testPortalBiometricProvider = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ biometrics: ['update'] })])
  .validator(organizationInput)
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).POST('/v1/biometrics/provider/test'))
  })

export const removePortalBiometricProvider = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ biometrics: ['update'] })])
  .validator(organizationInput)
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return serializableSettings(unwrap(await platformFor(context.principal).DELETE('/v1/biometrics/provider')))
  })

export const savePortalBiometricSettings = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ biometrics: ['update'] })])
  .validator(organizationInput.extend(biometricSettingsInput.shape))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return serializableSettings(unwrap(await platformFor(context.principal).PUT('/v1/biometrics/settings', { body: { enabled: data.enabled, defaultPolicy: data.defaultPolicy } })))
  })

export const getPortalBiometricAdoption = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/v1/biometrics/adoption')))

export const getPortalCredentialDefinitionPolicy = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(z.object({ credentialDefinitionId: z.string().min(1).max(300) }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal).GET('/v1/credential-definitions/{id}/biometric-policy', { params: { path: { id: data.credentialDefinitionId } } }))
  )

export const savePortalCredentialDefinitionPolicy = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ biometrics: ['update'] })])
  .validator(organizationInput.extend({ credentialDefinitionId: z.string().min(1).max(300), policy: biometricOverride }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(
      await platformFor(context.principal).PUT('/v1/credential-definitions/{id}/biometric-policy', { params: { path: { id: data.credentialDefinitionId } }, body: data.policy })
    )
  })

export const getPortalTemplatePolicy = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(z.object({ templateId: z.uuid() }))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/proof-templates/{id}/biometric-policy', { params: { path: { id: data.templateId } } })))

export const savePortalTemplatePolicy = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ biometrics: ['update'] })])
  .validator(organizationInput.extend({ templateId: z.uuid(), policy: biometricOverride }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).PUT('/v1/proof-templates/{id}/biometric-policy', { params: { path: { id: data.templateId } }, body: data.policy }))
  })

// --- data protection (Phase 7 H1) -----------------------------------------------------------

/** Erases the personal data of one exchange or connection (owners and admins). The reason is optional. */
export const erasePortalRecord = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ exchange: ['erase'] })])
  .validator(organizationInput.extend({ kind: z.enum(['connection', 'credential', 'proof']), id: z.string().min(1).max(100), reason: z.string().trim().max(500).optional() }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    const platform = platformFor(context.principal)
    const options = { params: { path: { id: data.id } }, body: { reason: data.reason || undefined } }
    if (data.kind === 'connection') return unwrap(await platform.POST('/v1/connections/{id}/erase', options)).id
    if (data.kind === 'credential') return unwrap(await platform.POST('/v1/credentials/{id}/erase', options)).id
    return unwrap(await platform.POST('/v1/proofs/{id}/erase', options)).id
  })

export const getPortalRetention = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/v1/data-retention')))

export const setPortalRetention = createServerFn({ method: 'POST' })
  .middleware([tenantMiddleware({ retention: ['update'] })])
  .validator(organizationInput.extend({ retentionDays: z.number().int().min(0).max(3650).nullable() }))
  .handler(async ({ context, data }) => {
    assertSameOrganization(context.organization.id, data.organizationId)
    return unwrap(await platformFor(context.principal).PUT('/v1/data-retention', { body: { retentionDays: data.retentionDays } }))
  })

export const listPortalErasures = createServerFn({ method: 'GET' })
  .middleware([tenantMiddleware()])
  .validator(z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25) }))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/v1/erasures', { params: { query: { page: data.page, pageSize: data.pageSize } } })))
