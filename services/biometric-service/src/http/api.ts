/**
 * biometric-service internal API (16-phase-6-biometric.md B1). Private network; platform-api is
 * the only caller. Every route except /healthz requires the service's own token.
 */
import {
  INTERNAL_TOKEN_HEADER,
  checkResponse,
  completeSessionBody,
  completeSessionResponse,
  createCheckBody,
  createCheckResponse,
  errorResponse,
  providerCatalogueResponse,
  providerTestResponse,
  putTenantProviderBody,
  startSessionResponse,
  tenantIdSchema,
  tenantProviderResponse,
} from '@12id/credo-base/biometric-contract.ts'
import { internalApiErrorHandler } from '@12id/credo-base/fastify-errors.ts'
import { tokenMatches } from '@12id/credo-base/internal-token.ts'
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify'
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import type { Logger } from 'pino'
import { z } from 'zod'

import { type BiometricService, ServiceError } from '../biometric.ts'

export interface BiometricApiOptions {
  logger: Logger
  token: string
  service: BiometricService
}

const tenantParams = z.object({ tenantId: tenantIdSchema })
const idParams = z.object({ id: z.string().uuid() })
const errors = { 400: errorResponse, 404: errorResponse, 409: errorResponse, 424: errorResponse, 502: errorResponse }

export function buildBiometricApi(options: BiometricApiOptions) {
  if (options.token.length < 32) throw new Error('biometric-service token must be at least 32 characters')

  const app = Fastify({
    loggerInstance: options.logger.child({ component: 'biometric-api' }),
    // A 5 MB image is about 6.7 MB of base64.
    bodyLimit: 8 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ServiceError) return reply.code(error.status).send({ error: error.code, reason: error.message })
    return internalApiErrorHandler(error, request, reply)
  })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/healthz') return
    if (!tokenMatches(request.headers[INTERNAL_TOKEN_HEADER], options.token)) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'missing or invalid internal token' })
    }
  })

  const { service } = options

  app.get('/healthz', { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } }, async () => ({ status: 'ok' as const }))

  app.get('/providers', { schema: { response: { 200: providerCatalogueResponse } } }, async () => service.catalogue())

  app.get('/tenants/:tenantId/provider', { schema: { params: tenantParams, response: { 200: tenantProviderResponse } } }, async (request) =>
    service.getTenantProvider(request.params.tenantId)
  )

  app.put(
    '/tenants/:tenantId/provider',
    { schema: { params: tenantParams, body: putTenantProviderBody, response: { 200: tenantProviderResponse, ...errors } } },
    async (request) => service.putTenantProvider(request.params.tenantId, request.body.providerId, request.body.config)
  )

  app.delete('/tenants/:tenantId/provider', { schema: { params: tenantParams } }, async (request, reply) => {
    await service.deleteTenantProvider(request.params.tenantId)
    return reply.code(204).send()
  })

  app.post(
    '/tenants/:tenantId/provider/test',
    { schema: { params: tenantParams, response: { 200: providerTestResponse, ...errors } } },
    async (request) => service.testTenantProvider(request.params.tenantId)
  )

  app.post('/checks', { schema: { body: createCheckBody, response: { 201: createCheckResponse, ...errors } } }, async (request, reply) =>
    reply.code(201).send(await service.createCheck(request.body))
  )

  app.get('/checks/:id', { schema: { params: idParams, response: { 200: checkResponse, ...errors } } }, async (request) =>
    service.getCheck(request.params.id)
  )

  app.delete('/checks/:id', { schema: { params: idParams } }, async (request, reply) => {
    await service.cancelCheck(request.params.id)
    return reply.code(204).send()
  })

  app.post('/checks/:id/sessions', { schema: { params: idParams, response: { 201: startSessionResponse, ...errors } } }, async (request, reply) =>
    reply.code(201).send(await service.startSession(request.params.id))
  )

  app.post(
    '/sessions/:id/complete',
    { schema: { params: idParams, body: completeSessionBody, response: { 200: completeSessionResponse, ...errors } } },
    async (request) => service.completeSession(request.params.id, request.body.clientOutput)
  )

  return app
}
