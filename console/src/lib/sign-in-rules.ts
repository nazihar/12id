/**
 * The sign-in rules as pure functions (implement/24-console-sign-in.md), so they can be tested
 * without Better Auth or a database. The settings come from the server environment
 * (`CONSOLE_*` in env.server.ts); the server applies these, the client only shows their effect.
 */
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

/** How long before the idle sign-out the warning appears. */
export const IDLE_WARNING_MS = 2 * MINUTE
/** The client reports activity at most this often; the server needs no finer grain. */
export const ACTIVITY_REPORT_MS = MINUTE

/** True when a session has seen no activity for longer than the limit. A session without a record counts from its creation. */
export function sessionIdle(lastActiveAt: Date | string | null | undefined, createdAt: Date | string, idleMinutes: number, now = Date.now()) {
  const last = new Date(lastActiveAt ?? createdAt).getTime()
  return now - last > idleMinutes * MINUTE
}

/** True when the password must be changed before anything else. `maxAgeDays` 0 turns the rule off. */
export function passwordExpired(changedAt: Date | string | null | undefined, maxAgeDays: number, now = Date.now()) {
  if (maxAgeDays === 0 || !changedAt) return false
  return now - new Date(changedAt).getTime() > maxAgeDays * DAY
}

/** True while an account is locked after wrong passwords. */
export function accountLocked(lockedUntil: Date | string | null | undefined, now = Date.now()) {
  return lockedUntil ? new Date(lockedUntil).getTime() > now : false
}

/** The wait added before a sign-in is checked, after `failures` wrong passwords in a row: 1 s each, at most 5 s (MTB 2.36). */
export function signInDelayMs(failures: number) {
  return Math.min(Math.max(failures, 0), 5) * 1000
}

/** After one more wrong password: the new count, and the lock if it reached the threshold (the count then starts again). */
export function afterWrongPassword(failures: number, threshold: number, lockMinutes: number, now = Date.now()): { failures: number; lockedUntil: Date | null } {
  const next = failures + 1
  if (next >= threshold) return { failures: 0, lockedUntil: new Date(now + lockMinutes * MINUTE) }
  return { failures: next, lockedUntil: null }
}

/** True when an account has not signed in for longer than the limit. Never signed in counts from its creation. `days` 0 turns the rule off. */
export function accountInactive(lastSignInAt: Date | string | null | undefined, createdAt: Date | string, days: number, now = Date.now()) {
  if (days === 0) return false
  return now - new Date(lastSignInAt ?? createdAt).getTime() > days * DAY
}

/** The ban reason the inactivity pass writes; an owner may lift only a ban with this reason (implement/24). */
export const INACTIVE_BAN_PREFIX = 'inactive:'

/** The states the accounts lists show and filter by, in that order. */
export const ACCOUNT_STATES = ['active', 'locked', 'disabled', 'inactive'] as const
export type AccountState = (typeof ACCOUNT_STATES)[number]

/**
 * One state for the accounts lists: disabled for inactivity, disabled by a person (until a date or
 * until re-enabled, implement/26), locked after wrong passwords, or active. A disable whose date has
 * passed reads as active: Better Auth lifts it at the next sign-in.
 */
export function accountState(account: { banned?: boolean | null; banReason?: string | null; banExpires?: Date | string | null; lockedUntil?: Date | string | null }, now = Date.now()): AccountState {
  if (account.banned && !(account.banExpires && new Date(account.banExpires).getTime() <= now)) return account.banReason?.startsWith(INACTIVE_BAN_PREFIX) ? 'inactive' : 'disabled'
  return accountLocked(account.lockedUntil, now) ? 'locked' : 'active'
}

/** True while an owner's disable of one membership holds (implement/26): since `disabledAt`, until `disabledUntil` or for good. */
export function membershipDisabled(membership: { disabledAt?: Date | string | null; disabledUntil?: Date | string | null }, now = Date.now()) {
  if (!membership.disabledAt) return false
  return !membership.disabledUntil || new Date(membership.disabledUntil).getTime() > now
}
