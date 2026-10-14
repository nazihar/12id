/**
 * Who has access and in what state (implement/26): the state filter of the accounts lists, the
 * access report above them, and who is signed in now. Two scopes: the operator area's accounts, and
 * one organization's members, where a membership its owner disabled counts as disabled.
 *
 * The states are those of `accountState` (lib/sign-in-rules.ts), written as SQL so a list can filter
 * by them and the report can count them in one query.
 */
import { type SQL, and, desc, eq, gt, inArray, sql } from 'drizzle-orm'

import { STAFF_ROLES } from '@/lib/permissions'
import { type AccountState, INACTIVE_BAN_PREFIX } from '@/lib/sign-in-rules'

import { consoleDb } from './db.server'
import { member, session, user } from './db/auth-schema'
import { serverEnv } from './env.server'
import { memberRoleNames } from './permissions.server'

const inactiveBan = sql`(${user.banned} is true and coalesce(${user.banReason}, '') like ${`${INACTIVE_BAN_PREFIX}%`})`
const personBan = sql`(${user.banned} is true and coalesce(${user.banReason}, '') not like ${`${INACTIVE_BAN_PREFIX}%`} and (${user.banExpires} is null or ${user.banExpires} > now()))`
const membershipOff = sql`(${member.disabledAt} is not null and (${member.disabledUntil} is null or ${member.disabledUntil} > now()))`
const locked = sql`(${user.lockedUntil} is not null and ${user.lockedUntil} > now())`

/** The SQL for one state. `membership`: the organization scope, where an owner's disable counts too. */
export function stateCondition(state: AccountState, membership: boolean): SQL {
  const disabled = membership ? sql`(${personBan} or ${membershipOff})` : personBan
  switch (state) {
    case 'inactive':
      return inactiveBan
    case 'disabled':
      return sql`(not ${inactiveBan} and ${disabled})`
    case 'locked':
      return sql`(not ${inactiveBan} and not ${disabled} and ${locked})`
    case 'active':
      return sql`(not ${inactiveBan} and not ${disabled} and not ${locked})`
  }
}

/** A live session that has not sat idle: the person is signed in now. */
const liveSession = () => {
  const idleMinutes = serverEnv().CONSOLE_IDLE_TIMEOUT_MINUTES
  return sql`(${session.expiresAt} > now() and coalesce(${session.lastActiveAt}, ${session.createdAt}) > now() - make_interval(mins => ${idleMinutes}))`
}
const signedInNow = () => sql`exists (select 1 from ${session} where ${session.userId} = ${user.id} and ${liveSession()})`

export interface AccessReport {
  total: number
  active: number
  locked: number
  disabled: number
  inactive: number
  neverSignedIn: number
  withoutTwoFactor: number
  signedInNow: number
  byRole: { role: string; count: number }[]
}

const counts = (membership: boolean) => ({
  total: sql<number>`count(*)::int`,
  active: sql<number>`(count(*) filter (where ${stateCondition('active', membership)}))::int`,
  locked: sql<number>`(count(*) filter (where ${stateCondition('locked', membership)}))::int`,
  disabled: sql<number>`(count(*) filter (where ${stateCondition('disabled', membership)}))::int`,
  inactive: sql<number>`(count(*) filter (where ${stateCondition('inactive', membership)}))::int`,
  neverSignedIn: sql<number>`(count(*) filter (where ${user.lastSignInAt} is null))::int`,
  withoutTwoFactor: sql<number>`(count(*) filter (where ${user.twoFactorEnabled} is not true))::int`,
  signedInNow: sql<number>`(count(*) filter (where ${signedInNow()}))::int`,
})

/** The operator area's accounts. An account with several roles counts once, under its strongest. */
export async function staffAccessReport(): Promise<AccessReport> {
  const { db } = consoleDb()
  const where = inArray(user.role, [...STAFF_ROLES])
  const [[totals], roles] = await Promise.all([db.select(counts(false)).from(user).where(where), db.select({ role: user.role, count: sql<number>`count(*)::int` }).from(user).where(where).groupBy(user.role)])
  return { ...totals, byRole: roles.map((row) => ({ role: row.role ?? 'operator', count: row.count })) }
}

/** One organization's members; a member holding several roles counts under each. */
export async function memberAccessReport(organizationId: string): Promise<AccessReport> {
  const { db } = consoleDb()
  const where = eq(member.organizationId, organizationId)
  const [[totals], roles] = await Promise.all([
    db.select(counts(true)).from(member).innerJoin(user, eq(user.id, member.userId)).where(where),
    db.select({ role: member.role }).from(member).where(where),
  ])
  const byRole = new Map<string, number>()
  for (const row of roles) for (const name of memberRoleNames(row.role)) byRole.set(name, (byRole.get(name) ?? 0) + 1)
  return { ...totals, byRole: [...byRole].map(([role, count]) => ({ role, count })) }
}

/** Who is signed in now, newest activity first (MTB 6.106). The session id lets an operator end one. */
export async function liveSessions(scope: { staff: true } | { organizationId: string }) {
  const { db } = consoleDb()
  const fields = { sessionId: session.id, userId: user.id, name: user.name, email: user.email, role: user.role, signedInAt: session.createdAt, lastActiveAt: session.lastActiveAt, ipAddress: session.ipAddress, userAgent: session.userAgent }
  const base = and(gt(session.expiresAt, sql`now()`), liveSession())
  const rows =
    'staff' in scope
      ? await db.select(fields).from(session).innerJoin(user, eq(user.id, session.userId)).where(and(base, inArray(user.role, [...STAFF_ROLES]))).orderBy(desc(sql`coalesce(${session.lastActiveAt}, ${session.createdAt})`)).limit(200)
      : await db
          .select({ ...fields, role: member.role })
          .from(session)
          .innerJoin(user, eq(user.id, session.userId))
          .innerJoin(member, and(eq(member.userId, user.id), eq(member.organizationId, scope.organizationId)))
          .where(base)
          .orderBy(desc(sql`coalesce(${session.lastActiveAt}, ${session.createdAt})`))
          .limit(200)
  return rows.map((row) => ({ ...row, role: row.role ?? '', signedInAt: row.signedInAt.toISOString(), lastActiveAt: (row.lastActiveAt ?? row.signedInAt).toISOString() }))
}
