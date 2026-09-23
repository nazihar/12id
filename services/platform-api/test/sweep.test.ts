/** Wallet and mediator housekeeping (review M10, M4) against a real Postgres, mediator doubled. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { eq } from 'drizzle-orm'

import { tenants, wallets } from '../src/db/schema.ts'
import { sweepOnce } from '../src/sweep.ts'
import { silentLogger, testDatabase } from './helpers.ts'

const db = await testDatabase()
const DAY = 24 * 60 * 60 * 1000

describe('wallet sweep', { skip: db ? false : 'no test database' }, () => {
  it('marks connected wallets, revokes never-connected ones after 7 days, and clears revoked ones after the grace period', async () => {
    const now = new Date('2026-10-01T00:00:00Z')
    const ago = (days: number) => new Date(now.getTime() - days * DAY)
    const [tenant] = await db!.db.insert(tenants).values({ name: 'Sweep', agentTenantId: 'agent-sweep', status: 'ready' }).returning()
    const insert = async (tokenHash: string, fields: Partial<typeof wallets.$inferInsert>) =>
      (await db!.db.insert(wallets).values({ tenantId: tenant.id, tokenHash, ...fields }).returning())[0]

    // Connected through its invitation, though no webhook ever mapped it: must not be revoked.
    const connectedQuietly = await insert('s1', { mediatorOobId: 'oob-quiet', createdAt: ago(10) })
    // Never fetched or never used an invitation, 10 days old: revoked.
    const abandoned = await insert('s2', { mediatorOobId: 'oob-unused', createdAt: ago(10) })
    const noInvitation = await insert('s3', { createdAt: ago(10) })
    // Young and not yet connected: left alone.
    const young = await insert('s4', { mediatorOobId: 'oob-young', createdAt: ago(2) })
    // Revoked by the customer 31 days ago: its mediator connection goes. Revoked 5 days ago: kept.
    const oldRevoked = await insert('s5', { mediatorOobId: 'oob-old', mediatorConnectionId: 'conn-old-cached', connectedAt: ago(60), createdAt: ago(60), revokedAt: ago(31) })
    const newRevoked = await insert('s6', { mediatorOobId: 'oob-new', connectedAt: ago(20), createdAt: ago(20), revokedAt: ago(5) })

    const removed: string[] = []
    const sweeps: unknown[] = []
    const mediator = {
      connectionsForOutOfBandIds: async (ids: string[]) => {
        const known: Record<string, string[]> = { 'oob-quiet': ['conn-quiet'], 'oob-old': ['conn-old'], 'oob-new': ['conn-new'] }
        return new Map(ids.filter((id) => known[id]).map((id) => [id, known[id]]))
      },
      removeConnection: async (id: string) => {
        removed.push(id)
        return { mediations: 1, connections: 1, queued: 0 }
      },
      sweep: async (options: unknown) => {
        sweeps.push(options)
        return { invitations: 4, queued: 2 }
      },
    }
    const deps = { db: db!.db, mediator, logger: silentLogger, unconnectedRevokeDays: 7, revokedGraceDays: 30, invitationTtlHours: 24, queueTtlDays: 30, now: () => now, batch: 2 }

    const report = await sweepOnce(deps)
    assert.deepEqual(report, { connected: 1, revokedNeverConnected: 2, mediationRemoved: 1, invitationsDeleted: 4, queuedDeleted: 2 })
    const byId = async (id: string) => (await db!.db.select().from(wallets).where(eq(wallets.id, id)))[0]
    assert.ok((await byId(connectedQuietly.id)).connectedAt, 'connected wallet marked')
    assert.equal((await byId(connectedQuietly.id)).revokedAt, null)
    for (const w of [abandoned, noInvitation]) {
      const row = await byId(w.id)
      assert.ok(row.revokedAt)
      assert.equal(row.revokedReason, 'never_connected')
    }
    assert.equal((await byId(young.id)).revokedAt, null, 'too young to revoke')
    assert.deepEqual(removed.sort(), ['conn-old', 'conn-old-cached'], 'both the cached and the looked-up connection of the old revoked wallet')
    assert.ok((await byId(oldRevoked.id)).mediationRemovedAt)
    assert.equal((await byId(newRevoked.id)).mediationRemovedAt, null, 'inside the grace period')
    assert.deepEqual(sweeps, [{ invitationsOlderThanHours: 24, queuedOlderThanDays: 30 }])

    // Idempotent: a second pass finds nothing new. The never-connected wallets are now revoked, so after
    // their own grace period they would be cleared too, but not yet.
    const again = await sweepOnce(deps)
    assert.deepEqual([again.connected, again.revokedNeverConnected, again.mediationRemoved], [0, 0, 0])
  })
})
