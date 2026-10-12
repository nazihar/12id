/**
 * platform-api HTTP surface (P2, Phase 4 C1). Scopes by credential:
 *   public        /v1/ledger, /v1/health, /openapi.json
 *   API key       /v1/* customer resources (+ Idempotency-Key on POST/PUT): exchanges, wallets, reads
 *   console       the same /v1/* routes with console headers, plus the console-only ones: API keys,
 *                 stats, biometric settings, and every setup write (catalogue publishing, proof
 *                 templates, biometric policies, webhook endpoint/secret/retry; review K1)
 *   wallet token  /v1/wallet/*
 *   operator      /admin/* (console token + operator role, or the break-glass admin token)
 *   console only  POST /admin/audit/events (the console token alone: events it reports about itself)
 *   none          /internal/mediator/:secret, /healthz, /readyz (never proxied by the edge)
 *   monitoring    POST /internal/alerts (Alertmanager's webhook, its own bearer secret; never proxied)
 *
 * Response schemas are enforced by the serializer, so a handler cannot leak fields that are not
 * in its schema (same rule as agent-service). Console and break-glass calls are audited (audit.ts).
 */
import swagger from '@fastify/swagger'
import Fastify from 'fastify'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import type { Logger as PinoLogger } from 'pino'

import type { AgentClient } from '../agent-client.ts'
import type { BiometricClient } from '../biometric-client.ts'
import type { GateEngine } from '../biometric/gate.ts'
import type { PlatformConfig } from '../config.ts'
import type { Database } from '../db/client.ts'
import type { MediatorClient } from '../mediator-client.ts'
import type { WakeOutcome } from '../wake.ts'
import { endpointLookup } from '../webhooks/events.ts'
import { consoleAuditHook } from './audit.ts'
import { CONSOLE_TOKEN_HEADER, requireOperator, requireTenantPrincipal, requireWalletToken } from './auth.ts'
import { platformErrorHandler } from './errors.ts'
import { useIdempotency } from './idempotency.ts'
import { rateLimiter } from './rate-limit.ts'
import { activityRoutes } from './routes/activity.ts'
import { adminRoutes } from './routes/admin.ts'
import { auditEventRoutes } from './routes/audit-events.ts'
import { biometricRoutes, walletBiometricRoutes } from './routes/biometrics.ts'
import { catalogueRoutes } from './routes/catalogue.ts'
import { dataProtectionRoutes } from './routes/data-protection.ts'
import { CONSOLE_ONLY_TAG, consoleRoutes } from './routes/console.ts'
import { exchangeRoutes } from './routes/exchanges.ts'
import { healthRoutes } from './routes/health.ts'
import { internalRoutes } from './routes/internal.ts'
import { proofTemplateRoutes } from './routes/proof-templates.ts'
import { publicRoutes } from './routes/public.ts'
import { platformStatsRoutes, tenantStatsRoutes } from './routes/stats.ts'
import { verificationRoutes } from './routes/verification.ts'
import { walletCustomerRoutes, walletDeviceRoutes } from './routes/wallets.ts'
import { webhookRoutes } from './routes/webhook.ts'

export interface ReadinessReport {
  ready: boolean
  draining: boolean
  checks: Record<string, boolean>
}

export interface AppDeps {
  config: PlatformConfig
  db: Database
  agent: AgentClient
  mediator: Pick<MediatorClient, 'createInvitation'>
  logger: PinoLogger
  readiness: () => Promise<ReadinessReport>
  wake: (connectionId: string) => Promise<WakeOutcome>
  /** Phase 6: both present when biometric-service is configured. */
  biometric?: { client: BiometricClient; gates: GateEngine }
}

export interface BuildOptions {
  /** Which OpenAPI document the app describes: `customer` (served, default) leaves out console-only routes. */
  spec?: 'customer' | 'console'
}

