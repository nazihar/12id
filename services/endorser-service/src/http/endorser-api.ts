/**
 * endorser-service HTTP API (A9). Internal network only; every route except /healthz requires
 * the shared token. It signs, never submits: the tenant (via agent-service) submits to the ledger.
 */
import { createHash } from 'node:crypto'

import {
  INTERNAL_TOKEN_HEADER,
  bindTenantBody,
  bindTenantResponse,
  endorseBody,
  endorseResponse,
  refusalResponse,
} from '@12id/credo-base/endorsement-contract.ts'
import { internalApiErrorHandler } from '@12id/credo-base/fastify-errors.ts'
import { tokenMatches } from '@12id/credo-base/internal-token.ts'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import type { Logger as PinoLogger } from 'pino'
import { z } from 'zod'

import type { TenantBindings } from '../db/bindings.ts'
import { checkEndorsement } from '../policy.ts'

export interface AuditEntry {
  tenantId: string
  kind: string
  operationType?: string
  author?: string
  allowed: boolean
  reason?: string
  requestSha256: string
}

export interface EndorserApiOptions {
  logger: PinoLogger
  /** Shared secret from SOPS. */
  token: string
  /** Unqualified nym of the platform endorser DID. */
  endorserNym: string
  bindings: TenantBindings
  /** Signs an already-approved ledger request (IndyVdrApi.endorseTransaction in production). */
  sign(request: string): Promise<string>
  audit: {
    record(entry: AuditEntry): Promise<void>
    /** Allowed schema + cred def endorsements for the tenant since `since`. */
    ledgerWritesSince?(tenantId: string, since: Date): Promise<number>
  }
  /**
   * Most schemas + credential definitions one tenant may have endorsed in any 24 h (review M3):
   * a backstop against a hijacked console account or a bug, since ledger objects are immutable.
   * 0 or unset: no ceiling.
   */
  dailyLedgerWriteCeiling?: number
  now?: () => Date
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export function buildEndorserApi(options: EndorserApiOptions) {
  if (options.token.length < 32) throw new Error('endorser-service token must be at least 32 characters')

  const app = Fastify({
    loggerInstance: options.logger.child({ component: 'endorser-api' }),
    // Cred def requests are large; the contract caps `request` at 512 kB.
    bodyLimit: 1_048_576,
  }).withTypeProvider<ZodTypeProvider>()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler(internalApiErrorHandler)

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/healthz') return
    if (!tokenMatches(request.headers[INTERNAL_TOKEN_HEADER], options.token)) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'missing or invalid internal token' })
    }
  })

  app.get('/healthz', { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } }, async () => ({
    status: 'ok' as const,
  }))

  app.post(
    '/tenants/bind',
    { schema: { body: bindTenantBody, response: { 200: bindTenantResponse, 409: refusalResponse } } },
    async (request, reply) => {
      const { tenantId, nym } = request.body
      const outcome = await options.bindings.bind(tenantId, nym)
      if (outcome.result === 'conflict') {
        request.log.warn({ tenantId, nym, reason: outcome.reason }, 'tenant bind refused')
        return reply.code(409).send({ error: 'conflict', reason: outcome.reason })
      }
      request.log.info({ tenantId, nym, result: outcome.result }, 'tenant bound')
      return reply.code(200).send({ result: outcome.result, tenantId, nym })
    }
  )

  app.post(
    '/endorse',
    { schema: { body: endorseBody, response: { 200: endorseResponse, 403: refusalResponse } } },
    async (request, reply) => {
      const body = request.body
      const requestSha256 = sha256(body.request)
      const decision = await checkEndorsement(body, options.endorserNym, options.bindings)

      const refuse = async (reason: string) => {
        await options.audit.record({ tenantId: body.tenantId, kind: body.kind, allowed: false, reason, requestSha256 })
        request.log.warn({ tenantId: body.tenantId, kind: body.kind, reason, requestSha256 }, 'endorsement refused')
        return reply.code(403).send({ error: 'refused', reason })
      }
      if (!decision.allowed) return refuse(decision.reason)

      const ceiling = options.dailyLedgerWriteCeiling ?? 0
      if (ceiling > 0 && decision.kind !== 'nym' && options.audit.ledgerWritesSince) {
        const since = new Date((options.now?.() ?? new Date()).getTime() - 24 * 60 * 60 * 1000)
        const written = await options.audit.ledgerWritesSince(body.tenantId, since)
        if (written >= ceiling) return refuse(`daily ledger-write ceiling reached: ${written} schemas and credential definitions in the last 24 hours (limit ${ceiling})`)
      }

      const endorsedRequest = await options.sign(body.request)
      // Fail closed: if the audit row cannot be written, the signature is not released.
      await options.audit.record({
        tenantId: body.tenantId,
        kind: body.kind,
        operationType: decision.operationType,
        author: decision.author,
        allowed: true,
        requestSha256,
      })
      request.log.info({ tenantId: body.tenantId, kind: body.kind, operationType: decision.operationType, requestSha256 }, 'endorsed')
      return reply.code(200).send({ endorsedRequest })
    }
  )

  return app
}
