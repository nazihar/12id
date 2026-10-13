/**
 * Where the sign-in rules meet Better Auth (implement/24-console-sign-in.md). `beforeAuthCall` runs
 * in `hooks.before` and may refuse a call; `afterAuthCall` runs in `hooks.after` and records what the
 * call did. The rules themselves are in sign-in-rules.server.ts and lib/.
 *
 * Read from the installed better-auth 1.7.4 source (see also auth-events.ts):
 *   - /reset-password takes `newPassword` and `token`, and consumes the token only after its own
 *     checks; `findVerificationValue` reads it without consuming;
 *   - the two-factor plugin decrypts a TOTP secret with `symmetricDecrypt({ key: ctx.context.secretConfig })`
 *     and checks the code with `createOTP(secret, { period: 30, digits: 6 })` (plugins/two-factor/totp);
 *   - a server-side `auth.api.*` call has no `ctx.request`: the captcha applies only to calls from a browser.
 *
 * Relative imports only (the Better Auth CLI loads the auth chain outside Vite).
 */
import { createOTP } from '@better-auth/utils/otp'
import type { GenericEndpointContext } from 'better-auth'
import { APIError, getIP, getSessionFromCtx, isAPIError } from 'better-auth/api'
import { symmetricDecrypt } from 'better-auth/crypto'
import { and, eq, gt } from 'drizzle-orm'

import { passwordExpired, signInDelayMs } from '../lib/sign-in-rules'
import { actorOf, recordEvent, requestFacts } from './audit.server'
import { CAPTCHA_HEADER, captchaSolved } from './captcha.server'
import { consoleDb } from './db.server'
import { twoFactor, user, verification } from './db/auth-schema'
import { serverEnv } from './env.server'
import {
  afterCompletedSignIn,
  clearWrongPasswords,
  countWrongPassword,
  isLocked,
  lockFactsFor,
  passwordReused,
  rememberPassword,
  serverPasswordProblems,
} from './sign-in-rules.server'

/** The header the reset page sends the authenticator code in (MTB 2.33). */
export const TOTP_HEADER = 'x-totp-code'

/** Every endpoint that sets a password, and where its body carries it. */
const PASSWORD_PATHS = ['/reset-password', '/change-password', '/admin/set-user-password', '/admin/create-user'] as const

type Account = { id: string; email: string; name?: string | null; role?: string | null; twoFactorEnabled?: boolean | null }

const facts = (ctx: GenericEndpointContext) => requestFacts(ctx.request, ctx.request ? getIP(ctx.request, ctx.context.options) : null)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const bodyOf = (ctx: GenericEndpointContext) => (ctx.body ?? {}) as Record<string, unknown>

function lockedMessage(until: Date | null) {
  const minutes = until ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000)) : serverEnv().CONSOLE_LOCK_MINUTES
  return `This account is locked after too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask an operator or your organization's owner to unlock it.`
}

/** The verified authenticator secret of an account, if it has one. */
async function totpSecretOf(userId: string): Promise<string | null> {
  const [row] = await consoleDb().db.select({ secret: twoFactor.secret }).from(twoFactor).where(and(eq(twoFactor.userId, userId), eq(twoFactor.verified, true)))
  return row?.secret ?? null
}

/** True when the reset link belongs to an account that must also give its authenticator code. */
export async function resetNeedsCode(token: string): Promise<boolean> {
  // The verification table keeps the link as `reset-password:<token>` with the user id as its value.
  const [row] = await consoleDb()
    .db.select({ userId: verification.value })
    .from(verification)
    .where(and(eq(verification.identifier, `reset-password:${token}`), gt(verification.expiresAt, new Date())))
  return row ? (await totpSecretOf(row.userId)) !== null : false
}

