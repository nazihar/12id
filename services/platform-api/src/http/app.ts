/**
 * platform-api HTTP surface (P2). Scopes by credential:
 *   public        /v1/ledger, /v1/health, /openapi.json
 *   API key       /v1/* customer resources (+ Idempotency-Key on POST/PUT)
 *   wallet token  /v1/wallet/*
 *   admin token   /admin/*
 *   none          /internal/mediator/:secret, /healthz, /readyz (never proxied by the edge)
 *
 * Response schemas are enforced by the serializer, so a handler cannot leak fields that are not
 * in its schema (same rule as agent-service).
 */
import swagger from '@fastify/swagger'
import Fastify from 'fastify'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import type { Logger as PinoLogger } from 'pino'

import type { AgentClient } from '../agent-client.ts'
import type { PlatformConfig } from '../config.ts'
import type { Database } from '../db/client.ts'
import type { MediatorClient } from '../mediator-client.ts'
import type { WakeOutcome } from '../wake.ts'
import { requireApiKey, requireWalletToken } from './auth.ts'
import { platformErrorHandler } from './errors.ts'
import { useIdempotency } from './idempotency.ts'
import { adminRoutes } from './routes/admin.ts'
import { catalogueRoutes } from './routes/catalogue.ts'
import { exchangeRoutes } from './routes/exchanges.ts'
import { internalRoutes } from './routes/internal.ts'
import { proofTemplateRoutes } from './routes/proof-templates.ts'
import { publicRoutes } from './routes/public.ts'
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
}

export function buildApp(deps: AppDeps) {
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

  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: '12id Platform API',
        version: '1.0.0',
        description:
          'Issue and verify AnonCreds credentials with holders running the 12id SDK. Commands are asynchronous: they return the exchange record immediately and progress arrives through signed webhooks (or polling). Ids are stable per tenant.',
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
        { name: 'admin', description: 'Operator bootstrap; not reachable from the internet' },
      ],
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer', description: 'API key `12id_sk_…` issued per tenant' },
          walletToken: { type: 'http', scheme: 'bearer', description: 'Wallet token `12id_wt_…` returned by POST /v1/wallets' },
        },
      },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  })

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  app.register(publicRoutes({ config: deps.config, readiness: deps.readiness }))
  app.register(internalRoutes({ webhookSecret: deps.config.MEDIATOR_WEBHOOK_SECRET, wake: deps.wake, readiness: deps.readiness }))

  // Customer scope: API key, then idempotency on mutations.
  app.register(async (scope) => {
    scope.addHook('onRequest', requireApiKey(deps.db))
    useIdempotency(scope, deps.db)
    await scope.register(catalogueRoutes({ agent: deps.agent }))
    await scope.register(exchangeRoutes({ db: deps.db, agent: deps.agent }))
    await scope.register(proofTemplateRoutes({ db: deps.db }))
    await scope.register(walletCustomerRoutes({ db: deps.db }))
    await scope.register(webhookRoutes({ db: deps.db }))
  })

  // SDK scope: wallet token.
  app.register(async (scope) => {
    scope.addHook('onRequest', requireWalletToken(deps.db))
    await scope.register(walletDeviceRoutes({ db: deps.db, mediator: deps.mediator }))
  })

  // Operator scope.
  app.register(adminRoutes({ db: deps.db, agent: deps.agent, adminToken: deps.config.PLATFORM_ADMIN_TOKEN }))

  return app
}

export type PlatformApp = ReturnType<typeof buildApp>
