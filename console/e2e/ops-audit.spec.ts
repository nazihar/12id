/**
 * The audit log beyond platform-api's own routes (implement/22-console-feedback.md C13): sign-ins,
 * failed sign-ins, sign-outs and account changes happen in the console and are reported to
 * platform-api, where the one audit log shows them with the actor's email. Runs after auth.spec
 * (which enrolls the run's operator) against the local platform-api.
 */
import { type APIRequestContext, expect, test } from '@playwright/test'

import { consoleEnv } from './env'
import { operator, signInWithTotp } from './operator'

interface AuditEntry {
  method: string
  route: string
  actor: string
  actorLabel: string | null
  statusCode: number
  changes: Record<string, unknown> | null
}

/** The audit log as platform-api holds it, read with the console scope. */
async function auditEntries(request: APIRequestContext, query: string): Promise<AuditEntry[]> {
  const response = await request.get(`${consoleEnv.PLATFORM_API_URL}/admin/audit?pageSize=100&${query}`, {
    headers: { 'x-console-token': consoleEnv.CONSOLE_TOKEN, 'x-console-actor': 'e2e-audit-spec', 'x-console-role': 'operator' },
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { items: AuditEntry[] }).items
}

test('sign-ins, failed sign-ins, account changes and sign-outs reach the audit log', async ({ page, request }) => {
  test.setTimeout(180_000)
  const { email } = operator()

  // auth.spec tried an email code as this operator; we refuse that after Better Auth accepted the code,
  // and the refusal still names the account.
  const refusedCodes = (await auditEntries(request, `kind=sign-in&q=${encodeURIComponent(email)}`)).filter((entry) => entry.route === 'auth.second_factor_failed')
  expect(refusedCodes.length).toBeGreaterThan(0)
  expect(refusedCodes[0].changes).toMatchObject({ method: 'email code', reason: 'operators must use an authenticator app' })

  // A wrong password: refused on the page, and recorded with the address that was tried.
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('not-the-password-0000')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible()
  await expect.poll(async () => (await auditEntries(request, `kind=sign-in&q=${encodeURIComponent(email)}`)).filter((entry) => entry.route === 'auth.sign_in_failed').length).toBeGreaterThan(0)
  const [failed] = (await auditEntries(request, `kind=sign-in&q=${encodeURIComponent(email)}`)).filter((entry) => entry.route === 'auth.sign_in_failed')
  expect(failed).toMatchObject({ method: 'EVENT', actor: 'anonymous', actorLabel: email, statusCode: 401 })
  expect(failed.changes).toMatchObject({ method: 'password' })
  expect(JSON.stringify(failed.changes)).not.toContain('not-the-password-0000')

  // Password, then the authenticator code: one sign-in, recorded when the second factor completed it.
  const before = (await auditEntries(request, `kind=sign-in&q=${encodeURIComponent(email)}`)).filter((entry) => entry.route === 'auth.sign_in').length
  await signInWithTotp(page)
  await expect.poll(async () => (await auditEntries(request, `kind=sign-in&q=${encodeURIComponent(email)}`)).filter((entry) => entry.route === 'auth.sign_in').length).toBe(before + 1)
  const [signedIn] = (await auditEntries(request, `kind=sign-in&q=${encodeURIComponent(email)}`)).filter((entry) => entry.route === 'auth.sign_in')
  expect(signedIn.actor).not.toBe('anonymous')
  expect(signedIn).toMatchObject({ actorLabel: email, statusCode: 200 })
  expect(signedIn.changes).toMatchObject({ method: 'authenticator app' })

  // An account change made through Better Auth, not through platform-api.
  const invitee = `audited+${Date.now()}@12id.test`
  await page.getByRole('link', { name: 'Operators', exact: true }).click()
  await page.getByRole('button', { name: 'Add operator' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Audited Operator')
  await page.getByLabel('Email', { exact: true }).fill(invitee)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByTestId('operators-table')).toContainText(invitee)

  // The audit page: the Kind filter in the URL, events by name, the actor by email, the detail on request.
  await page.getByRole('link', { name: 'Audit log', exact: true }).click()
  await page.getByTestId('audit-kind').click()
  await page.getByRole('menuitemradio', { name: 'Accounts' }).click()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/kind=account/)
  const invited = page.getByTestId('audit-table').getByRole('row').filter({ hasText: 'Operator invited' }).first()
  await expect(invited).toContainText(email)
  await expect(invited).toContainText('ok')
  await invited.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByTestId('audit-changes')).toContainText(invitee)
  await page.keyboard.press('Escape')

  await page.getByTestId('audit-kind').click()
  await page.getByRole('menuitemradio', { name: 'Sign-ins' }).click()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/kind=sign-in/)
  await expect(page.getByTestId('audit-table')).toContainText('Sign-in failed')
  await expect(page.getByTestId('audit-table')).toContainText('Signed in')
  await expect(page.getByTestId('audit-table').getByRole('row').filter({ hasText: 'Sign-in failed' }).first()).toContainText('refused')

  // Changes made through platform-api now carry the actor's email as well as the id.
  const changes = await auditEntries(request, 'kind=change')
  expect(changes.every((entry) => entry.method !== 'EVENT')).toBe(true)

  // Signing out is recorded before the session that names the person is gone.
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect.poll(async () => (await auditEntries(request, `kind=sign-in&q=${encodeURIComponent(email)}`)).filter((entry) => entry.route === 'auth.sign_out').length).toBeGreaterThan(0)
})
