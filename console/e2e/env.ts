/**
 * Environment for the console under Playwright: development mode, the local Postgres `console`
 * database and a local platform-api with the console scope enabled. Override with E2E_* variables.
 */
export const consoleEnv: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:spike-only@127.0.0.1:55432/console',
  BETTER_AUTH_URL: 'http://localhost:3600',
  BETTER_AUTH_SECRET: `e2e-only-${'s'.repeat(40)}`,
  PLATFORM_API_URL: process.env.E2E_PLATFORM_API_URL ?? 'http://127.0.0.1:3510',
  CONSOLE_TOKEN: process.env.E2E_CONSOLE_TOKEN ?? 'c'.repeat(40),
  // Not *_FILE: that suffix means "a secret to read from this file" (file-env.server.ts).
  MAIL_OUTBOX_PATH: 'test-results/mail.jsonl',
}

/** The local platform-api's database; the portal spec seeds ready tenants there (onboarding needs agent-service). */
export const PLATFORM_DATABASE_URL = process.env.E2E_PLATFORM_DATABASE_URL ?? 'postgresql://postgres:spike-only@127.0.0.1:55432/platform_api_console'

/**
 * The secret the local platform-api accepts on POST /internal/alerts (its ALERT_WEBHOOK_SECRET), so a spec
 * can report alerts the way Alertmanager does. Start platform-api with the same value.
 */
export const ALERT_WEBHOOK_SECRET = process.env.E2E_ALERT_WEBHOOK_SECRET ?? 'local-alert-webhook-secret-0123456789abcdef'

export const OPERATOR_FILE ='test-results/operator.json'
/** Written by whichever spec enrolls the run's operator in TOTP; later specs sign in with it. */
export const TOTP_SECRET_FILE = 'test-results/totp-secret.txt'
export const MAIL_OUTBOX_FILE = consoleEnv.MAIL_OUTBOX_PATH
