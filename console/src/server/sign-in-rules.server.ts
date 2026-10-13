/**
 * The console's sign-in rules on the server (implement/24-console-sign-in.md): the password policy
 * with the common-word list and the last three passwords, the lock after wrong passwords, one
 * session per account, the idle timeout and the pass that disables unused accounts. The rules
 * themselves are pure (lib/sign-in-rules.ts, lib/password-policy.ts); this file applies them to the
 * console database. auth.server.ts calls it from Better Auth's hooks.
 *
 * Relative imports only (the Better Auth CLI loads the auth chain outside Vite).
 */
import { randomUUID } from 'node:crypto'

import { and, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm'

import { passwordProblems } from '../lib/password-policy'
import { INACTIVE_BAN_PREFIX, accountLocked, afterWrongPassword } from '../lib/sign-in-rules'
import { type AuditActor, actorOf, recordEvent } from './audit.server'
import { COMMON_WORDS_SOURCE } from './common-passwords.data.server'
import { consoleDb } from './db.server'
import { account, passwordHistory, session, user } from './db/auth-schema'
import { sendMail } from './email.server'
import { serverEnv } from './env.server'

/** How many passwords an account keeps in its history, the current one included (MTB 2.22). */
export const PASSWORD_HISTORY = 3

let commonWords: Set<string> | undefined
const LOOK_ALIKES: Record<string, string> = { '@': 'a', '4': 'a', '0': 'o', '1': 'i', '!': 'i', '3': 'e', $: 's', '5': 's', '7': 't', '+': 't' }

/** A common word inside the password, read the way the list was made (look-alikes as letters). */
export function commonWordIn(password: string): string | null {
  commonWords ??= new Set(COMMON_WORDS_SOURCE.split(' '))
  const read = [...password.toLowerCase()].map((c) => LOOK_ALIKES[c] ?? c).join('')
  for (const run of read.split(/[^a-z]+/)) {
    if (run.length < 4) continue
    if (commonWords.has(run)) return run
    // A long common word inside a longer run ("mypassword"): only words of 6 letters or more, or every
    // short word would refuse half the dictionary.
    for (let start = 0; start < run.length; start += 1) {
      for (let end = run.length; end - start >= 6; end -= 1) {
        if (commonWords.has(run.slice(start, end))) return run.slice(start, end)
      }
    }
  }
  return null
}

/** Every rule the server applies to a new password, as messages. */
export function serverPasswordProblems(password: string, context: { email?: string; name?: string }): string[] {
  const problems = passwordProblems(password, context)
  if (commonWordIn(password)) problems.push('Avoid common words and passwords, also with letters swapped for digits or symbols.')
  return problems
}

type Verify = (input: { hash: string; password: string }) => Promise<boolean>

/** True when the password is one of the account's last three (MTB 2.22). */
export async function passwordReused(userId: string, password: string, verify: Verify): Promise<boolean> {
  const { db } = consoleDb()
  const [current] = await db.select({ hash: account.password }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
  const history = await db.select({ hash: passwordHistory.hash }).from(passwordHistory).where(eq(passwordHistory.userId, userId)).orderBy(desc(passwordHistory.createdAt)).limit(PASSWORD_HISTORY)
  const hashes = new Set([current?.hash, ...history.map((row) => row.hash)].filter((hash): hash is string => Boolean(hash)))
  for (const hash of hashes) {
    if (await verify({ hash, password }).catch(() => false)) return true
  }
  return false
}

/** After a password was set: keep its hash in the history (three per account) and restart its age. */
export async function rememberPassword(userId: string): Promise<void> {
  const { db } = consoleDb()
  const [current] = await db.select({ hash: account.password }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
  await db.transaction(async (tx) => {
    if (current?.hash) await tx.insert(passwordHistory).values({ id: randomUUID(), userId, hash: current.hash })
    const keep = tx.select({ id: passwordHistory.id }).from(passwordHistory).where(eq(passwordHistory.userId, userId)).orderBy(desc(passwordHistory.createdAt)).limit(PASSWORD_HISTORY)
    await tx.delete(passwordHistory).where(and(eq(passwordHistory.userId, userId), notInArray(passwordHistory.id, keep)))
    await tx.update(user).set({ passwordChangedAt: new Date() }).where(eq(user.id, userId))
  })
}

type LockFacts = { id: string; email: string; role: string | null; failedSignIns: number; lockedUntil: Date | null }

/** The account an email signs in to, with its lock state; null when there is none. */
export async function lockFactsFor(email: string): Promise<LockFacts | null> {
  const [row] = await consoleDb()
    .db.select({ id: user.id, email: user.email, role: user.role, failedSignIns: user.failedSignIns, lockedUntil: user.lockedUntil })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email.trim().toLowerCase()))
  return row ?? null
}

export const isLocked = (facts: LockFacts | null) => accountLocked(facts?.lockedUntil)

/** One more wrong password: count it, and lock the account at the threshold (MTB 2.26). */
export async function countWrongPassword(facts: LockFacts, detail: Record<string, unknown>): Promise<void> {
  const env = serverEnv()
  const next = afterWrongPassword(facts.failedSignIns, env.CONSOLE_LOCK_THRESHOLD, env.CONSOLE_LOCK_MINUTES)
  await consoleDb().db.update(user).set({ failedSignIns: next.failures, ...(next.lockedUntil ? { lockedUntil: next.lockedUntil } : {}) }).where(eq(user.id, facts.id))
  if (next.lockedUntil) {
    await consoleDb().db.delete(session).where(eq(session.userId, facts.id))
    await recordEvent({ type: 'auth.locked', outcome: 'failure', actor: actorOf(facts), detail: { ...detail, until: next.lockedUntil.toISOString(), afterWrongPasswords: env.CONSOLE_LOCK_THRESHOLD } })
  }
}

/** The password was right: the count starts again. */
export async function clearWrongPasswords(userId: string): Promise<void> {
  await consoleDb().db.update(user).set({ failedSignIns: 0 }).where(and(eq(user.id, userId), ne(user.failedSignIns, 0)))
}

/** Unlock at once (an operator, or an owner for a member). */
export async function unlockAccount(userId: string, by: AuditActor, account: string | null): Promise<boolean> {
  const [row] = await consoleDb().db.update(user).set({ failedSignIns: 0, lockedUntil: null }).where(eq(user.id, userId)).returning({ id: user.id })
  if (row) await recordEvent({ type: 'account.unlocked', actor: by, detail: { account, userId } })
  return Boolean(row)
}

/**
 * A completed sign-in: one session per account (MTB 2.24), the new session counts as active, and
 * an expired password is noted. Called only when the sign-in is complete, never for the provisional
 * session a password creates before its second factor: a password alone must not end anyone's session.
 */
export async function afterCompletedSignIn(signedIn: { id: string; email: string; role?: string | null }, sessionToken: string, detail: Record<string, unknown>): Promise<void> {
  const { db } = consoleDb()
  await db.update(session).set({ lastActiveAt: new Date() }).where(eq(session.token, sessionToken))
  const ended = await db.delete(session).where(and(eq(session.userId, signedIn.id), ne(session.token, sessionToken))).returning({ id: session.id })
  if (ended.length > 0) await recordEvent({ type: 'auth.session_replaced', actor: actorOf(signedIn), detail: { ...detail, ended: ended.length } })
  await db.update(user).set({ failedSignIns: 0, lockedUntil: null }).where(eq(user.id, signedIn.id))
}

/** Ends a session that sat idle, and says so in the audit (MTB 2.25). */
export async function endIdleSession(token: string, signedIn: { id: string; email: string; role?: string | null }): Promise<void> {
  const ended = await consoleDb().db.delete(session).where(eq(session.token, token)).returning({ id: session.id })
  if (ended.length > 0) await recordEvent({ type: 'auth.idle_sign_out', actor: actorOf(signedIn), detail: { idleMinutes: serverEnv().CONSOLE_IDLE_TIMEOUT_MINUTES } })
}

/** The person did something: their session stays alive. */
export async function touchSession(token: string): Promise<void> {
  await consoleDb().db.update(session).set({ lastActiveAt: new Date() }).where(eq(session.token, token))
}

/**
 * Disables accounts that have not signed in for `CONSOLE_INACTIVITY_DAYS` (MTB 2.28) and mails each
 * a notice. An account that never signed in counts from its creation. Run with the hourly housekeeping.
 */
export async function disableInactiveAccounts(now = new Date()): Promise<number> {
  const days = serverEnv().CONSOLE_INACTIVITY_DAYS
  if (days === 0) return 0
  const { db } = consoleDb()
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const reason = `${INACTIVE_BAN_PREFIX} no sign-in for ${days} days`
  const disabled = await db
    .update(user)
    .set({ banned: true, banReason: reason, banExpires: null })
    .where(and(or(isNull(user.banned), eq(user.banned, false)), lt(sql`coalesce(${user.lastSignInAt}, ${user.createdAt})`, cutoff)))
    .returning({ id: user.id, email: user.email, name: user.name, role: user.role })
  if (disabled.length === 0) return 0
  await db.delete(session).where(inArray(session.userId, disabled.map((row) => row.id)))
  for (const row of disabled) {
    await recordEvent({ type: 'account.disabled_inactive', actor: actorOf(row), detail: { days } })
    await sendMail({
      to: row.email,
      subject: 'Your 12id Console account was disabled',
      text: `Your 12id Console account (${row.email}) has not been used for ${days} days, so it was disabled.\n\nTo use it again, ask your organization's owner or a 12id operator to re-enable it.`,
    }).catch((error: unknown) => console.error('[auth] inactivity notice not sent', error))
  }
  return disabled.length
}
