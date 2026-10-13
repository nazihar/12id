/**
 * Console side of Phase 7 H1:
 *   - an API key an operator creates for a tenant is announced to the tenant's owners by mail, so an
 *     operator can never act as a tenant's integration without the tenant knowing;
 *   - expired Better Auth rows (sessions, verification tokens, rate-limit counters) are deleted on a
 *     timer, so the console database keeps no sign-in history beyond what is live;
 *   - on the same timer (implement/24): sessions idle past CONSOLE_IDLE_TIMEOUT_MINUTES are deleted, and
 *     accounts unused for CONSOLE_INACTIVITY_DAYS are disabled with a notice by mail.
 */
import { and, eq, lt, or, sql } from 'drizzle-orm'

import { consoleDb } from './db.server'
import { member, organization, rateLimit, session, user, verification } from './db/auth-schema'
import { sendMail } from './email.server'
import { serverEnv } from './env.server'
import { disableInactiveAccounts } from './sign-in-rules.server'

/** Mails every owner of the tenant's organization. Best effort: a mail failure never undoes the key. */
export async function notifyOwnersOfOperatorKey(input: { tenantId: string; label: string; operatorUserId: string }) {
  const { db } = consoleDb()
  try {
    const [org] = await db.select({ id: organization.id, name: organization.name, slug: organization.slug }).from(organization).where(eq(organization.platformTenantId, input.tenantId))
    if (!org) return 0
    const owners = await db
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, org.id), eq(member.role, 'owner')))
    const [operator] = await db.select({ email: user.email }).from(user).where(eq(user.id, input.operatorUserId))
    const url = `${serverEnv().BETTER_AUTH_URL.replace(/\/$/, '')}/t/${org.slug}/api-keys`
    for (const owner of owners) {
      await sendMail({
        to: owner.email,
        subject: `A 12iD operator created an API key for ${org.name}`,
        text: [
          `A 12iD platform operator${operator ? ` (${operator.email})` : ''} created the API key "${input.label}" for ${org.name} on ${new Date().toISOString()}.`,
          '',
          'The key can run your integration: offer credentials, request proofs and read your exchanges.',
          'It is marked "Created by operator" on your API keys page. If you did not ask for it, revoke it there and contact 12iD support:',
          url,
        ].join('\n'),
      })
    }
    return owners.length
  } catch (error) {
    console.error('could not notify tenant owners of an operator-created API key', error)
    return 0
  }
}

/** Deletes expired and idle sessions, expired verification tokens, and rate-limit counters idle for a day. */
export async function purgeExpiredAuthRows(now = new Date()) {
  const { db } = consoleDb()
  const idleSince = new Date(now.getTime() - serverEnv().CONSOLE_IDLE_TIMEOUT_MINUTES * 60 * 1000)
  const sessions = await db.delete(session).where(or(lt(session.expiresAt, now), lt(sql`coalesce(${session.lastActiveAt}, ${session.createdAt})`, idleSince)))
  const verifications = await db.delete(verification).where(lt(verification.expiresAt, now))
  const limits = await db.delete(rateLimit).where(lt(rateLimit.lastRequest, now.getTime() - 24 * 60 * 60 * 1000))
  return { sessions: sessions.rowCount ?? 0, verifications: verifications.rowCount ?? 0, rateLimits: limits.rowCount ?? 0 }
}

const HOUSEKEEPING = Symbol.for('12id.console.authHousekeeping')

/** Starts the hourly purge once per process (idempotent; the timer does not keep the process alive). */
export function startAuthHousekeeping(intervalMs = 60 * 60 * 1000) {
  const global = globalThis as { [HOUSEKEEPING]?: NodeJS.Timeout }
  if (global[HOUSEKEEPING] || serverEnv().NODE_ENV === 'test') return
  const run = () => {
    void purgeExpiredAuthRows().then(
      (removed) => {
        if (removed.sessions + removed.verifications + removed.rateLimits > 0) console.info('[auth-housekeeping]', JSON.stringify(removed))
      },
      (error: unknown) => console.error('[auth-housekeeping] purge failed', error)
    )
    void disableInactiveAccounts().then(
      (disabled) => {
        if (disabled > 0) console.info('[auth-housekeeping]', JSON.stringify({ disabledInactive: disabled }))
      },
      (error: unknown) => console.error('[auth-housekeeping] inactivity pass failed', error)
    )
  }
  global[HOUSEKEEPING] = setInterval(run, intervalMs)
  global[HOUSEKEEPING].unref()
  setTimeout(run, 60_000).unref()
}
