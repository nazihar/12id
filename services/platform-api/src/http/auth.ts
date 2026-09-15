/**
 * Callers and their credentials:
 *   - customer backends: `Authorization: Bearer 12id_sk_…` (API key, tenant-scoped, P3);
 *   - customer apps / the SDK: `Authorization: Bearer 12id_wt_…` (wallet token, P3);
 *   - the console (Phase 4 C1): `x-console-token` + `x-console-actor` + `x-console-role`, plus
 *     `x-console-tenant` on tenant routes. Only the console's server holds the token, on the Docker
 *     network, and the edge refuses the header. The console decides which tenant a signed-in user may
 *     act for (organization membership); here the tenant only has to exist;
 *   - the operator break-glass: `x-admin-token` over an SSH tunnel.
 *
 * Each hook resolves the principal onto the request; routes read `request.tenant` / `request.wallet`
 * / `request.operator`.
 */
import { tokenMatches } from '@12id/credo-base/internal-token.ts'
import { and, eq, isNull } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { API_KEY_PREFIX, WALLET_TOKEN_PREFIX, bearerToken, hashSecret, lookupPrefix } from '../auth/tokens.ts'
import type { Database } from '../db/client.ts'
import { apiKeys, tenants, wallets } from '../db/schema.ts'
import { PlatformError } from './errors.ts'

export const CONSOLE_TOKEN_HEADER = 'x-console-token'
export const CONSOLE_TENANT_HEADER = 'x-console-tenant'
export const CONSOLE_ACTOR_HEADER = 'x-console-actor'
export const CONSOLE_ROLE_HEADER = 'x-console-role'
/** `operator` spans tenants; the other three are organization roles inside one tenant. */
export const CONSOLE_ROLES = ['operator', 'owner', 'admin', 'member'] as const
export type ConsoleRole = (typeof CONSOLE_ROLES)[number]

export type Principal = { kind: 'apiKey'; apiKeyId: string } | { kind: 'console'; actor: string; role: ConsoleRole }

export interface TenantContext {
  id: string
  agentTenantId: string
  name: string
  status: string
  principal: Principal
}

export interface WalletContext {
  id: string
  tenantId: string
  agentTenantId: string
  externalId: string | null
  mediatorOobId: string | null
}

export interface OperatorContext {
  via: 'console' | 'admin_token'
  /** The console user id, or `admin-token` for the break-glass path. */
  actor: string
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext
    wallet?: WalletContext
    operator?: OperatorContext
  }
}

const unauthorized = (reply: FastifyReply, reason: string) => reply.code(401).send({ error: 'unauthorized', reason })
const forbidden = (reply: FastifyReply, reason: string) => reply.code(403).send({ error: 'forbidden', reason })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTOR = /^[A-Za-z0-9_.:@-]{1,200}$/

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * null when no console token was presented. A presented token that is wrong (or a scope that is
 * disabled) never falls back to another credential.
 */
function consoleIdentity(request: FastifyRequest, consoleToken: string | undefined): { actor: string; role: ConsoleRole } | { error: string } | null {
  const presented = request.headers[CONSOLE_TOKEN_HEADER]
  if (presented === undefined) return null
  if (!consoleToken || !tokenMatches(presented, consoleToken)) return { error: 'missing or invalid console token' }
  const actor = headerValue(request, CONSOLE_ACTOR_HEADER)
  if (!actor || !ACTOR.test(actor)) return { error: 'missing or malformed console actor' }
  const role = headerValue(request, CONSOLE_ROLE_HEADER)
  if (!role || !(CONSOLE_ROLES as readonly string[]).includes(role)) return { error: 'missing or unknown console role' }
  return { actor, role: role as ConsoleRole }
}

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
    request.tenant = { id: row.tenantId, agentTenantId: row.agentTenantId, name: row.name, status: row.status, principal: { kind: 'apiKey', apiKeyId: row.id } }
    // Fire-and-forget; a slow update must not delay the request.
    void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => undefined)
  }
}

/** Customer routes: an API key, or the console acting for the tenant named in `x-console-tenant`. */
export function requireTenantPrincipal(db: Database, consoleToken: string | undefined) {
  const apiKey = requireApiKey(db)
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = consoleIdentity(request, consoleToken)
    if (identity === null) return apiKey(request, reply)
    if ('error' in identity) return unauthorized(reply, identity.error)
    const tenantId = headerValue(request, CONSOLE_TENANT_HEADER)
    if (!isUuid(tenantId)) return unauthorized(reply, 'missing or malformed console tenant')
    const [row] = await db.select({ id: tenants.id, agentTenantId: tenants.agentTenantId, name: tenants.name, status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId))
    if (!row) return unauthorized(reply, 'unknown console tenant')
    request.tenant = { ...row, principal: { kind: 'console', actor: identity.actor, role: identity.role } }
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

/** Operator routes: the console with the operator role, or the break-glass admin token. */
export function requireOperator(adminToken: string, consoleToken: string | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = consoleIdentity(request, consoleToken)
    if (identity !== null) {
      if ('error' in identity) return unauthorized(reply, identity.error)
      if (identity.role !== 'operator') return forbidden(reply, 'operator role required')
      request.operator = { via: 'console', actor: identity.actor }
      return
    }
    if (!tokenMatches(request.headers['x-admin-token'], adminToken)) return unauthorized(reply, 'missing or invalid admin token')
    request.operator = { via: 'admin_token', actor: 'admin-token' }
  }
}

/** Tenants that are still provisioning (or failed) cannot run ledger or DIDComm commands. */
export function assertTenantReady(tenant: TenantContext) {
  if (tenant.status !== 'ready') throw new PlatformError(409, 'tenant_not_ready', `tenant is ${tenant.status}`)
}
