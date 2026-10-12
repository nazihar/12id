/**
 * The caller's own identity, for route guards (UX). Deliberately without auth middleware: it answers
 * only about the caller's session and returns no tenant or platform data, so an anonymous call just
 * gets `null`. Data access stays behind operator/tenant middleware.
 */
import { createServerFn } from '@tanstack/react-start'
import { getCookie, getRequestHeaders, setResponseHeader } from '@tanstack/react-start/server'

import { AUDITOR_ROLE, OPERATOR_ROLE, sessionExpired, staffRoleOf } from '@/lib/permissions'
import { auth } from '@/server/auth.server'

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
} | null

export const getViewer = createServerFn({ method: 'GET' }).handler(async (): Promise<Viewer> => {
  setResponseHeader('Cache-Control', 'no-store')
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!session) return null
  // The session caps are ours, not Better Auth's: without this the cookie still looks valid to the
  // guards and every page would render, only for its server functions to refuse.
  if (sessionExpired(session.user.role, session.session.createdAt)) return null
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
  }
})

/** The sidebar's open/collapsed cookie (set by the sidebar itself), so the server renders the remembered state and the page does not jump. */
export const getShellPreferences = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'no-store')
  return { sidebarOpen: getCookie('sidebar_state') !== 'false' }
})