/** The account whose password a call sets, and whether that account already has one to compare with. */
async function passwordTarget(ctx: GenericEndpointContext): Promise<{ account: Account | null; context: { email?: string; name?: string }; existing: boolean; resetToken?: string }> {
  const body = bodyOf(ctx)
  if (ctx.path === '/admin/create-user') {
    return { account: null, context: { email: String(body.email ?? ''), name: String(body.name ?? '') }, existing: false }
  }
  let found: Account | null = null
  let resetToken: string | undefined
  if (ctx.path === '/reset-password') {
    resetToken = String(body.token ?? (ctx.query as { token?: string } | undefined)?.token ?? '')
    const verification = resetToken ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${resetToken}`) : null
    if (verification) found = (await ctx.context.internalAdapter.findUserById(verification.value)) as Account | null
  } else if (ctx.path === '/change-password') {
    found = ((await getSessionFromCtx(ctx).catch(() => null))?.user as Account | undefined) ?? null
  } else if (ctx.path === '/admin/set-user-password' && typeof body.userId === 'string') {
    found = (await ctx.context.internalAdapter.findUserById(body.userId)) as Account | null
  }
  return { account: found, context: { email: found?.email, name: found?.name ?? undefined }, existing: found !== null, resetToken }
}

async function checkNewPassword(ctx: GenericEndpointContext): Promise<void> {
  const body = bodyOf(ctx)
  const password = typeof body.newPassword === 'string' ? body.newPassword : typeof body.password === 'string' ? body.password : null
  // An operator creates an owner's or operator's account without a password: a mailed link sets it.
  if (password === null) return
  const target = await passwordTarget(ctx)
  const problems = serverPasswordProblems(password, target.context)
  if (problems.length > 0) throw new APIError('BAD_REQUEST', { message: problems.join(' '), code: 'PASSWORD_POLICY' })
  if (target.account && target.existing && (await passwordReused(target.account.id, password, (input) => ctx.context.password.verify(input)))) {
    throw new APIError('BAD_REQUEST', { message: 'You used this password recently. Choose one that is not one of your last 3.', code: 'PASSWORD_REUSED' })
  }
  // A reset needs the authenticator code too, where the account has one (MTB 2.33). A wrong code spends
  // the link, so guessing needs a new link each time (and each request passes the captcha).
  if (ctx.path === '/reset-password' && target.account && target.resetToken) {
    const secret = await totpSecretOf(target.account.id)
    if (secret) {
      const code = ctx.headers?.get(TOTP_HEADER)?.trim()
      if (!code) throw new APIError('BAD_REQUEST', { message: 'Enter the code from your authenticator app.', code: 'TOTP_REQUIRED' })
      const plain = await symmetricDecrypt({ key: ctx.context.secretConfig, data: secret })
      if (!(await createOTP(plain, { period: 30, digits: 6 }).verify(code))) {
        await ctx.context.internalAdapter.consumeVerificationValue(`reset-password:${target.resetToken}`)
        throw new APIError('BAD_REQUEST', { message: 'The code was wrong, so this link no longer works. Request a new one from the sign-in page.', code: 'TOTP_WRONG' })
      }
    }
  }
}

/** `hooks.before`: refuse what the rules do not allow. */
export async function beforeAuthCall(ctx: GenericEndpointContext): Promise<void> {
  const body = bodyOf(ctx)
  if ((ctx.path === '/sign-in/email' || ctx.path === '/request-password-reset') && ctx.request) {
    if (!(await captchaSolved(ctx.headers?.get(CAPTCHA_HEADER)))) {
      throw new APIError('BAD_REQUEST', { message: 'The check that you are not a robot did not complete. Wait for it to finish, then try again.', code: 'CAPTCHA_REQUIRED' })
    }
  }
  if (ctx.path === '/sign-in/email' && typeof body.email === 'string') {
    const account = await lockFactsFor(body.email)
    if (isLocked(account)) throw new APIError('FORBIDDEN', { message: lockedMessage(account?.lockedUntil ?? null), code: 'ACCOUNT_LOCKED' })
    // A growing delay after wrong passwords (MTB 2.36).
    if (account && account.failedSignIns > 0) await sleep(signInDelayMs(account.failedSignIns))
  }
  if ((PASSWORD_PATHS as readonly string[]).includes(ctx.path)) await checkNewPassword(ctx)
}

/**
 * `hooks.after`: count wrong passwords, apply one session per account, and keep the password history.
 * `refused` is set when our own check turned a successful call into a refusal (auth.server.ts).
 */
export async function afterAuthCall(ctx: GenericEndpointContext, refused?: APIError): Promise<void> {
  const returned = (ctx.context as { returned?: unknown }).returned
  const failed = refused !== undefined || isAPIError(returned)
  const body = bodyOf(ctx)

  if (ctx.path === '/sign-in/email' && typeof body.email === 'string') {
    const account = await lockFactsFor(body.email)
    const code = isAPIError(returned) ? (returned as { body?: { code?: string } }).body?.code : undefined
    if (account && code === 'INVALID_EMAIL_OR_PASSWORD') await countWrongPassword(account, facts(ctx))
    else if (account && !failed) await clearWrongPasswords(account.id)
  }

  const created = ctx.context.newSession
  if (created && !refused) {
    const signedIn = created.user as Account
    // A password alone opens no session for an account with 2FA: the plugin removes it after this hook.
    const provisional = ctx.path === '/sign-in/email' && signedIn.twoFactorEnabled === true
    if (!provisional) {
      await afterCompletedSignIn(signedIn, created.session.token, facts(ctx))
      const [row] = await consoleDb().db.select({ changedAt: user.passwordChangedAt }).from(user).where(eq(user.id, signedIn.id))
      if (passwordExpired(row?.changedAt, serverEnv().CONSOLE_PASSWORD_MAX_AGE_DAYS)) {
        await recordEvent({ type: 'auth.password_expired', actor: actorOf(signedIn), detail: { maxAgeDays: serverEnv().CONSOLE_PASSWORD_MAX_AGE_DAYS } })
      }
    }
  }

  if (failed) return
  if (ctx.path === '/change-password') {
    // The endpoint ran behind Better Auth's session middleware, so the session it changed is on the context.
    const signedIn = ((ctx.context.session ?? ctx.context.newSession)?.user as Account | undefined) ?? null
    if (signedIn) {
      await rememberPassword(signedIn.id)
      await recordEvent({ type: 'auth.password_changed', actor: actorOf(signedIn), detail: facts(ctx) })
    }
  } else if (ctx.path === '/admin/set-user-password' && typeof body.userId === 'string') {
    await rememberPassword(body.userId)
  } else if (ctx.path === '/admin/create-user' && typeof body.password === 'string') {
    const createdUser = (returned as { user?: { id?: string } } | undefined)?.user
    if (createdUser?.id) await rememberPassword(createdUser.id)
  }
}
