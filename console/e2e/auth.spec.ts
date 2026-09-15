/**
 * Phase 4 C0 runtime checks: the auth path end to end in a browser.
 *   - anonymous visitors land on sign-in; cross-origin writes are refused;
 *   - 2FA is mandatory before any console page, and operators can only enroll an authenticator app;
 *   - after TOTP, operator data loads from platform-api through the console scope;
 *   - an operator's emailed code is refused even though Better Auth offers it at sign-in.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { type Page, expect, test } from '@playwright/test'
import { generateSync } from 'otplib'

import { MAIL_OUTBOX_FILE, OPERATOR_FILE, TOTP_SECRET_FILE } from './env'

test.describe.configure({ mode: 'serial' })

const operator = () => JSON.parse(readFileSync(OPERATOR_FILE, 'utf8')) as { email: string; password: string }

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/** TOTP codes repeat within a 30 s window; wait for the next one so a code is never replayed. */
async function nextTotpWindow(page: Page) {
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000)
}

async function emailedCode(email: string, notBefore: number): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (existsSync(MAIL_OUTBOX_FILE)) {
      const mails = readFileSync(MAIL_OUTBOX_FILE, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { at: string; to: string; subject: string; text: string })
        .filter((mail) => mail.to === email && Date.parse(mail.at) >= notBefore && mail.subject.includes('sign-in code'))
      const code = mails.at(-1)?.text.match(/\b(\d{6})\b/)?.[1]
      if (code) return code
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`no sign-in code was emailed to ${email}`)
}

test('refuses writes that do not come from the console origin', async ({ request, baseURL }) => {
  expect((await request.post('/', { headers: { origin: 'https://evil.example' } })).status()).toBe(403)
  expect((await request.post('/')).status()).toBe(403)

  // Better Auth's endpoints sit behind the same CSRF middleware...
  const credentials = { email: 'nobody@12id.test', password: 'wrong-password-123' }
  expect((await request.post('/api/auth/sign-in/email', { headers: { 'sec-fetch-site': 'cross-site' }, data: credentials })).status()).toBe(403)
  // ...and a genuine same-origin request still reaches Better Auth, which refuses the credentials itself.
  const sameOrigin = await request.post('/api/auth/sign-in/email', { headers: { 'sec-fetch-site': 'same-origin', origin: baseURL ?? '' }, data: credentials })
  expect([400, 401]).toContain(sameOrigin.status())
})

test('operator: mandatory TOTP, console data, and no emailed codes', async ({ page }) => {
  test.setTimeout(150_000)
  const { email, password } = operator()

  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)

  // Signed in without 2FA: every console page sends the operator to setup.
  await signIn(page, email, password)
  await expect(page).toHaveURL(/\/setup-2fa/)
  await page.goto('/ops')
  await expect(page).toHaveURL(/\/setup-2fa/)

  await page.getByLabel('Confirm your password').fill(password)
  await expect(page.getByRole('button', { name: 'Email me codes instead' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Use an authenticator app' }).click()
  const secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').trim()
  expect(secret.length).toBeGreaterThan(15)
  writeFileSync(TOTP_SECRET_FILE, secret)
  expect(await page.getByTestId('backup-codes').locator('li').count()).toBeGreaterThan(0)
  await page.getByTestId('otp-code').fill(generateSync({ secret }))
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click()

  // Data from platform-api through operatorMiddleware and the console scope.
  await expect(page).toHaveURL(/\/ops/)
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
  await expect(page.getByTestId('tenants-empty').or(page.getByTestId('tenants-table'))).toBeVisible()

  // Better Auth offers emailed codes to every 2FA user; the console refuses them for operators.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
  // Better Auth allows 3 sign-in requests per 10 s per IP (this file has made 3 so far); wait out the window.
  await page.waitForTimeout(10_500)
  await signIn(page, email, password)
  await expect(page).toHaveURL(/\/verify-2fa/)
  const requestedAt = Date.now() - 1_000
  await page.getByRole('button', { name: 'Email me a code instead' }).click()
  await page.getByTestId('otp-code').fill(await emailedCode(email, requestedAt))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByTestId('verify-error')).toContainText('authenticator app')
  await page.goto('/ops')
  await expect(page).toHaveURL(/\/login/)

  // A new TOTP code signs the operator in.
  await nextTotpWindow(page)
  await signIn(page, email, password)
  await expect(page).toHaveURL(/\/verify-2fa/)
  await page.getByTestId('otp-code').fill(generateSync({ secret }))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL(/\/ops/)
})
