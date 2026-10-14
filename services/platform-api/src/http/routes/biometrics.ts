/**
 * Biometric gate routes (Phase 6 B3). Registered only when biometric-service is configured.
 *
 *   wallet token  /v1/wallet/biometric-*   the SDK: requirements by thread id, start/complete a session
 *   console       /v1/biometrics/*         settings, provider configuration (write-only), adoption
 *   customer      /v1/credential-definitions/:id/biometric-policy   per credential definition override
 *                 (reading it: API key or console; setting it: console only, review K1)
 *
 * Provider configuration goes straight to biometric-service and is never stored here; responses
 * carry only its non-secret part.
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { AgentClient } from '../../agent-client.ts'
import { BiometricError, type BiometricClient } from '../../biometric-client.ts'
import type { GateEngine } from '../../biometric/gate.ts'
import { DEFAULT_POLICY, biometricDefaultPolicy, biometricOverride } from '../../biometric/policy.ts'
import type { Database } from '../../db/client.ts'
import { biometricSettings, credentialDefinitionPolicies, wallets } from '../../db/schema.ts'
import { type TenantContext, type WalletContext, requireConsolePrincipal } from '../auth.ts'
import { PlatformError } from '../errors.ts'
import { resolveCredentialDefinition } from './catalogue.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'
import { createRequest, held, toChangeRequestView } from '../../approvals/requests.ts'
import { changeRequests } from '../../db/schema.ts'

const errorBody = z.object({ error: z.string(), reason: z.string() })

/** Session start/complete per wallet: a fixed window, enough for a few honest retries. */
function walletRateLimiter(limit: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>()
  return (walletId: string) => {
    const now = Date.now()
    const w = windows.get(walletId)
    if (!w || now - w.start >= windowMs) {
      windows.set(walletId, { start: now, count: 1 })
      if (windows.size > 10_000) for (const [key, value] of windows) if (now - value.start >= windowMs) windows.delete(key)
      return
    }
    if (++w.count > limit) throw new PlatformError(429, 'rate_limited', 'too many biometric requests for this wallet; retry in a minute')
  }
}

export const walletBiometricRoutes = (deps: { gates: GateEngine }): FastifyPluginAsyncZod => async (app) => {
  const wallet = (request: { wallet?: WalletContext }) => {
    const w = request.wallet as WalletContext
    return { id: w.id, tenantId: w.tenantId }
  }
  const limit = walletRateLimiter(30, 60_000)
  const tags = ['wallet (SDK)']
  const security = [{ walletToken: [] }]

  app.get(
    '/v1/wallet/biometric-requirements',
    {
      schema: {
        tags,
        security,
        summary: 'Biometric checks for exchanges this wallet holds',
        description: 'The SDK asks by DIDComm thread id when an offer or proof request arrives. Threads without a check are omitted.',
        querystring: z.object({ threadId: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(20)]) }),
        response: {
          200: z.object({
            requirements: z.array(z.object({
              threadId: z.string(),
              recordType: z.enum(['credential', 'proof']),
              status: z.string(),
              attemptsRemaining: z.number().int(),
              captureProvider: z.string(),
              expiresAt: z.iso.datetime(),
            })),
          }),
        },
      },
    },
    async (request) => {
      const ids = Array.isArray(request.query.threadId) ? request.query.threadId : [request.query.threadId]
      return { requirements: await deps.gates.requirements(wallet(request), ids) }
    }
  )

  app.post(
    '/v1/wallet/biometric-sessions',
    {
      schema: {
        tags,
        security,
        summary: 'Start a biometric capture session',
        description: 'Uses one attempt. `captureModules` lists the capture add-ons the app includes; `clientConfig` is for that add-on only.',
        body: z.object({
          threadId: z.string().min(1).max(200),
          captureModules: z.array(z.object({ provider: z.string().min(1).max(100), version: z.number().int().min(1) })).max(10),
        }),
        response: {
          201: z.object({ sessionId: z.string(), provider: z.string(), clientConfig: z.unknown(), attempt: z.number().int(), attemptsRemaining: z.number().int() }),
          404: errorBody,
          409: errorBody,
          429: errorBody,
        },
      },
      config: { idempotency: false },
    },
    async (request, reply) => {
      const w = wallet(request)
      limit(w.id)
      return reply.code(201).send(await deps.gates.startSession(w, request.body.threadId, request.body.captureModules))
    }
  )

  app.post(
    '/v1/wallet/biometric-sessions/:id/complete',
    {
      schema: {
        tags,
        security,
        summary: 'Complete a biometric capture session',
        description: 'The platform fetches the result from the vendor itself; `clientOutput` is only what the add-on returned. 409 `result_not_ready` means the vendor is still processing: retry after a second.',
        params: z.object({ id: z.uuid() }),
        body: z.object({ clientOutput: z.unknown() }),
        response: { 200: z.object({ outcome: z.enum(['passed', 'failed', 'locked']), attemptsRemaining: z.number().int() }), 404: errorBody, 409: errorBody, 429: errorBody },
      },
      config: { idempotency: false },
    },
    async (request) => {
      const w = wallet(request)
      limit(w.id)
      return deps.gates.completeSession(w, request.params.id, request.body.clientOutput)
    }
  )
}

