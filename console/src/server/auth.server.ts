/**
 * Better Auth for the console (Phase 4, implement/11-phase-4.md).
 *
 * - Invite-only: sign-up is disabled for every caller. Invitees get an account from a server
 *   function that validates the invitation and calls `auth.api.createUser` without request headers
 *   (the admin plugin allows that server-side call); the first operator comes from the CLI.
 * - 2FA for everyone, enforced by the console middleware (Better Auth makes it opt-in per user).
 *   Methods: TOTP or email OTP. Operators are TOTP-only: email OTP offers itself to every 2FA user at
 *   sign-in once `sendOTP` exists, so the after-hook below refuses a session obtained through it.
 * - Tenants are organizations carrying the platform tenant id; users never create organizations.
 */
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { admin, organization, twoFactor } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { eq } from 'drizzle-orm'

import { OPERATOR_ROLE, hasPlatformRole, platformAc, platformRoles, tenantAc, tenantRoles } from '../lib/permissions'
import { consoleDb } from './db.server'
import * as schema from './db/auth-schema'
import { sendMail } from './email.server'
import { serverEnv } from './env.server'

const env = serverEnv()

export const auth = betterAuth({
  appName: '12id Console',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(consoleDb().db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    revokeSessionsOnPasswordReset: true,
    // The link reached the mailbox, so the address is verified; accepting organization invitations requires it.
    onPasswordReset: async ({ user }) => {
      await consoleDb().db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, user.id))
    },
    // Also the first-password link for accounts an operator created (tenant owners), so the wording covers both.
    sendResetPassword: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: 'Set your 12id Console password',
        text: `Choose a password for your 12id Console account (${user.email}):\n${url}\n\nThe link works once and expires in one hour. If you did not expect this email, ignore it.`,
      })
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    storage: 'database',
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/two-factor/verify-otp') return
      const created = ctx.context.newSession
      if (created && hasPlatformRole((created.user as { role?: string }).role, OPERATOR_ROLE)) {
        await ctx.context.internalAdapter.deleteSession(created.session.token)
        throw new APIError('FORBIDDEN', { message: 'operators must use an authenticator app' })
      }
    }),
  },
  plugins: [
    organization({
      ac: tenantAc,
      roles: tenantRoles,
      allowUserToCreateOrganization: false,
      disableOrganizationDeletion: true,
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: true,
      schema: {
        organization: {
          additionalFields: {
            platformTenantId: { type: 'string', required: true, unique: true, input: true },
          },
        },
      },
      organizationHooks: {
        beforeCreateOrganization: async ({ organization: created }) => {
          if (typeof created.platformTenantId !== 'string' || created.platformTenantId.length === 0) {
            throw new APIError('BAD_REQUEST', { message: 'an organization needs its platform tenant id' })
          }
        },
      },
      sendInvitationEmail: async ({ id, email, organization: invitedTo, inviter }) => {
        await sendMail({
          to: email,
          subject: `You are invited to ${invitedTo.name} on the 12id Console`,
          text: `${inviter.user.name} invited you to ${invitedTo.name}.\n\nAccept the invitation:\n${env.BETTER_AUTH_URL}/invite/${id}\n\nThe link expires in 48 hours.`,
        })
      },
    }),
    twoFactor({
      issuer: '12id Console',
      otpOptions: {
        storeOTP: 'hashed',
        sendOTP: async ({ user, otp }) => {
          await sendMail({ to: user.email, subject: 'Your 12id Console sign-in code', text: `Your sign-in code is ${otp}. It expires in 3 minutes.` })
        },
      },
    }),
    admin({
      ac: platformAc,
      roles: platformRoles,
      adminRoles: [OPERATOR_ROLE],
      defaultRole: 'user',
    }),
    // Must stay last: it sets the cookies of every endpoint above through TanStack Start.
    tanstackStartCookies(),
  ],
})

export type Auth = typeof auth
