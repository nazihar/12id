/**
 * Three callers, three credentials (P3):
 *   - customer backends: `Authorization: Bearer 12id_sk_…` (API key, tenant-scoped);
 *   - customer apps / the SDK: `Authorization: Bearer 12id_wt_…` (wallet token);
 *   - the operator: `x-admin-token` (bootstrap routes, never proxied by the edge).
 *
 * Each hook resolves the principal onto the request; routes read `request.tenant` / `request.wallet`.
 */
import { tokenMatches } from '@12id/credo-base/internal-token.ts'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { API_KEY_PREFIX, WALLET_TOKEN_PREFIX, bearerToken, hashSecret, lookupPrefix } from '../auth/tokens.ts'
import type { Database } from '../db/client.ts'
import { apiKeys, tenants, wallets } from '../db/schema.ts'
import { PlatformError } from './errors.ts'

export interface TenantContext {
  id: string
  agentTenantId: string
  name: string
  status: string
  apiKeyId: string
}

export interface WalletContext {
  id: string
  tenantId: string
  agentTenantId: string
  externalId: string | null
  mediatorOobId: string | null
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext
    wallet?: WalletContext
  }
}

const unauthorized = (reply: FastifyReply, reason: string) => reply.code(401).send({ error: 'unauthorized', reason })

export function requireApiKey(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(request.headers.authorization, API_KEY_PREFIX)
    if (!token) return unauthorized(reply, 'missing or malformed API key')
    const hash = hashSecret(token)
    const [row] = await db
      .select({ id: apiKeys.id, keyHash: apiKeys.keyHash, tenantId: tenants.id, agentTenantId: tenants.agentTenantId, name: tenants.name, status: tenants.status })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .where(and(eq(apiKeys.prefix, lookupPrefix(token)), eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1)
    if (!row) return unauthorized(reply, 'unknown or revoked API key')
    request.tenant = { id: row.tenantId, agentTenantId: row.agentTenantId, name: row.name, status: row.status, apiKeyId: row.id }
    // Fire-and-forget; a slow update must not delay the request.
    void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => undefined)
  }
}

export function requireWalletToken(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(request.headers.authorization, WALLET_TOKEN_PREFIX)
    if (!token) return unauthorized(reply, 'missing or malformed wallet token')
    const [row] = await db
      .select({ id: wallets.id, tenantId: wallets.tenantId, agentTenantId: tenants.agentTenantId, externalId: wallets.externalId, mediatorOobId: wallets.mediatorOobId })
      .from(wallets)
      .innerJoin(tenants, eq(tenants.id, wallets.tenantId))
      .where(and(eq(wallets.tokenHash, hashSecret(token)), isNull(wallets.revokedAt)))
      .limit(1)
    if (!row) return unauthorized(reply, 'unknown or revoked wallet token')
    request.wallet = row
  }
}

export function requireAdminToken(expected: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!tokenMatches(request.headers['x-admin-token'], expected)) return unauthorized(reply, 'missing or invalid admin token')
  }
}

/** Tenants that are still provisioning (or failed) cannot run ledger or DIDComm commands. */
export function assertTenantReady(tenant: TenantContext) {
  if (tenant.status !== 'ready') throw new PlatformError(409, 'tenant_not_ready', `tenant is ${tenant.status}`)
}
