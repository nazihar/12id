/**
 * Organization members and pending invitations, one page at a time, newest first (Phase 4 C9).
 * Read from the console database; the caller has already checked who may see the organization.
 */
import { type SQL, and, count, desc, eq, ilike, or, sql } from 'drizzle-orm'

import { DEFAULT_PAGE_SIZE, type Page, likeContains } from '@/lib/list-search'
import { isBuiltInTenantRole } from '@/lib/permissions'
import { type AccountState, accountState, membershipDisabled } from '@/lib/sign-in-rules'

import { stateCondition } from './access-report.server'
import { consoleDb } from './db.server'
import { invitation, member, user } from './db/auth-schema'
import { customRoles, memberRoleNames } from './permissions.server'
import { BUILT_IN_ROLE_TEXT } from './roles.server'

interface PeopleQuery {
  page?: number
  pageSize?: number
  q?: string
  role?: string
  state?: AccountState
}

/** Role names as people see them, built-in and custom (implement/26). */
async function roleLabeller(organizationId: string) {
  const custom = await customRoles(organizationId)
  const one = (name: string) => (isBuiltInTenantRole(name) ? BUILT_IN_ROLE_TEXT[name].label : (custom.find((role) => role.role === name)?.label ?? name))
  return (value: string) => memberRoleNames(value).map(one).join(', ')
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
  // One of the member's roles (Better Auth keeps several as "a,b").
  if (query.role) filters.push(sql`${query.role} = any(string_to_array(replace(${member.role}, ' ', ''), ','))`)
  if (query.state) filters.push(stateCondition(query.state, true))
  if (query.q) filters.push(or(ilike(user.name, likeContains(query.q)), ilike(user.email, likeContains(query.q)))!)
  const where = and(...filters)
  const [rows, [{ total }], label] = await Promise.all([
    db
      .select({ id: member.id, userId: user.id, name: user.name, email: user.email, role: member.role, since: member.createdAt, twoFactorEnabled: user.twoFactorEnabled, lastSignInAt: user.lastSignInAt, banned: user.banned, banReason: user.banReason, banExpires: user.banExpires, lockedUntil: user.lockedUntil, disabledAt: member.disabledAt, disabledUntil: member.disabledUntil, disabledNote: member.disabledNote })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(where)
      .orderBy(desc(member.createdAt), desc(member.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(member).innerJoin(user, eq(user.id, member.userId)).where(where),
    roleLabeller(organizationId),
  ])
  // implement/24: locked after wrong passwords, or disabled for not signing in. implement/26: or this
  // membership disabled by an owner, which shows its date and note.
  const items = rows.map(({ banned, banReason, banExpires, lockedUntil, disabledAt, disabledUntil, disabledNote, ...m }) => {
    const membership = membershipDisabled({ disabledAt, disabledUntil })
    return {
      ...m,
      roleLabel: label(m.role),
      since: m.since.toISOString(),
      twoFactorEnabled: Boolean(m.twoFactorEnabled),
      lastSignInAt: m.lastSignInAt?.toISOString() ?? null,
      state: membership ? ('disabled' as const) : accountState({ banned, banReason, banExpires, lockedUntil }),
      disabled: membership ? { scope: 'membership' as const, until: disabledUntil?.toISOString() ?? null, note: disabledNote ?? '' } : null,
    }
  })
  return { items, total, page, pageSize } satisfies Page<(typeof items)[number]>
}

export async function listOrganizationInvitations(organizationId: string, query: PeopleQuery) {
  const { db } = consoleDb()
  const { page, pageSize, offset } = paging(query)
  const filters: SQL[] = [eq(invitation.organizationId, organizationId), eq(invitation.status, 'pending')]
  if (query.role) filters.push(eq(invitation.role, query.role))
  if (query.q) filters.push(ilike(invitation.email, likeContains(query.q)))
  const where = and(...filters)
  const [rows, [{ total }], label] = await Promise.all([
    db
      .select({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt, createdAt: invitation.createdAt })
      .from(invitation)
      .where(where)
      .orderBy(desc(invitation.createdAt), desc(invitation.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(invitation).where(where),
    roleLabeller(organizationId),
  ])
  const now = Date.now()
  const items = rows.map((i) => ({ ...i, role: i.role ?? 'member', roleLabel: label(i.role ?? 'member'), expired: i.expiresAt.getTime() < now, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() }))
  return { items, total, page, pageSize } satisfies Page<(typeof items)[number]>
}

/** The account behind a membership of this organization; null when the membership is elsewhere or gone. */
export async function memberAccount(organizationId: string, memberId: string) {
  const [row] = await consoleDb()
    .db.select({ userId: user.id, email: user.email, role: user.role, banned: user.banned, banReason: user.banReason, disabledAt: member.disabledAt, disabledUntil: member.disabledUntil })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.id, memberId), eq(member.organizationId, organizationId)))
  return row ?? null
}
