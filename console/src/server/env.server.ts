/**
 * Server configuration from process.env. Server-only (`.server.ts`); read inside handlers and
 * factories, never captured by client code.
 *
 * Imports in the auth chain (this file, db, email, auth) are relative, not `@/`: the Better Auth CLI
 * loads auth.server.ts outside Vite and does not resolve the tsconfig alias.
 */
import { z } from 'zod'

const secret = z.string().min(32, 'secrets must be at least 32 characters; generate them, never hand-type them')
const postgresUrl = z.url().refine((url) => url.startsWith('postgres://') || url.startsWith('postgresql://'), 'must be a postgres URL')

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    DATABASE_URL: postgresUrl,
    /** Public origin of the console, e.g. https://12id.naziharitsolution.com. */
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: secret,
    /** platform-api on the private network; the console scope is never reached over the internet. */
    PLATFORM_API_URL: z.url(),
    CONSOLE_TOKEN: secret,
    // Compose passes an empty string when the secret is not set; treat blank as unset.
    SMTP_URL: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
    MAIL_FROM: z.string().min(3).default('12id Console <no-reply@localhost>'),
    /** Development and tests only: also append every outgoing mail as a JSON line to this file. */
    MAIL_OUTBOX_FILE: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.SMTP_URL) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'required in production: email OTP, invitations and password reset send mail' })
    }
    if (env.NODE_ENV === 'production' && env.MAIL_OUTBOX_FILE) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_OUTBOX_FILE'], message: 'not allowed in production: it would write sign-in codes to disk' })
    }
  })

export type ServerEnv = z.infer<typeof schema>

export function serverEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = schema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`invalid console configuration:\n${problems.join('\n')}`)
  }
  return result.data
}
