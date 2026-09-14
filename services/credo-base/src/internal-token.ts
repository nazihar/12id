/**
 * Shared-secret check for our internal HTTP APIs (endorser-service, agent-service). The header
 * name lives in endorsement-contract.ts; this is the constant-time comparison every service uses.
 */
import { timingSafeEqual } from 'node:crypto'

export { INTERNAL_TOKEN_HEADER } from './endorsement-contract.ts'

export function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
