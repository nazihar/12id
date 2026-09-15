/**
 * Accepting an organization invitation (tenant portal). Public by necessity: the invitee usually has
 * no account yet. Both functions only act on a pending, unexpired invitation id, which is an
 * unguessable value delivered to the invited mailbox, and reveal nothing beyond what that mail says.
 */
import { createServerFn } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { auth } from '@/server/auth.server'
import { consoleDb } from '@/server/db.server'
import { invitation, organization, user } from '@/server/db/auth-schema'

const invitationInput = z.object({ invitationId: z.string().min(1).max(100) })

async function pendingInvitation(invitationId: string) {
  const { db } = consoleDb()
  const [row] = await db
    .select({ email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt, organizationName: organization.name })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(eq(invitation.id, invitationId))
  if (!row || row.status !== 'pending' || row.expiresAt.getTime() < Date.now()) return null
  const email = row.email.toLowerCase()
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email))
  return { email, role: row.role ?? 'member', organizationName: row.organizationName, accountExists: Boolean(existing) }
}

export const getInvitationPreview = createServerFn({ method: 'GET' })
  .validator(invitationInput)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'no-store')
    return pendingInvitation(data.invitationId)
  })

/** Creates the invitee's account. The email counts as verified: the invitation reached that mailbox. */
export const createInvitedAccount = createServerFn({ method: 'POST' })
  .validator(invitationInput.extend({ name: z.string().trim().min(1).max(200), password: z.string().min(12, 'use at least 12 characters').max(128) }))
  .handler(async ({ data }) => {
    const pending = await pendingInvitation(data.invitationId)
    if (!pending) throw new Error('This invitation has expired or was already used. Ask the organization owner for a new one.')
    if (pending.accountExists) throw new Error('An account already exists for this email. Sign in to accept the invitation.')
    // No request headers: a server-side call, which the admin plugin accepts without an admin session.
    await auth.api.createUser({ body: { email: pending.email, name: data.name, password: data.password, data: { emailVerified: true } } })
    return { email: pending.email }
  })
