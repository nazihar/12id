import { postgresErrorCode } from '@12id/credo-base/fastify-errors.ts'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import type { TenantRegistry } from '../policy.ts'
import * as schema from './schema.ts'

export type EndorserDatabase = NodePgDatabase<typeof schema>

export type BindResult =
  | { result: 'bound' | 'already_bound'; nym: string }
  | { result: 'conflict'; reason: string }

export interface TenantBindings extends TenantRegistry {
  bind(tenantId: string, nym: string): Promise<BindResult>
}

/** Postgres-backed tenant bindings; implements the policy's TenantRegistry. */
export function createTenantBindings(db: EndorserDatabase): TenantBindings {
  async function nymForTenant(tenantId: string): Promise<string | null> {
    const [row] = await db
      .select({ nym: schema.tenantBindings.nym })
      .from(schema.tenantBindings)
      .where(eq(schema.tenantBindings.tenantId, tenantId))
    return row?.nym ?? null
  }

  async function bind(tenantId: string, nym: string): Promise<BindResult> {
    const existing = await nymForTenant(tenantId)
    if (existing === nym) return { result: 'already_bound', nym }
    if (existing !== null) return { result: 'conflict', reason: 'tenant is already bound to a different nym' }

    try {
      const inserted = await db
        .insert(schema.tenantBindings)
        .values({ tenantId, nym })
        .onConflictDoNothing({ target: schema.tenantBindings.tenantId })
        .returning({ nym: schema.tenantBindings.nym })
      if (inserted.length === 1) return { result: 'bound', nym }
    } catch (error) {
      // Unique constraint on `nym`: this DID is already bound to another tenant. drizzle wraps the
      // pg error, so the SQLSTATE is on `cause` (a local run returned 500 before this).
      if (postgresErrorCode(error) === '23505') return { result: 'conflict', reason: 'nym is bound to another tenant' }
      throw error
    }

    // Lost a race with a concurrent bind for the same tenant: report what won.
    const winner = await nymForTenant(tenantId)
    return winner === nym
      ? { result: 'already_bound', nym }
      : { result: 'conflict', reason: 'tenant is already bound to a different nym' }
  }

  return { nymForTenant, bind }
}
