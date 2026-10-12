/**
 * Reports Better Auth calls to the audit log (implement/22-console-feedback.md C13): sign-ins and
 * their failures, second-factor failures, 2FA setup, password resets, sign-outs and accepted
 * invitations. The rules are in auth-events.ts; this file gathers the facts from the hook context.
 *
 * Only calls that arrive over HTTP are reported. A server function that calls `auth.api.*` itself
 * (inviting an operator, creating an owner) reports its own, more specific event.
 * Not covered: a request Better Auth's rate limiter refuses (429) never reaches an endpoint or a hook.
 *
 * Relative imports only (the Better Auth CLI loads the auth chain outside Vite).
 */
import type { GenericEndpointContext } from 'better-auth'
import { getIP, getSessionFromCtx, isAPIError } from 'better-auth/api'
import { eq } from 'drizzle-orm'

import { type AuditActor, actorOf, recordEvent, requestFacts } from './audit.server'
import { authEventFor } from './auth-events'
import { consoleDb } from './db.server'
import { organization, user } from './db/auth-schema'

type SessionUser = { id: string; email: string; role?: string | null; twoFactorEnabled?: boolean | null }

/** The two-factor plugin's cookie for a sign-in that still needs its second factor (plugins/two-factor/constant.mjs). */
const TWO_FACTOR_COOKIE = 'two_factor'

const facts = (ctx: GenericEndpointContext) => requestFacts(ctx.request, ctx.request ? getIP(ctx.request, ctx.context.options) : null)

/** The account a sign-in is waiting on its second factor for, read the way the plugin reads it. */
async function pendingTwoFactorUser(ctx: GenericEndpointContext): Promise<SessionUser | null> {
  try {
    const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE)
    const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
    if (!signed) return null
    const pending = await ctx.context.internalAdapter.findVerificationValue(signed)
    return pending ? ((await ctx.context.internalAdapter.findUserById(pending.value)) as SessionUser | null) : null
  } catch {
    return null
  }
}

async function sessionUser(ctx: GenericEndpointContext): Promise<SessionUser | null> {
  const session = ctx.context.session ?? (await getSessionFromCtx(ctx).catch(() => null))
  return (session?.user as SessionUser | undefined) ?? null
}

async function tenantOfOrganization(organizationId: string | undefined): Promise<string | null> {
  if (!organizationId) return null
  const [row] = await consoleDb().db.select({ tenantId: organization.platformTenantId }).from(organization).where(eq(organization.id, organizationId))
  return row?.tenantId ?? null
}

/** Call from `hooks.after`. `refused` is set when our own check turned a successful call into a refusal. */
export async function reportAuthCall(ctx: GenericEndpointContext, refused?: { message: string }): Promise<void> {
  if (!ctx.request) return
  // What the endpoint answered: an APIError when it refused (api/dispatch.mjs sets it for after-hooks).
  const returned = (ctx.context as { returned?: unknown }).returned
  const error = refused ?? (isAPIError(returned) ? returned : undefined)
  // A call we refused after the fact had signed someone in: that is who the refusal is about.
  const signedIn = (ctx.context.newSession?.user as SessionUser | undefined) ?? null
  const createdUser = refused ? null : signedIn
  const body = (ctx.body ?? {}) as { email?: unknown; method?: unknown }
  const event = authEventFor({
    path: ctx.path,
    failed: error !== undefined,
    newSession: createdUser !== null,
    secondFactorPending: createdUser?.twoFactorEnabled === true,
    enableMethod: typeof body.method === 'string' ? body.method : undefined,
  })
  if (!event) return

  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : undefined
  let actor: AuditActor | undefined
  let tenantId: string | null = null
  const detail: Record<string, unknown> = { ...facts(ctx), ...(event.method ? { method: event.method } : {}) }
  if (error) detail.reason = ('body' in error && (error as { body?: { code?: string } }).body?.code) || error.message

  if (event.type === 'auth.sign_in') {
    actor = createdUser ? actorOf(createdUser) : undefined
    // The accounts lists show this (implement/22 C14); sessions cannot, expired ones are purged hourly.
    if (createdUser) await consoleDb().db.update(user).set({ lastSignInAt: new Date() }).where(eq(user.id, createdUser.id)).catch((error: unknown) => console.error('[auth] last sign-in not saved', error))
  } else if (event.type === 'auth.second_factor_failed') {
    const user = (refused ? signedIn : null) ?? (await pendingTwoFactorUser(ctx)) ?? (await sessionUser(ctx))
    actor = user ? actorOf(user) : undefined
  } else if (event.type === 'auth.two_factor_enrolled') {
    const user = createdUser ?? (await sessionUser(ctx))
    actor = user ? actorOf(user) : undefined
  } else if (event.type === 'account.invitation_accepted') {
    const user = await sessionUser(ctx)
    actor = user ? actorOf(user) : undefined
    const accepted = (returned ?? {}) as { invitation?: { organizationId?: string; role?: string } }
    tenantId = await tenantOfOrganization(accepted.invitation?.organizationId).catch(() => null)
    if (accepted.invitation?.role) detail.role = accepted.invitation.role
  }
  // A failed sign-in and a reset request have no actor: the address tried is the label.
  await recordEvent({ type: event.type, outcome: event.outcome, actor, actorLabel: actor ? undefined : email, tenantId, detail })
}

/** Call from `hooks.before`: once sign-out has run, the session that says who it was is gone. */
export async function reportSignOut(ctx: GenericEndpointContext): Promise<void> {
  if (ctx.path !== '/sign-out' || !ctx.request) return
  const user = await sessionUser(ctx)
  if (user) await recordEvent({ type: 'auth.sign_out', actor: actorOf(user), detail: facts(ctx) })
}

/** Call from `emailAndPassword.onPasswordReset`: a first password or a reset, by mailed link. */
export async function reportPasswordReset(user: SessionUser, request: Request | undefined, ip: string | null): Promise<void> {
  await recordEvent({ type: 'auth.password_reset', actor: actorOf(user), detail: requestFacts(request, ip) })
}
