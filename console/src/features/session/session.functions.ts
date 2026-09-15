/**
 * The caller's own identity, for route guards (UX). Deliberately without auth middleware: it answers
 * only about the caller's session and returns no tenant or platform data, so an anonymous call just
 * gets `null`. Data access stays behind operator/tenant middleware.
 */
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders, setResponseHeader } from '@tanstack/react-start/server'

import { OPERATOR_ROLE, hasPlatformRole } from '@/lib/permissions'
import { auth } from '@/server/auth.server'

export type Viewer = {
  userId: string
  name: string
  email: string
  isOperator: boolean
  twoFactorEnabled: boolean
  activeOrganizationId: string | null
} | null

export const getViewer = createServerFn({ method: 'GET' }).handler(async (): Promise<Viewer> => {
  setResponseHeader('Cache-Control', 'no-store')
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!session) return null
  return {
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    isOperator: hasPlatformRole(session.user.role, OPERATOR_ROLE),
    twoFactorEnabled: Boolean(session.user.twoFactorEnabled),
    activeOrganizationId: session.session.activeOrganizationId ?? null,
  }
})
