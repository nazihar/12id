/**
 * Webhook signatures (P7): `X-12id-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`.
 * The timestamp is part of the signed string so a captured delivery cannot be replayed later
 * without the receiver noticing the age.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-12id-signature'
export const EVENT_HEADER = 'x-12id-event'
export const DELIVERY_HEADER = 'x-12id-delivery'

export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
  return `t=${timestampSeconds},v1=${mac}`
}

/** Receiver-side check, also used by the smoke tests. `toleranceSeconds` bounds replay. */
export function verifySignature(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=') as [string, string]))
  const t = Number(parts.t)
  const v1 = parts.v1
  if (!Number.isInteger(t) || typeof v1 !== 'string') return false
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(v1)
  return a.length === b.length && timingSafeEqual(a, b)
}
