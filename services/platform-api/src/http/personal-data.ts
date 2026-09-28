/**
 * Operators see personal data masked (Phase 7 H1). A tenant's own principals (API keys, owners,
 * admins, members) see their data as is. An operator, who can open every tenant, gets attribute
 * values, disclosed values, holder labels and webhook bodies masked, unless the console sends a
 * reason in `x-console-reveal-reason`. That reveal is audited with the reason, like an erasure.
 */
import type { FastifyRequest } from 'fastify'

import { maskValue, redactBody } from '../erasure.ts'
import type { ConnectionView, CredentialView, ProofView } from '../views.ts'
import type { TenantContext } from './auth.ts'
import { PlatformError } from './errors.ts'

export const REVEAL_REASON_HEADER = 'x-console-reveal-reason'
export const MASK = '••••••'
const MAX_REASON = 500

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by a reveal or an erasure; the console audit records it, even on a GET. */
    auditReason?: string
  }
}

/** A console reason (reveal header or erasure body): trimmed, 1–500 characters. */
export function cleanReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > MAX_REASON) throw new PlatformError(400, 'bad_request', `the reason is limited to ${MAX_REASON} characters`)
  return trimmed
}

function decodeHeader(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** true when this request must see personal data masked. Records a reveal's reason for the audit. */
export function masked(request: FastifyRequest): boolean {
  const principal = (request.tenant as TenantContext | undefined)?.principal
  if (principal?.kind !== 'console' || principal.role !== 'operator') return false
  // The console URI-encodes the reason: a header cannot carry every character a person may type.
  const reason = cleanReason(decodeHeader(request.headers[REVEAL_REASON_HEADER]))
  if (!reason) return true
  request.auditReason = `reveal: ${reason}`
  return false
}

export const maskCredential = (view: CredentialView): CredentialView => ({ ...view, attributes: maskValue(view.attributes, MASK) as CredentialView['attributes'] })
export const maskProof = (view: ProofView): ProofView => ({ ...view, disclosed: maskValue(view.disclosed, MASK) as ProofView['disclosed'] })
export const maskConnection = (view: ConnectionView): ConnectionView => ({ ...view, theirLabel: view.theirLabel === null ? null : MASK })
export const maskBody = (body: string) => redactBody(body, MASK)
