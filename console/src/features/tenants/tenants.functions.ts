/** Operator views of and actions on tenants (Phase 4 stage 4a). Every function is operator-only. */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { createApiKeyInput, createTenantInput, rateLimitInput, tenantInput } from '@/features/tenants/tenants.schemas'
import { operatorMiddleware } from '@/server/middleware'
import { platformFor, unwrap } from '@/server/platform.server'

export const getTenantOverview = createServerFn({ method: 'GET' })
  .middleware([operatorMiddleware])
  .handler(async ({ context }) => unwrap(await platformFor(context.principal).GET('/admin/overview')))

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
  .validator(tenantInput)
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).GET('/v1/api-keys')))

export const createApiKey = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend(createApiKeyInput.shape))
  .handler(async ({ context, data }) => unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).POST('/v1/api-keys', { body: { label: data.label } })))

export const revokeApiKey = createServerFn({ method: 'POST' })
  .middleware([operatorMiddleware])
  .validator(tenantInput.extend({ apiKeyId: z.uuid() }))
  .handler(async ({ context, data }) =>
    unwrap(await platformFor(context.principal, { tenantId: data.tenantId }).DELETE('/v1/api-keys/{id}', { params: { path: { id: data.apiKeyId } } }))
  )
