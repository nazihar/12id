/**
 * The operator area's accounts, one page at a time, newest first (Phase 4 C9): search by name or
 * email, filter by role and state (implement/26). For the Operators page and its export.
 */
import { type SQL, and, count, desc, eq, ilike, inArray, or } from 'drizzle-orm'

import type { OperatorSearch } from '@/features/operators/operators.schemas'
import { likeContains, pageParams } from '@/lib/list-search'
import { STAFF_ROLES, staffRoleOf } from '@/lib/permissions'
import { accountState } from '@/lib/sign-in-rules'

import { stateCondition } from './access-report.server'
import { consoleDb } from './db.server'
import { user } from './db/auth-schema'

export async function listStaffAccounts(data: OperatorSearch) {
  const { db } = consoleDb()
  const { page, pageSize, q } = pageParams(data)
  const filters: SQL[] = [data.role ? eq(user.role, data.role) : inArray(user.role, [...STAFF_ROLES])]
  if (data.status) filters.push(stateCondition(data.status, false))
  if (q) {
    const pattern = likeContains(q)
    filters.push(or(ilike(user.email, pattern), ilike(user.name, pattern))!)
  }
  const where = and(...filters)
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ id: user.id, email: user.email, name: user.name, role: user.role, banned: user.banned, banReason: user.banReason, banExpires: user.banExpires, lockedUntil: user.lockedUntil, twoFactorEnabled: user.twoFactorEnabled, lastSignInAt: user.lastSignInAt, createdAt: user.createdAt })
      .from(user)
      .where(where)
      .orderBy(desc(user.createdAt), desc(user.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(user).where(where),
  ])
  const items = rows.map(({ banReason, banExpires, lockedUntil, ...account }) => {
    // implement/24: locked after wrong passwords, or disabled for inactivity. implement/26: or
    // disabled by a person, until a day or until re-enabled, with the note they gave.
    const state = accountState({ banned: account.banned, banReason, banExpires, lockedUntil })
    return {
      ...account,
      state,
      disabled: state === 'disabled' ? { scope: 'account' as const, until: banExpires?.toISOString() ?? null, note: banReason ?? '' } : null,
      role: staffRoleOf(account.role) ?? 'operator',
      banned: Boolean(account.banned),
      twoFactorEnabled: Boolean(account.twoFactorEnabled),
      lastSignInAt: account.lastSignInAt?.toISOString() ?? null,
      createdAt: account.createdAt.toISOString(),
    }
  })
  return { items, total, page, pageSize }
}
