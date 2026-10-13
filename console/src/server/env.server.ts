/**
 * Server configuration from process.env. Server-only (`.server.ts`); read inside handlers and
 * factories, never captured by client code.
 *
 * Imports in the auth chain (this file, db, email, auth) are relative, not `@/`: the Better Auth CLI
 * loads auth.server.ts outside Vite and does not resolve the tsconfig alias.
 */
import { z } from 'zod'

import { resolveFileEnv } from './file-env.server'

const secret = z.string().min(32, 'secrets must be at least 32 characters; generate them, never hand-type them')
/** A whole-number setting; blank (compose passes an empty string for an unset variable) takes the default. */
const setting = (min: number, max: number, fallback: number) => z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(min).max(max).default(fallback))
const postgresUrl = z.url().refine((url) => url.startsWith('postgres://') || url.startsWith('postgresql://'), 'must be a postgres URL')

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    DATABASE_URL: postgresUrl,
    /** Public origin of the console, e.g. https://12id.naziharitsolution.com. */
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: secret,
    /** Rotation (Phase 9 W4, auth-secrets.server.ts): the version of BETTER_AUTH_SECRET; 0 = unversioned, as before. */
    BETTER_AUTH_SECRET_VERSION: z.coerce.number().int().min(0).default(0),
    /** Rotation: the secret being retired, decrypt-only until scripts/reencrypt-2fa.ts has run. Blank = unset. */
    BETTER_AUTH_SECRET_PREVIOUS: z.preprocess((value) => (value === '' ? undefined : value), secret.optional()),
    /** platform-api on the private network; the console scope is never reached over the internet. */
    PLATFORM_API_URL: z.url(),
    CONSOLE_TOKEN: secret,
    // Compose passes an empty string when the secret is not set; treat blank as unset.
    SMTP_URL: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
    MAIL_FROM: z.string().min(3).default('12id Console <no-reply@localhost>'),
    /** Development and tests only: also append every outgoing mail as a JSON line to this file. */
    MAIL_OUTBOX_PATH: z.string().min(1).optional(),
    // Sign-in rules (implement/24-console-sign-in.md). One policy for every account, set per deployment.
    /** A session with no activity for this long is ended (MTB 2.25: 10 to 15 minutes). */
    CONSOLE_IDLE_TIMEOUT_MINUTES: setting(1, 1440, 15),
    /** A password older than this must be changed before anything else; 0 = never. */
    CONSOLE_PASSWORD_MAX_AGE_DAYS: setting(0, 3650, 90),
    /** An account with no sign-in for this long is disabled and told by mail; 0 = never. */
    CONSOLE_INACTIVITY_DAYS: setting(0, 3650, 90),
    /** Wrong passwords in a row that lock an account, and for how long. */
    CONSOLE_LOCK_THRESHOLD: setting(1, 100, 5),
    CONSOLE_LOCK_MINUTES: setting(1, 1440, 15),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.SMTP_URL) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'required in production: email OTP, invitations and password reset send mail' })
    }
    if (env.BETTER_AUTH_SECRET_PREVIOUS && env.BETTER_AUTH_SECRET_VERSION === 0) {
      ctx.addIssue({ code: 'custom', path: ['BETTER_AUTH_SECRET_VERSION'], message: 'a previous secret needs BETTER_AUTH_SECRET_VERSION 1 or higher (runbooks/key-rotation.md)' })
    }
    if (env.BETTER_AUTH_SECRET_PREVIOUS && env.BETTER_AUTH_SECRET_PREVIOUS === env.BETTER_AUTH_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['BETTER_AUTH_SECRET_PREVIOUS'], message: 'equals BETTER_AUTH_SECRET; generate a new current secret' })
    }
    if (env.NODE_ENV === 'production' && env.MAIL_OUTBOX_PATH) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_OUTBOX_PATH'], message: 'not allowed in production: it would write sign-in codes to disk' })
    }
  })

export type ServerEnv = z.infer<typeof schema>

export function serverEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  // Secrets arrive as NAME_FILE (Phase 9 M11), resolved before validation.
  const result = schema.safeParse(resolveFileEnv(source))
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`invalid console configuration:\n${problems.join('\n')}`)
  }
  return result.data
}