const settingsView = z.object({
  enabled: z.boolean(),
  defaultPolicy: biometricDefaultPolicy,
  /** Ours; the tenant puts it into its AWS role's trust policy. */
  externalId: z.string(),
  provider: z
    .object({ id: z.string(), publicConfig: z.record(z.string(), z.unknown()), status: z.enum(['untested', 'ok', 'failed']), lastTestedAt: z.string().nullable(), lastError: z.string().nullable() })
    .nullable(),
})

export const biometricRoutes = (deps: { db: Database; agent: AgentClient; biometric: BiometricClient }): FastifyPluginAsyncZod => async (app) => {
  const consoleTenant = (request: { tenant?: TenantContext }) => requireConsolePrincipal(request.tenant as TenantContext, 'biometric settings are managed from the console')
  const tenant = (request: { tenant?: TenantContext }) => request.tenant as TenantContext
  const tags = ['biometrics', CONSOLE_ONLY_TAG]

  const passThrough = (error: unknown): never => {
    if (error instanceof BiometricError && error.status < 500) throw new PlatformError(error.status === 424 ? 409 : error.status, error.code, error.message)
    throw error
  }

  async function view(tenantId: string) {
    const [settings] = await deps.db.select().from(biometricSettings).where(eq(biometricSettings.tenantId, tenantId))
    const remote = await deps.biometric.getProvider(tenantId).catch(passThrough)
    return {
      enabled: settings?.enabled ?? false,
      defaultPolicy: biometricDefaultPolicy.catch(DEFAULT_POLICY).parse(settings?.defaultPolicy ?? DEFAULT_POLICY),
      externalId: remote.externalId,
      provider: remote.provider
        ? { id: remote.provider.id, publicConfig: remote.provider.publicConfig, status: remote.provider.status, lastTestedAt: remote.provider.lastTestedAt, lastError: remote.provider.lastError }
        : null,
    }
  }

  app.get('/v1/biometrics', { schema: { tags, summary: 'Biometric settings', response: { 200: settingsView } } }, async (request) => view(consoleTenant(request).id))

  app.put(
    '/v1/biometrics/settings',
    {
      config: { approval: 'biometrics.settings' },
      schema: {
        tags,
        summary: 'Switch biometrics on or off and set the default policy',
        description: 'Switching on needs a provider whose connection test passed.',
        body: z.object({ enabled: z.boolean(), defaultPolicy: biometricDefaultPolicy }),
        response: { 200: settingsView, ...held, 409: errorBody },
      },
    },
    async (request) => {
      const t = consoleTenant(request)
      if (request.body.enabled) {
        const remote = await deps.biometric.getProvider(t.id).catch(passThrough)
        if (remote.provider?.status !== 'ok') throw new PlatformError(409, 'provider_not_ready', 'configure a biometric provider and pass its connection test first')
      }
      const values = { enabled: request.body.enabled, defaultPolicy: request.body.defaultPolicy, updatedAt: new Date() }
      await deps.db.insert(biometricSettings).values({ tenantId: t.id, ...values }).onConflictDoUpdate({ target: biometricSettings.tenantId, set: values })
      return view(t.id)
    }
  )

  app.get(
    '/v1/biometrics/providers',
    {
      schema: {
        tags,
        summary: 'Biometric providers offered by this deployment',
        response: { 200: z.object({ providers: z.array(z.object({ id: z.string(), displayName: z.string(), configSchema: z.record(z.string(), z.unknown()), captureModule: z.object({ provider: z.string(), minVersion: z.number().int() }) })) }) },
      },
    },
    async (request) => {
      consoleTenant(request)
      return deps.biometric.providers().catch(passThrough)
    }
  )

  app.put(
    '/v1/biometrics/provider',
    {
      schema: {
        tags,
        summary: 'Configure the biometric provider',
        description: 'Write-only: the configuration is stored encrypted in biometric-service and only its non-secret part is ever returned. A new configuration must pass its connection test before gating resumes, unless it changes only options and keeps the connection (for AWS: same region and role ARN).',
        body: z.object({ providerId: z.string().min(1).max(100), config: z.record(z.string(), z.unknown()) }),
        response: { 200: settingsView, ...held, 400: errorBody },
      },
      // The body may carry vendor secrets: never store it for idempotency replays or in the audit (L10).
      config: { idempotency: false, auditBody: false, approval: 'biometrics.provider.set' },
    },
    async (request, reply) => {
      const t = consoleTenant(request)
      const hold = request.approvalHold
      if (!hold) {
        await deps.biometric.putProvider(t.id, request.body.providerId, request.body.config).catch(passThrough)
        return view(t.id)
      }
      // Held for a second person (implement/22 C17). The configuration must not be stored here, so it
      // waits in biometric-service, encrypted like an active one; the request keeps the provider's
      // name and, once biometric-service has accepted the configuration, its non-secret part.
      const current = await deps.biometric.getProvider(t.id).catch(passThrough)
      const row = await createRequest(deps.db, {
        tenantId: t.id,
        typeId: hold.typeId,
        call: { params: {}, body: { providerId: request.body.providerId } },
        actor: hold.actor,
        replay: { method: 'POST', route: '/v1/biometrics/provider/pending/activate', storeBody: false },
        payload: { providerId: request.body.providerId },
        before: current.provider ? { providerId: current.provider.id, publicConfig: current.provider.publicConfig } : null,
      })
      try {
        const pending = await deps.biometric.putPendingProvider(t.id, request.body.providerId, request.body.config)
        const [stored] = await deps.db.update(changeRequests).set({ payload: { providerId: pending.providerId, publicConfig: pending.publicConfig } }).where(eq(changeRequests.id, row.id)).returning()
        request.heldChange = row.id
        return reply.code(202).send({ approval: toChangeRequestView(stored ?? row) })
      } catch (error) {
        // The configuration was refused: there is nothing to approve.
        await deps.db.delete(changeRequests).where(eq(changeRequests.id, row.id))
        return passThrough(error)
      }
    }
  )

  // Only the approval of the request above reaches this: it makes the waiting configuration the
  // active one. Called directly it is refused, whether or not the tenant requires approval.
  app.post(
    '/v1/biometrics/provider/pending/activate',
    {
      config: { idempotency: false, approval: 'biometrics.provider.set' },
      schema: { tags, summary: 'Activate the provider configuration that waited for approval', description: 'Made by platform-api itself when the change request is approved; any other caller is refused.', response: { 200: settingsView, 403: errorBody, 404: errorBody } },
    },
    async (request) => {
      const t = consoleTenant(request)
      if (!request.approvedChange) throw new PlatformError(403, 'forbidden', 'a provider that waits for approval becomes active when its request is approved')
      await deps.biometric.activatePendingProvider(t.id).catch(passThrough)
      return view(t.id)
    }
  )

  app.delete('/v1/biometrics/provider', { config: { approval: 'biometrics.provider.remove' }, schema: { tags, summary: 'Remove the biometric provider', description: 'Also switches biometrics off.', response: { 200: settingsView, ...held } } }, async (request) => {
    const t = consoleTenant(request)
    await deps.db.update(biometricSettings).set({ enabled: false, updatedAt: new Date() }).where(eq(biometricSettings.tenantId, t.id))
    await deps.biometric.deleteProvider(t.id).catch(passThrough)
    return view(t.id)
  })

  app.post(
    '/v1/biometrics/provider/test',
    { schema: { tags, summary: 'Test the biometric provider connection', response: { 200: z.object({ status: z.enum(['untested', 'ok', 'failed']), error: z.string().nullable() }), 409: errorBody } } },
    async (request) => deps.biometric.testProvider(consoleTenant(request).id).catch(passThrough)
  )

  app.get(
    '/v1/biometrics/adoption',
    {
      schema: {
        tags,
        summary: 'Capture add-ons reported by this tenant\'s wallets',
        description: 'How many active wallets reported each capture add-on. Check it before switching provider: an app without the new add-on cannot pass the check.',
        response: { 200: z.object({ walletsReporting: z.number().int(), modules: z.array(z.object({ module: z.string(), wallets: z.number().int() })) }) },
      },
    },
    async (request) => {
      const t = consoleTenant(request)
      const active = and(eq(wallets.tenantId, t.id), isNull(wallets.revokedAt), isNotNull(wallets.captureModules))
      const rows = await deps.db
        .select({ module: sql<string>`m.module`, wallets: sql<number>`count(*)::int` })
        .from(sql`${wallets}, unnest(${wallets.captureModules}) as m(module)`)
        .where(active)
        .groupBy(sql`m.module`)
      const [total] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(wallets).where(active)
      return { walletsReporting: total?.n ?? 0, modules: rows }
    }
  )

  // --- per credential definition (read: API key or console; write: console only) -----
  const policyView = z.object({ credentialDefinitionId: z.string(), biometricPolicy: biometricOverride })

  app.get(
    '/v1/credential-definitions/:id/biometric-policy',
    { schema: { tags: ['catalogue'], summary: 'Biometric policy of a credential definition', params: z.object({ id: z.string().min(1).max(300) }), response: { 200: policyView, 404: errorBody } } },
    async (request) => {
      const t = tenant(request)
      const credDef = await resolveCredentialDefinition(deps.agent, t, request.params.id)
      const [row] = await deps.db.select().from(credentialDefinitionPolicies).where(and(eq(credentialDefinitionPolicies.tenantId, t.id), eq(credentialDefinitionPolicies.credentialDefinitionId, credDef.id)))
      return { credentialDefinitionId: credDef.id, biometricPolicy: row ? biometricOverride.parse(row.biometricPolicy) : { mode: 'inherit' as const } }
    }
  )

  app.put(
    '/v1/credential-definitions/:id/biometric-policy',
    {
      config: { approval: 'biometrics.cred_def_policy' },
      schema: {
        tags: ['catalogue', CONSOLE_ONLY_TAG],
        summary: 'Set the biometric policy of a credential definition',
        description: '`inherit` follows the tenant default, `off` never gates, `required` gates with the given thresholds (missing values come from the tenant default). Applies to offers made after the change.',
        params: z.object({ id: z.string().min(1).max(300) }),
        body: biometricOverride,
        response: { 200: policyView, ...held, 404: errorBody },
      },
    },
    async (request) => {
      const t = consoleTenant(request)
      const credDef = await resolveCredentialDefinition(deps.agent, t, request.params.id)
      const values = { biometricPolicy: request.body as Record<string, unknown>, updatedAt: new Date() }
      await deps.db
        .insert(credentialDefinitionPolicies)
        .values({ tenantId: t.id, credentialDefinitionId: credDef.id, ...values })
        .onConflictDoUpdate({ target: [credentialDefinitionPolicies.tenantId, credentialDefinitionPolicies.credentialDefinitionId], set: values })
      return { credentialDefinitionId: credDef.id, biometricPolicy: request.body }
    }
  )
}

