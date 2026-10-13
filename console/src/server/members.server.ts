/**
 * Organization members and pending invitations, one page at a time, newest first (Phase 4 C9).
 * Read from the console database; the caller has already checked who may see the organization.
 */
import { type SQL, and, count, desc, eq, ilike, or } from 'drizzle-orm'

import { DEFAULT_PAGE_SIZE, type Page, likeContains } from '@/lib/list-search'
import { accountState } from '@/lib/sign-in-rules'

import { consoleDb } from './db.server'
import { invitation, member, user } from './db/auth-schema'

interface PeopleQuery {
  page?: number
  pageSize?: number
  q?: string
  role?: string
}

const paging = (query: PeopleQuery) => {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export async function listOrganizationMembers(organizationId: string, query: PeopleQuery) {
  const { db } = consoleDb()
  const { page, pageSize, offset } = paging(query)
  const filters: SQL[] = [eq(member.organizationId, organizationId)]
  if (query.role) filters.push(eq(member.role, query.role))
  if (query.q) filters.push(or(ilike(user.name, likeContains(query.q)), ilike(user.email, likeContains(query.q)))!)
  const where = and(...filters)
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ id: member.id, userId: user.id, name: user.name, email: user.email, role: member.role, since: member.createdAt, twoFactorEnabled: user.twoFactorEnabled, lastSignInAt: user.lastSignInAt, banned: user.banned, banReason: user.banReason, lockedUntil: user.lockedUntil })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(where)
      .orderBy(desc(member.createdAt), desc(member.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(member).innerJoin(user, eq(user.id, member.userId)).where(where),
  ])
  // implement/24: locked after wrong passwords, or disabled for not signing in.
  const items = rows.map(({ banned, banReason, lockedUntil, ...m }) => ({ ...m, since: m.since.toISOString(), twoFactorEnabled: Boolean(m.twoFactorEnabled), lastSignInAt: m.lastSignInAt?.toISOString() ?? null, state: accountState({ banned, banReason, lockedUntil }) }))
  return { items, total, page, pageSize } satisfies Page<(typeof items)[number]>
}

export async function listOrganizationInvitations(organizationId: string, query: PeopleQuery) {
  const { db } = consoleDb()
  const { page, pageSize, offset } = paging(query)
  const filters: SQL[] = [eq(invitation.organizationId, organizationId), eq(invitation.status, 'pending')]
  if (query.role) filters.push(eq(invitation.role, query.role))
  if (query.q) filters.push(ilike(invitation.email, likeContains(query.q)))
  const where = and(...filters)
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt, createdAt: invitation.createdAt })
      .from(invitation)
      .where(where)
      .orderBy(desc(invitation.createdAt), desc(invitation.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(invitation).where(where),
  ])
  const now = Date.now()
  const items = rows.map((i) => ({ ...i, role: i.role ?? 'member', expired: i.expiresAt.getTime() < now, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() }))
  return { items, total, page, pageSize } satisfies Page<(typeof items)[number]>
}

/** The account behind a membership of this organization; null when the membership is elsewhere or gone. */
export async function memberAccount(organizationId: string, memberId: string) {
  const [row] = await consoleDb()
    .db.select({ userId: user.id, email: user.email, role: user.role, banned: user.banned, banReason: user.banReason })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.id, memberId), eq(member.organizationId, organizationId)))
  return row ?? null
}
