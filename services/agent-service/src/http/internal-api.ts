/**
 * Private internal API (D2, D4). Only the platform API calls it; it is never published through
 * Caddy. The DIDComm endpoint is a separate port served by Credo's own transport.
 *
 * Response schemas are enforced by the serializer, so a handler cannot leak fields that are not
 * in its schema.
 */
import { internalApiErrorHandler } from '@12id/credo-base/fastify-errors.ts'
import { INTERNAL_TOKEN_HEADER, tokenMatches } from '@12id/credo-base/internal-token.ts'
import Fastify from 'fastify'
import { type FastifyPluginAsyncZod, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import type { Logger as PinoLogger } from 'pino'
import { z } from 'zod'

export const readinessSchema = z.object({
  ready: z.boolean(),
  draining: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
})

export type ReadinessReport = z.infer<typeof readinessSchema>

export interface InternalApiOptions {
  logger: PinoLogger
  /** Current readiness. Must report `ready: false` as soon as a drain starts (T3b). */
  readiness: () => Promise<ReadinessReport>
  /** Command routes (tenants, catalogue, exchanges); omitted in health-only tests. */
  commands?: FastifyPluginAsyncZod
  /**
   * Shared secret the platform API presents (Phase 3 P0). Health routes stay open for container
   * checks; everything else answers 401 without it. Omitted in health-only tests.
   */
  token?: string
}

export function buildInternalApi(options: InternalApiOptions) {
  const app = Fastify({
    loggerInstance: options.logger.child({ component: 'internal-api' }),
    // Internal callers only; a slow client must not hold a drain open.
    connectionTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler(internalApiErrorHandler)

  if (options.token !== undefined) {
    if (options.token.length < 32) throw new Error('internal API token must be at least 32 characters')
    const token = options.token
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/healthz' || request.url === '/readyz') return
      if (!tokenMatches(request.headers[INTERNAL_TOKEN_HEADER], token)) {
        return reply.code(401).send({ error: 'unauthorized', reason: 'missing or invalid internal token' })
      }
    })
  }

  // Liveness: the process is up and the event loop answers. Never checks dependencies, so an
  // orchestrator does not restart the agent because the ledger is slow.
  app.get('/healthz', { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } }, async () => ({
    status: 'ok' as const,
  }))

  // Readiness: 503 while draining or when a dependency check fails, so the edge stops routing.
  app.get('/readyz', { schema: { response: { 200: readinessSchema, 503: readinessSchema } } }, async (_request, reply) => {
    const report = await options.readiness()
    return reply.code(report.ready ? 200 : 503).send(report)
  })

  if (options.commands) app.register(options.commands)

  return app
}

export type InternalApi = ReturnType<typeof buildInternalApi>
