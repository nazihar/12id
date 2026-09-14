/**
 * Customer-facing error shape: `{ error: <code>, reason: <text> }`. Domain errors carry their
 * status; agent-service 4xx pass through with the agent's reason; everything else is a generic 500
 * (Phase 2 lesson: never echo error.message for server errors, it leaked SQL).
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

import { AgentError } from '../agent-client.ts'

export class PlatformError extends Error {
  public readonly status: number
  public readonly code: string

  public constructor(status: number, code: string, reason: string) {
    super(reason)
    this.name = 'PlatformError'
    this.status = status
    this.code = code
  }
}

export const notFound = (what: string) => new PlatformError(404, 'not_found', `${what} not found`)
export const conflict = (reason: string) => new PlatformError(409, 'conflict', reason)
export const badRequest = (reason: string) => new PlatformError(400, 'bad_request', reason)

export function platformErrorHandler(error: FastifyError | PlatformError | AgentError, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof PlatformError) return reply.code(error.status).send({ error: error.code, reason: error.message })
  if (error instanceof AgentError) {
    if (error.status >= 500) request.log.error({ err: error }, 'agent-service call failed')
    return reply.code(error.status).send({ error: error.code, reason: error.status >= 500 ? 'upstream agent error' : error.message })
  }
  const fastifyError = error as FastifyError
  const status = fastifyError.statusCode && fastifyError.statusCode >= 400 ? fastifyError.statusCode : 500
  if (status >= 500) {
    request.log.error({ err: error }, 'request failed')
    return reply.code(500).send({ error: 'internal', reason: 'internal error' })
  }
  const code = fastifyError.validation ? 'validation' : status === 404 ? 'not_found' : 'bad_request'
  return reply.code(status).send({ error: code, reason: fastifyError.message })
}
