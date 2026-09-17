/**
 * Stage 4a acceptance against staging (`npm run e2e:staging`), driven by environment:
 *   STAGING_URL           https://12id.naziharitsolution.com
 *   STAGING_EMAIL/PASSWORD  an operator whose 2FA is not yet set up (fresh from create-admin), or
 *   STAGING_TOTP_SECRET     the TOTP secret of an enrolled operator
 *   STAGING_INVITE_EMAIL    optional: a real mailbox to invite as operator (proves SMTP works)
 *
 * The TOTP secret printed at enrollment is written to .staging/totp-secret.txt so the
 * next run can sign in; keep that file out of the repo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { expect, test } from '@playwright/test'
import { generateSync } from 'otplib'

import { submitSignIn } from './staging-signin'

const url = process.env.STAGING_URL ?? 'https://12id.naziharitsolution.com'
const email = process.env.STAGING_EMAIL ?? ''
const password = process.env.STAGING_PASSWORD ?? ''
const SECRET_FILE = '.staging/totp-secret.txt'
const secretFromEnv = process.env.STAGING_TOTP_SECRET ?? (existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, 'utf8').trim() : '')

test.use({ baseURL: url })
test.skip(!email || !password, 'STAGING_EMAIL and STAGING_PASSWORD are required')

test('staging: sign in, enroll or verify TOTP, read tenants from platform-api, invite by mail', async ({ page, request }) => {
  test.setTimeout(180_000)
  mkdirSync('.staging', { recursive: true })

  expect((await request.get('/api/health')).status()).toBe(200)
  expect((await request.post('/', { headers: { origin: 'https://evil.example' } })).status()).toBe(403)

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await submitSignIn(page)
  await expect(page).toHaveURL(/\/(setup-2fa|verify-2fa)/)

  let secret = secretFromEnv
  if (page.url().includes('/setup-2fa')) {
    await page.getByLabel('Confirm your password').fill(password)
    await expect(page.getByRole('button', { name: 'Email me codes instead' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Use an authenticator app' }).click()
    secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').trim()
    writeFileSync(SECRET_FILE, secret)
    await page.getByTestId('otp-code').fill(generateSync({ secret }))
    await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click()
  } else {
    expect(secret, 'STAGING_TOTP_SECRET needed for an enrolled operator').not.toBe('')
    await page.getByTestId('otp-code').fill(generateSync({ secret }))
    await page.getByRole('button', { name: 'Verify' }).click()
  }

  // The dashboard (C8) from /admin/stats, then the tenants table from /admin/overview, both through the console scope.
  await expect(page).toHaveURL(/\/ops/)
  await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible()
  await expect(page.getByTestId('health-strip')).toContainText('Agent service: ok')
  await expect(page.getByTestId('activity-chart').locator('svg').first()).toBeVisible()
  await page.getByRole('navigation', { name: 'Operator sections' }).getByRole('link', { name: 'Tenants', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
  await expect(page.getByTestId('tenants-table')).toContainText('acme-platform')

  // Tenant detail: API keys and catalogue for the Phase 3 tenant.
  await page.getByRole('link', { name: 'acme-platform' }).click()
  await expect(page.getByRole('heading', { name: 'acme-platform' })).toBeVisible()
  await page.getByRole('link', { name: 'Catalogue' }).click()
  await expect(page.getByText('smoke-badge').first()).toBeVisible()
  await page.getByRole('link', { name: 'Webhooks' }).click()
  await expect(page.getByTestId('deliveries-table')).toBeVisible()

  const invitee = process.env.STAGING_INVITE_EMAIL
  if (invitee) {
    await page.getByRole('link', { name: 'Operators', exact: true }).click()
    await page.getByRole('button', { name: 'Add operator' }).click()
    await page.getByLabel('Name', { exact: true }).fill('Staging Invitee')
    await page.getByLabel('Email', { exact: true }).fill(invitee)
    await page.getByRole('button', { name: 'Send invitation' }).click()
    await expect(page.getByTestId('operators-table')).toContainText(invitee)
  }

  await page.getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
})
