/**
 * Operator reads of one tenant's data (Phase 4 stage 4a), through the console scope with the tenant
 * named per call. Read-only, except retrying a webhook delivery, erasing personal data on the tenant's
 * request and setting its retention period (Phase 7 H1). Personal data comes back masked unless the
 * operator gives a reason to reveal it; platform-api audits both with the reason.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { operatorMiddleware } from '@/server/middleware'
import { pageParams } from '@/lib/list-search'
import { PlatformCallError, platformFor, unwrap } from '@/server/platform.server'

import { catalogueSearch, exchangeSearch, templateSearch, walletSearch, deliverySearch } from './list.schemas'
import { catalogueQueryParams, deliveryQueryParams, exchangeQueryParams, walletQueryParams } from './list.params'
import { DELIVERY_STATUSES } from './types'

export { DELIVERY_STATUSES }

const tenantInput = z.object({ tenantId: z.uuid() })
/** Operators give a reason to erase or reveal a tenant's personal data (Phase 7 H1). */
const operatorReason = z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500)

/** One page of schemas or of credential definitions (`tab`), newest first. */
export const listCatalogue = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(catalogueSearch.shape))
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal, { tenantId: data.tenantId })
    const query = catalogueQueryParams(data)
    return data.tab === 'definitions'
      ? { tab: 'definitions' as const, page: unwrap(await platform.GET('/v1/credential-definitions', { params: { query } })) }
      : { tab: 'schemas' as const, page: unwrap(await platform.GET('/v1/schemas', { params: { query } })) }
  })

export const listProofTemplates = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(templateSearch.shape))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/proof-templates', { params: { query: pageParams(data) } })))

/** One page of the exchange kind the search's tab names (connections by default). */
export const listExchanges = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(exchangeSearch.shape))
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal, { tenantId: data.tenantId })
    const query = exchangeQueryParams(data)
    if (data.tab === 'credentials') return { tab: 'credentials' as const, page: unwrap(await platform.GET('/v1/credentials', { params: { query } })) }
    if (data.tab === 'proofs') return { tab: 'proofs' as const, page: unwrap(await platform.GET('/v1/proofs', { params: { query } })) }
    return { tab: 'connections' as const, page: unwrap(await platform.GET('/v1/connections', { params: { query } })) }
  })

export const listWallets = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(walletSearch.shape))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/wallets', { params: { query: walletQueryParams(data) } })))

/** The tenant's webhook endpoint, or null when none is configured. The signing secret is never returned. */
export const getWebhookEndpoint = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => {
    try {
      return unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/webhook'))
    } catch (error) {
      if (error instanceof PlatformCallError && error.status === 404) return null
      throw error
    }
  })

export const listWebhookDeliveries = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(deliverySearch.shape))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/webhook/deliveries', { params: { query: deliveryQueryParams(data) } })))

/** Includes the signed body, which carries credential attributes; platform-api audits the read. */
export const getWebhookDelivery = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ deliveryId: z.number().int().positive(), revealReason: operatorReason.optional() }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal, { tenantId: data.tenantId, revealReason: data.revealReason }).GET('/v1/webhook/deliveries/{id}', { params: { path: { id: data.deliveryId } } }))
  )

export const retryWebhookDelivery = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ deliveryId: z.number().int().positive() }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).POST('/v1/webhook/deliveries/{id}/retry', { params: { path: { id: data.deliveryId } } }))
  )

/** Phase 6: one exchange's biometric log. platform-api audits the read (auditRead). */
export const getBiometricLog = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ kind: z.enum(['credential', 'proof']), id: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal, { tenantId: data.tenantId })
    const params = { params: { path: { id: data.id } } }
    return unwrap(data.kind === 'credential' ? await platform.GET('/v1/credentials/{id}/biometric-log', params) : await platform.GET('/v1/proofs/{id}/biometric-log', params))
  })

/** Phase 6: the tenant's biometric settings, read-only for operators (tenants configure their own vendor). */
export const getTenantBiometrics = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal, { tenantId: data.tenantId })
    const [settings, adoption] = await Promise.all([platform.GET('/v1/biometrics'), platform.GET('/v1/biometrics/adoption')])
    const s = unwrap(settings)
    return {
      settings: { ...s, provider: s.provider ? { ...s.provider, publicConfig: Object.fromEntries(Object.entries(s.provider.publicConfig).map(([k, v]) => [k, String(v)])) } : null },
      adoption: unwrap(adoption),
    }
  })

// --- data protection (Phase 7 H1) -------------------------------------------------------------

/** Erases the personal data of one exchange or connection, on the tenant's request. The reason is required. */
export const eraseTenantRecord = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ kind: z.enum(['connection', 'credential', 'proof']), id: z.string().min(1).max(100), reason: operatorReason }))
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal, { tenantId: data.tenantId })
    const options = { params: { path: { id: data.id } }, body: { reason: data.reason } }
    if (data.kind === 'connection') return unwrap(await platform.POST('/v1/connections/{id}/erase', options)).id
    if (data.kind === 'credential') return unwrap(await platform.POST('/v1/credentials/{id}/erase', options)).id
    return unwrap(await platform.POST('/v1/proofs/{id}/erase', options)).id
  })

export const getTenantRetention = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/data-retention')))

export const setTenantRetention = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ retentionDays: z.number().int().min(0).max(3650).nullable() }))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).PUT('/v1/data-retention', { body: { retentionDays: data.retentionDays } })))

export const listTenantErasures = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25) }))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/erasures', { params: { query: { page: data.page, pageSize: data.pageSize } } })))
