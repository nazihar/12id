/**
 * Which audit event a Better Auth call is (implement/22-console-feedback.md C13). Pure, so the rules
 * can be tested without Better Auth; the hook in auth-audit.server.ts gathers the facts.
 *
 * Read from the installed better-auth 1.7.4 source, not its docs:
 *   - an endpoint that throws an APIError still reaches the after-hooks, with the error as the
 *     returned value (api/dispatch.mjs), so failures are visible here;
 *   - our after-hook runs before the plugins' own. On /sign-in/email for a user with 2FA, a session
 *     exists at that moment and the two-factor plugin removes it right after: the password was right
 *     but nobody is signed in yet, so nothing is reported until the second factor;
 *   - a second-factor call during sign-in creates the session; the same TOTP call from a signed-in
 *     user creates none and is the last step of setting up an authenticator app;
 *   - /two-factor/enable with method `otp` turns email codes on at once.
 */
export type AuthEventType =
  | 'auth.sign_in'
  | 'auth.sign_in_failed'
  | 'auth.second_factor_failed'
  | 'auth.two_factor_enrolled'
  | 'auth.password_reset_requested'
  | 'account.invitation_accepted'

export interface AuthCall {
  path: string
  /** The endpoint (or our own check after it) refused. */
  failed: boolean
  /** This call created a session. */
  newSession: boolean
  /** That session's user already has 2FA, so the session is provisional. */
  secondFactorPending: boolean
  /** `method` in the body of /two-factor/enable. */
  enableMethod?: string
}

export interface AuthEvent {
  type: AuthEventType
  outcome: 'success' | 'failure'
  /** How the person proved who they are, where that applies. */
  method?: 'password' | 'authenticator app' | 'email code' | 'backup code'
}

const SECOND_FACTORS: Record<string, AuthEvent['method']> = {
  '/two-factor/verify-totp': 'authenticator app',
  '/two-factor/verify-otp': 'email code',
  '/two-factor/verify-backup-code': 'backup code',
}

export function authEventFor(call: AuthCall): AuthEvent | null {
  if (call.path === '/sign-in/email') {
    if (call.failed) return { type: 'auth.sign_in_failed', outcome: 'failure', method: 'password' }
    // A first sign-in, before 2FA is set up, is complete with the password alone.
    return call.newSession && !call.secondFactorPending ? { type: 'auth.sign_in', outcome: 'success', method: 'password' } : null
  }
  const secondFactor = SECOND_FACTORS[call.path]
  if (secondFactor) {
    if (call.failed) return { type: 'auth.second_factor_failed', outcome: 'failure', method: secondFactor }
    if (call.newSession) return { type: 'auth.sign_in', outcome: 'success', method: secondFactor }
    return call.path === '/two-factor/verify-totp' ? { type: 'auth.two_factor_enrolled', outcome: 'success', method: 'authenticator app' } : null
  }
  if (call.failed) return null
  if (call.path === '/two-factor/enable') return call.enableMethod === 'otp' ? { type: 'auth.two_factor_enrolled', outcome: 'success', method: 'email code' } : null
  if (call.path === '/request-password-reset') return { type: 'auth.password_reset_requested', outcome: 'success' }
  if (call.path === '/organization/accept-invitation') return { type: 'account.invitation_accepted', outcome: 'success' }
  return null
}
