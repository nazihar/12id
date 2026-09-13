import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Error handler for our internal Fastify APIs.
 *
 * Fastify's default handler puts `error.message` in the response. For database errors that
 * message contains the SQL text and its parameters (drizzle's "Failed query: … params: …"),
 * which a local run of endorser-service returned in a 500 body. Server errors are now logged
 * with full detail and answered generically; client errors (validation, 4xx) keep their message.
 */
export function internalApiErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500
  if (status >= 500) {
    request.log.error({ err: error }, 'request failed')
    return reply.code(500).send({ error: 'internal', reason: 'internal error' })
  }
  return reply.code(status).send({ error: 'bad_request', reason: error.message })
}

/** Postgres SQLSTATE of an error, whether thrown by `pg` directly or wrapped by drizzle (`cause`). */
export function postgresErrorCode(error: unknown): string | undefined {
  const direct = (error as { code?: unknown })?.code
  if (typeof direct === 'string') return direct
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code
  return typeof cause === 'string' ? cause : undefined
}
