/**
 * Bearer secrets handed to customers (API keys) and to apps (wallet tokens). Only sha256 digests
 * are stored; the prefix narrows the lookup so the hash comparison is constant-time on one row.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const API_KEY_PREFIX = '12id_sk_'
export const WALLET_TOKEN_PREFIX = '12id_wt_'

/** First 12 characters (prefix + 4 random) identify the key without revealing it. */
export const LOOKUP_PREFIX_LENGTH = 12

export function generateSecret(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function lookupPrefix(secret: string): string {
  return secret.slice(0, LOOKUP_PREFIX_LENGTH)
}

export function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Extracts a bearer token with the expected prefix from an Authorization header. */
export function bearerToken(header: unknown, prefix: string): string | null {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1]
  if (!token.startsWith(prefix) || token.length < prefix.length + 32) return null
  return token
}