export function buildApp(deps: AppDeps, options: BuildOptions = {}) {
  const consoleSpec = options.spec === 'console'
  const app = Fastify({
    loggerInstance: deps.logger.child({ component: 'http' }),
    bodyLimit: 1_048_576,
    trustProxy: true,
    // Keep request ids short and stable for support; the edge does not add one.
    genReqId: () => Math.random().toString(36).slice(2, 12),
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler(platformErrorHandler)
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found', reason: 'no such route' }))
  // Registered before the route plugins so every scope inherits it.
  app.addHook('onResponse', consoleAuditHook(deps.db))

  app.register(swagger, {
    // The default hidden tag is never used, so the console document shows every route.
    hiddenTag: consoleSpec ? 'X-HIDDEN' : CONSOLE_ONLY_TAG,
    openapi: {
      openapi: '3.1.0',
      info: {
        title: consoleSpec ? '12id Platform API (console)' : '12id Platform API',
        version: '1.0.0',
        description: consoleSpec
          ? 'Every route, including the console-only and operator routes the 12id console calls from its server over the private network. Not a customer document.'
          : 'Issue and verify AnonCreds credentials with holders running the 12id SDK. Commands are asynchronous: they return the exchange record immediately and progress arrives through signed webhooks (or polling). Ids are stable per tenant.',
      },
      servers: [{ url: deps.config.PUBLIC_URL }],
      tags: [
        { name: 'ledger', description: 'Public configuration' },
        { name: 'catalogue', description: 'Schemas and credential definitions' },
        { name: 'connections' },
        { name: 'credentials' },
        { name: 'proofs' },
        { name: 'wallets', description: 'Wallets (customer backend)' },
        { name: 'wallet (SDK)', description: 'Wallet endpoints called by the app with its wallet token' },
        { name: 'webhooks' },
        { name: 'data protection', description: 'Retention period and erasure log' },
        ...(deps.biometric ? [{ name: 'biometrics', description: 'Biometric gate settings (console)' }] : []),
        ...(consoleSpec
          ? [
              { name: 'stats', description: 'Dashboard aggregates, served to the console only' },
              { name: 'api-keys', description: 'API keys, managed from the console only' },
              { name: 'admin', description: 'Operator routes; not reachable from the internet' },
              { name: CONSOLE_ONLY_TAG, description: 'Left out of the customer document' },
            ]
          : []),
      ],
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer', description: 'API key `12id_sk_…` issued per tenant' },
          walletToken: { type: 'http', scheme: 'bearer', description: 'Wallet token `12id_wt_…` returned by POST /v1/wallets' },
          ...(consoleSpec
            ? { consoleToken: { type: 'apiKey' as const, in: 'header', name: CONSOLE_TOKEN_HEADER, description: 'Console token, with x-console-actor, x-console-role and (tenant routes) x-console-tenant' } }
            : {}),
        },
      },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  })

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  app.register(publicRoutes({ config: deps.config, readiness: deps.readiness }))
  app.register(internalRoutes({ webhookSecret: deps.config.MEDIATOR_WEBHOOK_SECRET, wake: deps.wake, readiness: deps.readiness, alerts: { db: deps.db, secret: deps.config.ALERT_WEBHOOK_SECRET } }))

  // Per-principal limits (review M4), one in-process store for the whole app.
  const limits = rateLimiter({ apiKeyPerMin: deps.config.RATE_LIMIT_API_KEY_PER_MIN, walletPerMin: deps.config.RATE_LIMIT_WALLET_PER_MIN, invitationsPer10Min: deps.config.RATE_LIMIT_INVITATION_PER_10MIN })

  // Customer scope: API key or console, then the per-key limit, then idempotency on mutations.
  app.register(async (scope) => {
    scope.addHook('onRequest', requireTenantPrincipal(deps.db, deps.config.CONSOLE_TOKEN))
    scope.addHook('onRequest', limits.tenant)
    useIdempotency(scope, deps.db)
    await scope.register(catalogueRoutes({ agent: deps.agent }))
    const erasure = { db: deps.db, agent: deps.agent, biometric: deps.biometric?.client, endpoints: endpointLookup(deps.db), logger: deps.logger }
    await scope.register(exchangeRoutes({ db: deps.db, agent: deps.agent, biometric: deps.biometric?.client, gates: deps.biometric?.gates, erasure }))
    await scope.register(dataProtectionRoutes({ db: deps.db, defaultRetentionDays: deps.config.RETENTION_DAYS, defaultAuditRetentionDays: deps.config.AUDIT_RETENTION_DAYS }))
    if (deps.biometric) await scope.register(biometricRoutes({ db: deps.db, agent: deps.agent, biometric: deps.biometric.client }))
    await scope.register(proofTemplateRoutes({ db: deps.db }))
    await scope.register(walletCustomerRoutes({ db: deps.db }))
    await scope.register(webhookRoutes({ db: deps.db }))
    await scope.register(consoleRoutes({ db: deps.db }))
    await scope.register(tenantStatsRoutes({ db: deps.db }))
    await scope.register(verificationRoutes({ db: deps.db }))
    await scope.register(activityRoutes({ db: deps.db }))
  })

  // SDK scope: wallet token.
  app.register(async (scope) => {
    scope.addHook('onRequest', requireWalletToken(deps.db))
    scope.addHook('onRequest', limits.wallet)
    await scope.register(walletDeviceRoutes({ db: deps.db, mediator: deps.mediator, invitationLimit: limits.invitation }))
    if (deps.biometric) await scope.register(walletBiometricRoutes({ gates: deps.biometric.gates }))
  })

  // Operator scope.
  app.register(adminRoutes({ db: deps.db, agent: deps.agent, adminToken: deps.config.PLATFORM_ADMIN_TOKEN, consoleToken: deps.config.CONSOLE_TOKEN }))
  app.register(async (scope) => {
    scope.addHook('onRequest', requireOperator(deps.config.PLATFORM_ADMIN_TOKEN, deps.config.CONSOLE_TOKEN))
    await scope.register(platformStatsRoutes({ db: deps.db, readiness: deps.readiness }))
    await scope.register(healthRoutes({ db: deps.db, config: deps.config, readiness: deps.readiness }))
  })
  // What the console reports about itself (sign-ins, account changes, exports): console token only.
  app.register(auditEventRoutes({ db: deps.db, consoleToken: deps.config.CONSOLE_TOKEN }))

  return app
}

export type PlatformApp = ReturnType<typeof buildApp>
