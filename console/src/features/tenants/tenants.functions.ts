/** Operator views of and actions on tenants (Phase 4 stage 4a). Every function is operator-only. */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { apiKeyQueryParams } from '@/features/tenant-data/list.params'
import { apiKeySearch } from '@/features/tenant-data/list.schemas'
import { createApiKeyInput, createTenantInput, rateLimitInput, tenantInput, tenantListSearch } from '@/features/tenants/tenants.schemas'
import { pageParams } from '@/lib/list-search'
import { operatorMiddleware } from '@/server/middleware'
import { notifyOwnersOfOperatorKey } from '@/server/data-protection.server'
import { platformFor, unwrap } from '@/server/platform.server'

/** One page of tenants with their activity, newest first (Phase 4 C9). */
export const getTenantOverview = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantListSearch)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/admin/overview', { params: { query: { ...pageParams(data), status: data.status } } })))

export const getTenant = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).GET('/admin/tenants/{id}', { params: { path: { id: data.tenantId } } })))

/** Creates the platform tenant and onboards it on the ledger (platform-api runs onboarding inline). */
export const createTenant = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(createTenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).POST('/admin/tenants', { body: { name: data.name } })))

export const retryOnboarding = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal).POST('/admin/tenants/{id}/onboard', { params: { path: { id: data.tenantId } } })))

/** Operator override of the tenant's per-API-key request limit (review M4); null restores the platform default. */
export const setTenantRateLimit = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(rateLimitInput.shape))
  .handler(async ({ context, data }) =>
    unwrap(
      await platformFor(context.principal).PATCH('/admin/tenants/{id}', {
        params: { path: { id: data.tenantId } },
        body: { rateLimitPerMin: data.useDefault ? null : data.rateLimitPerMin },
      })
    )
  )

// API keys go through the console-only /v1/api-keys route, the same path the tenant portal uses,
// so every key action is audited with its tenant.
export const listApiKeys = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(apiKeySearch.shape))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/api-keys', { params: { query: apiKeyQueryParams(data) } })))

export const createApiKey = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(createApiKeyInput.shape))
  .handler(async ({ context, data }) => {
    const created = unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).POST('/v1/api-keys', { body: { label: data.label } }))
    // The tenant's owners hear about every key an operator creates (Phase 7 H1).
    await notifyOwnersOfOperatorKey({ tenantId: data.tenantId, label: data.label, operatorUserId: context.principal.actor })
    return created
  })

export const revokeApiKey = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ apiKeyId: z.uuid() }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).DELETE('/v1/api-keys/{id}', { params: { path: { id: data.apiKeyId } } }))
  )
