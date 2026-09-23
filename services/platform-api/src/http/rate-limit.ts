/**
 * Per-principal request limits (review M4): per API key, per wallet token, and per wallet for
 * mediator invitations (each one creates a mediator record). The edge only limits per IP, and a
 * leaked key behind a large NAT is otherwise indistinguishable from the rest of it.
 *
 * Fixed windows kept in process: platform-api runs one replica, and the review (§8) keeps Redis out
 * until a second one exists. `RateLimitStore` is the seam where a shared store would go. Every limit
 * is a setting, and 0 turns it off (self-hosted installs tune or disable them).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

import type { TenantContext, WalletContext } from './auth.ts'

export interface RateLimitStore {
  /** Counts one request for `key` in the window containing `now`; returns the count and the window end. */
  hit(key: string, windowMs: number, now: number): { count: number; resetAt: number }
}

export function memoryRateLimitStore(): RateLimitStore & { size(): number } {
  const windows = new Map<string, { resetAt: number; count: number }>()
  let lastSweep = 0
  return {
    hit(key, windowMs, now) {
      // Drop expired windows now and then so idle keys do not accumulate.
      if (now - lastSweep > 60_000) {
        for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k)
        lastSweep = now
      }
      let window = windows.get(key)
      if (!window || window.resetAt <= now) {
        window = { resetAt: now + windowMs, count: 0 }
        windows.set(key, window)
      }
      window.count += 1
      return { count: window.count, resetAt: window.resetAt }
    },
    size: () => windows.size,
  }
}

export interface RateLimits {
  apiKeyPerMin: number
  walletPerMin: number
  invitationsPer10Min: number
}

const MINUTE = 60_000

function refuse(reply: FastifyReply, resetAt: number, now: number, reason: string) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000))
  return reply.code(429).header('retry-after', String(retryAfter)).send({ error: 'rate_limited', reason: `${reason}; retry after ${retryAfter} s` })
}

export function rateLimiter(limits: RateLimits, store: RateLimitStore = memoryRateLimitStore(), clock: () => number = Date.now) {
  return {
    /** Customer scope, after authentication. The console (people, audited) is not limited here. */
    tenant: async (request: FastifyRequest, reply: FastifyReply) => {
      const tenant = request.tenant as TenantContext | undefined
      if (!tenant || tenant.principal.kind !== 'apiKey') return
      const limit = tenant.rateLimitPerMin ?? limits.apiKeyPerMin
      if (limit <= 0) return
      const now = clock()
      const { count, resetAt } = store.hit(`key:${tenant.principal.apiKeyId}`, MINUTE, now)
      if (count > limit) return refuse(reply, resetAt, now, `more than ${limit} requests per minute for this API key`)
    },
    /** SDK scope, after authentication. */
    wallet: async (request: FastifyRequest, reply: FastifyReply) => {
      const wallet = request.wallet as WalletContext | undefined
      if (!wallet || limits.walletPerMin <= 0) return
      const now = clock()
      const { count, resetAt } = store.hit(`wallet:${wallet.id}`, MINUTE, now)
      if (count > limits.walletPerMin) return refuse(reply, resetAt, now, `more than ${limits.walletPerMin} requests per minute for this wallet`)
    },
    /** `GET /v1/wallet/mediator-invitation` only: an app calls it once, at first launch. */
    invitation: async (request: FastifyRequest, reply: FastifyReply) => {
      const wallet = request.wallet as WalletContext | undefined
      if (!wallet || limits.invitationsPer10Min <= 0) return
      const now = clock()
      const { count, resetAt } = store.hit(`invitation:${wallet.id}`, 10 * MINUTE, now)
      if (count > limits.invitationsPer10Min) return refuse(reply, resetAt, now, `more than ${limits.invitationsPer10Min} mediator invitations per 10 minutes for this wallet`)
    },
  }
}

export type RateLimiter = ReturnType<typeof rateLimiter>
