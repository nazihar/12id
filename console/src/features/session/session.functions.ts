/**
 * The caller's own identity, for route guards (UX). Deliberately without auth middleware: it answers
 * only about the caller's session and returns no tenant or platform data, so an anonymous call just
 * gets `null`. Data access stays behind operator/tenant middleware.
 */
import { createServerFn } from '@tanstack/react-start'
import { getCookie, getRequestHeaders, setResponseHeader } from '@tanstack/react-start/server'
import { z } from 'zod'

import { AUDITOR_ROLE, OPERATOR_ROLE, sessionExpired, staffRoleOf } from '@/lib/permissions'
import { passwordExpired, sessionIdle } from '@/lib/sign-in-rules'
import { auth } from '@/server/auth.server'
import { captchaChallenge } from '@/server/captcha.server'
import { resetNeedsCode } from '@/server/sign-in-hooks.server'
import { serverEnv } from '@/server/env.server'
import { endIdleSession, touchSession as touch } from '@/server/sign-in-rules.server'

export type Viewer = {
  userId: string
  name: string
  email: string
  /** May change things in the operator area. */
  isOperator: boolean
  /** Reads the operator area and changes nothing (implement/22 C14). */
  isAuditor: boolean
  /** Operator or auditor: may open the operator area, 12 h sessions, authenticator app only. */
  isStaff: boolean
  twoFactorEnabled: boolean
  activeOrganizationId: string | null
  /** The password is older than CONSOLE_PASSWORD_MAX_AGE_DAYS: only the change form opens (implement/24). */
  passwordExpired: boolean
  /** CONSOLE_IDLE_TIMEOUT_MINUTES, for the warning before the idle sign-out. */
  idleTimeoutMinutes: number
} | null

export const getViewer = createServerFn({ method: 'GET' }).handler(async (): Promise<Viewer> => {
  setResponseHeader('Cache-Control', 'no-store')
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!session) return null
  // The session caps are ours, not Better Auth's: without this the cookie still looks valid to the
  // guards and every page would render, only for its server functions to refuse.
  if (sessionExpired(session.user.role, session.session.createdAt)) return null
  const env = serverEnv()
  if (sessionIdle(session.session.lastActiveAt, session.session.createdAt, env.CONSOLE_IDLE_TIMEOUT_MINUTES)) {
    await endIdleSession(session.session.token, session.user)
    return null
  }
  const staffRole = staffRoleOf(session.user.role)
  return {
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    isOperator: staffRole === OPERATOR_ROLE,
    isAuditor: staffRole === AUDITOR_ROLE,
    isStaff: staffRole !== null,
    twoFactorEnabled: Boolean(session.user.twoFactorEnabled),
    activeOrganizationId: session.session.activeOrganizationId ?? null,
    passwordExpired: passwordExpired(session.user.passwordChangedAt, env.CONSOLE_PASSWORD_MAX_AGE_DAYS),
    idleTimeoutMinutes: env.CONSOLE_IDLE_TIMEOUT_MINUTES,
  }
})

/**
 * The person is active (pointer or key, reported at most once a minute by the authed layout), or
 * the idle warning asks how things stand. Answers whether the session is still there and when it was
 * last active, so a second tab that saw no activity does not sign out a session the first tab kept.
 */
export const touchSession = createServerFn({ method: 'POST' })
  .validator(z.object({ active: z.boolean() }))
  .handler(async ({ data }): Promise<{ signedIn: boolean; lastActiveAt: string | null }> => {
    setResponseHeader('Cache-Control', 'no-store')
    const session = await auth.api.getSession({ headers: getRequestHeaders() })
    if (!session || sessionExpired(session.user.role, session.session.createdAt)) return { signedIn: false, lastActiveAt: null }
    const idleMinutes = serverEnv().CONSOLE_IDLE_TIMEOUT_MINUTES
    if (sessionIdle(session.session.lastActiveAt, session.session.createdAt, idleMinutes)) {
      await endIdleSession(session.session.token, session.user)
      return { signedIn: false, lastActiveAt: null }
    }
    if (data.active) {
      await touch(session.session.token)
      return { signedIn: true, lastActiveAt: new Date().toISOString() }
    }
    return { signedIn: true, lastActiveAt: new Date(session.session.lastActiveAt ?? session.session.createdAt).toISOString() }
  })

/** The sidebar's open/collapsed cookie (set by the sidebar itself), so the server renders the remembered state and the page does not jump. */
export const getShellPreferences = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'no-store')
  return { sidebarOpen: getCookie('sidebar_state') !== 'false' }
})

/** A captcha challenge for the login and forgot-password forms (implement/24). Signed; holds nothing about anyone. */
export const getCaptchaChallenge = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'no-store')
  return captchaChallenge()
})

/** Whether the reset page must also ask for the authenticator code (MTB 2.33). Needs the mailed link's token. */
export const getResetNeedsCode = createServerFn({ method: 'GET' })
  .validator(z.object({ token: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'no-store')
    return { needsCode: await resetNeedsCode(data.token) }
  })
