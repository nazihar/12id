/**
 * Webhook signatures (P7): `X-12id-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`.
 * The timestamp is part of the signed string so a captured delivery cannot be replayed later
 * without the receiver noticing the age.
 *
 * During a secret rotation the header carries one `v1` per secret, newest first
 * (`t=…,v1=<new>,v1=<old>`), so a receiver still on the old secret keeps accepting deliveries
 * until it switches (review M9). Receivers must accept a match on any `v1`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-12id-signature'
export const EVENT_HEADER = 'x-12id-event'
export const DELIVERY_HEADER = 'x-12id-delivery'

/** How long deliveries are also signed with the secret a rotation replaced. */
export const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000

const mac = (secret: string, timestampSeconds: number, body: string) => createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')

/** `secrets` newest first; one `v1` each. A single string is the one current secret. */
export function signPayload(secrets: string | string[], body: string, timestampSeconds: number): string {
  const list = typeof secrets === 'string' ? [secrets] : secrets
  return [`t=${timestampSeconds}`, ...list.map((secret) => `v1=${mac(secret, timestampSeconds, body)}`)].join(',')
}

/** The secrets to sign with now: the current one, plus the replaced one inside the overlap window. */
export function signingSecrets(endpoint: { secret: string; previousSecret: string | null; rotatedAt: Date | null }, now: Date): string[] {
  const overlapping = endpoint.previousSecret && endpoint.rotatedAt && now.getTime() - endpoint.rotatedAt.getTime() < ROTATION_OVERLAP_MS
  return overlapping ? [endpoint.secret, endpoint.previousSecret as string] : [endpoint.secret]
}

/** Receiver-side check, also used by the smoke tests. Accepts any `v1`. `toleranceSeconds` bounds replay. */
export function verifySignature(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  let t = Number.NaN
  const candidates: string[] = []
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2)
    if (key === 't') t = Number(value)
    else if (key === 'v1' && value) candidates.push(value)
  }
  if (!Number.isInteger(t) || candidates.length === 0) return false
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false
  const expected = Buffer.from(mac(secret, t, body))
  return candidates.some((candidate) => {
    const given = Buffer.from(candidate)
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
