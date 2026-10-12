/**
 * One page of the audit log, for the audit page and for its export (implement/22 C12).
 *
 * platform-api records the Better Auth user id as actor and, since implement/22 C13, the account's
 * email with it, so an entry stays readable after the account is deleted. Entries from before that
 * are resolved from the console database. The one search box also covers names and emails: the
 * console looks up the matching accounts and passes their ids as `qActor`, which platform-api ORs
 * with its route, actor-id and stored-email match (so the break-glass actor `admin-token` is found
 * by its id).
 */
import { ilike, inArray, or } from 'drizzle-orm'

import type { AuditSearch } from '@/features/ops/ops.schemas'
import { createdParams, likeContains, pageParams } from '@/lib/list-search'

import { consoleDb } from './db.server'
import { user } from './db/auth-schema'
import type { Principal } from './middleware'
import { platformFor, unwrap } from './platform.server'

export async function readAuditLog(principal: Principal, search: AuditSearch) {
  const { db } = consoleDb()
  const pattern = search.q ? likeContains(search.q) : undefined
  const qActor = pattern ? (await db.select({ id: user.id }).from(user).where(or(ilike(user.email, pattern), ilike(user.name, pattern))).limit(50)).map((m) => m.id) : []
  const entries = unwrap(
    await platformFor(principal).GET('/admin/audit', { params: { query: { ...pageParams(search), ...createdParams(search), tenantId: search.tenantId, kind: search.kind, qActor: qActor.length ? qActor : undefined } } })
  )
  const actorIds = [...new Set(entries.items.map((entry) => entry.actor))]
  const accounts = actorIds.length === 0 ? [] : await db.select({ id: user.id, email: user.email, name: user.name }).from(user).where(inArray(user.id, actorIds))
  const byId = new Map(accounts.map((account) => [account.id, account]))
  // `changes` (review L10) is free-form JSON, which a server function cannot type; it goes to the page as text.
  return {
    ...entries,
    items: entries.items.map(({ changes, actorLabel, ...entry }) => ({
      ...entry,
      changes: changes ? JSON.stringify(changes, null, 2) : null,
      // The email as it was when the entry was written wins over today's account.
      actorEmail: actorLabel ?? byId.get(entry.actor)?.email ?? null,
      actorName: byId.get(entry.actor)?.name ?? null,
    })),
  }
}
