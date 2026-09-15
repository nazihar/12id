/**
 * Operator reads of one tenant's data (Phase 4 stage 4a), through the console scope with the tenant
 * named per call. Read-only, except retrying a webhook delivery.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { operatorMiddleware } from '@/server/middleware'
import { PlatformCallError, platformFor, unwrap } from '@/server/platform.server'

import { DELIVERY_STATUSES } from './types'

export { DELIVERY_STATUSES }

const tenantInput = z.object({ tenantId: z.uuid() })
const LIST_LIMIT = 200

export const getCatalogue = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => {
    const platform = platformFor(context.principal, { tenantId: data.tenantId })
    const [schemas, credentialDefinitions] = await Promise.all([platform.GET('/v1/schemas'), platform.GET('/v1/credential-definitions')])
    return { schemas: unwrap(schemas), credentialDefinitions: unwrap(credentialDefinitions) }
  })

export const listProofTemplates = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/proof-templates')))

export const listConnections = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/connections', { params: { query: { limit: LIST_LIMIT } } })))

export const listCredentials = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/credentials', { params: { query: { limit: LIST_LIMIT } } })))

export const listProofs = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/proofs', { params: { query: { limit: LIST_LIMIT } } })))

export const listWallets = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/wallets', { params: { query: { limit: LIST_LIMIT } } })))

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
  .validator(tenantInput.extend({ status: z.enum(DELIVERY_STATUSES).optional() }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/webhook/deliveries', { params: { query: { status: data.status, limit: LIST_LIMIT } } }))
  )

/** Includes the signed body, which carries credential attributes; platform-api audits the read. */
export const getWebhookDelivery = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ deliveryId: z.number().int().positive() }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/webhook/deliveries/{id}', { params: { path: { id: data.deliveryId } } }))
  )

export const retryWebhookDelivery = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ deliveryId: z.number().int().positive() }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).POST('/v1/webhook/deliveries/{id}/retry', { params: { path: { id: data.deliveryId } } }))
  )
