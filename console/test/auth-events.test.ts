import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { auditAction, auditResult } from '../src/features/ops/audit-events'
import { recordEvent, requestFacts } from '../src/server/audit.server'
import { type AuthCall, authEventFor } from '../src/server/auth-events'

const call = (path: string, facts: Partial<AuthCall> = {}): AuthCall => ({ path, failed: false, newSession: false, secondFactorPending: false, ...facts })

describe('authEventFor', () => {
  it('reports a refused password as a failed sign-in', () => {
    expect(authEventFor(call('/sign-in/email', { failed: true }))).toEqual({ type: 'auth.sign_in_failed', outcome: 'failure', method: 'password' })
  })

  it('reports nothing for a right password while the second factor is pending', () => {
    // The session exists when our hook runs; the two-factor plugin removes it right after.
    expect(authEventFor(call('/sign-in/email', { newSession: true, secondFactorPending: true }))).toBeNull()
    expect(authEventFor(call('/sign-in/email'))).toBeNull()
  })

  it('reports a first sign-in, before 2FA is set up, as a sign-in by password', () => {
    expect(authEventFor(call('/sign-in/email', { newSession: true }))).toEqual({ type: 'auth.sign_in', outcome: 'success', method: 'password' })
  })

  it('reports the second factor that completed a sign-in, and the one that failed', () => {
    expect(authEventFor(call('/two-factor/verify-totp', { newSession: true, secondFactorPending: true }))).toEqual({ type: 'auth.sign_in', outcome: 'success', method: 'authenticator app' })
    expect(authEventFor(call('/two-factor/verify-otp', { newSession: true }))?.method).toBe('email code')
    expect(authEventFor(call('/two-factor/verify-backup-code', { newSession: true }))?.method).toBe('backup code')
    expect(authEventFor(call('/two-factor/verify-otp', { failed: true }))).toEqual({ type: 'auth.second_factor_failed', outcome: 'failure', method: 'email code' })
  })

  it('reports 2FA setup: a TOTP code from a signed-in user, or email codes switched on', () => {
    expect(authEventFor(call('/two-factor/verify-totp'))).toEqual({ type: 'auth.two_factor_enrolled', outcome: 'success', method: 'authenticator app' })
    expect(authEventFor(call('/two-factor/enable', { enableMethod: 'otp', newSession: true }))).toEqual({ type: 'auth.two_factor_enrolled', outcome: 'success', method: 'email code' })
    // The authenticator app is only set up once its first code is verified.
    expect(authEventFor(call('/two-factor/enable', { enableMethod: 'totp' }))).toBeNull()
    expect(authEventFor(call('/two-factor/enable', { enableMethod: 'otp', failed: true }))).toBeNull()
  })

  it('reports reset requests and accepted invitations, and nothing for other paths', () => {
    expect(authEventFor(call('/request-password-reset'))?.type).toBe('auth.password_reset_requested')
    expect(authEventFor(call('/organization/accept-invitation'))?.type).toBe('account.invitation_accepted')
    expect(authEventFor(call('/organization/accept-invitation', { failed: true }))).toBeNull()
    expect(authEventFor(call('/get-session'))).toBeNull()
    expect(authEventFor(call('/two-factor/send-otp'))).toBeNull()
  })
})

describe('recordEvent', () => {
  const token = 'c'.repeat(40)

  beforeAll(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:5432/console_test',
      BETTER_AUTH_URL: 'http://localhost:3600',
      BETTER_AUTH_SECRET: 's'.repeat(40),
      PLATFORM_API_URL: 'http://platform.test',
      CONSOLE_TOKEN: token,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function capture(status = 201) {
    const requests: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      requests.push({ url: String(url), init })
      return Response.json({ recorded: true }, { status })
    })
    return requests
  }

  it('posts the event with the console token and no principal headers', async () => {
    const requests = capture()
    await recordEvent({ type: 'auth.sign_in', actor: { id: 'user_1', email: 'ada@example.com', role: 'operator' }, detail: { ip: '203.0.113.7', method: 'authenticator app' } })
    expect(requests[0].url).toBe('http://platform.test/admin/audit/events')
    const headers = requests[0].init.headers as Record<string, string>
    expect(headers['x-console-token']).toBe(token)
    expect(headers['x-console-actor']).toBeUndefined()
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ type: 'auth.sign_in', outcome: 'success', actor: 'user_1', actorLabel: 'ada@example.com', role: 'operator', detail: { ip: '203.0.113.7', method: 'authenticator app' } })
  })

  it('labels an event without an actor by the address tried, and drops a role platform-api would refuse', async () => {
    const requests = capture()
    await recordEvent({ type: 'auth.sign_in_failed', outcome: 'failure', actorLabel: 'nobody@example.com', detail: {} })
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ type: 'auth.sign_in_failed', outcome: 'failure', actorLabel: 'nobody@example.com' })
    await recordEvent({ type: 'auth.sign_out', actor: { id: 'user_2', email: 'b@example.com', role: 'Not A Role!' } })
    expect(JSON.parse(String(requests[1].init.body)).role).toBeUndefined()
  })

  it('never throws: a refusal or an unreachable platform-api is logged', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    capture(500)
    await expect(recordEvent({ type: 'export.run', actor: { id: 'user_1', email: 'ada@example.com' } })).resolves.toBeUndefined()
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED')
    })
    await expect(recordEvent({ type: 'export.run', actor: { id: 'user_1', email: 'ada@example.com' } })).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalledTimes(2)
  })

  it('keeps the address and a shortened user agent as request facts', () => {
    const request = new Request('http://localhost/api/auth/sign-in/email', { headers: { 'user-agent': 'x'.repeat(500) } })
    const facts = requestFacts(request, '198.51.100.4')
    expect(facts.ip).toBe('198.51.100.4')
    expect(String(facts.userAgent)).toHaveLength(200)
    expect(requestFacts(undefined, null)).toEqual({})
  })
})

describe('audit log wording', () => {
  it('names events and shows calls as they were made', () => {
    expect(auditAction({ method: 'EVENT', route: 'auth.sign_in_failed' })).toEqual({ text: 'Sign-in failed', event: true })
    expect(auditAction({ method: 'EVENT', route: 'something.new' })).toEqual({ text: 'something.new', event: true })
    expect(auditAction({ method: 'POST', route: '/v1/api-keys' })).toEqual({ text: 'POST /v1/api-keys', event: false })
    expect(auditResult({ method: 'EVENT', statusCode: 401 })).toBe('refused')
    expect(auditResult({ method: 'EVENT', statusCode: 200 })).toBe('ok')
    expect(auditResult({ method: 'DELETE', statusCode: 404 })).toBe('404')
  })
})
