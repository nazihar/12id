/**
 * Creates (or revokes) an API key for a staging tenant through the console, for smoke:platform-credo.
 *   STAGING_EMAIL/PASSWORD + .staging/totp-secret.txt (from staging.spec.ts)
 *   STAGING_TENANT   tenant name (default acme-platform)
 *   STAGING_REVOKE   set to a key label to revoke it instead of creating one
 * The plaintext key is written to .staging/api-key.txt and never printed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { expect, test } from './csp'
import { generateSync } from 'otplib'

import { submitSignIn } from './staging-signin'

const url = process.env.STAGING_URL ?? 'https://12id.naziharitsolution.com'
const email = process.env.STAGING_EMAIL ?? ''
const password = process.env.STAGING_PASSWORD ?? ''
const tenantName = process.env.STAGING_TENANT ?? 'acme-platform'
const revokeLabel = process.env.STAGING_REVOKE
const secret = process.env.STAGING_TOTP_SECRET ?? (existsSync('.staging/totp-secret.txt') ? readFileSync('.staging/totp-secret.txt', 'utf8').trim() : '')

test.use({ baseURL: url })
test.skip(!email || !password || !secret, 'STAGING_EMAIL, STAGING_PASSWORD and an enrolled TOTP secret are required')

test('staging: manage an API key through the console', async ({ page }) => {
  test.setTimeout(120_000)
  // Never replay the TOTP code of a sign-in moments ago.
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await submitSignIn(page)
  await expect(page).toHaveURL(/\/verify-2fa/)
  await page.getByTestId('otp-code').fill(generateSync({ secret }))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL(/\/ops/)

  await page.getByRole('link', { name: tenantName }).click()
  await page.getByRole('link', { name: 'API keys' }).click()
  await expect(page.getByTestId('api-keys-table')).toBeVisible()

  if (revokeLabel) {
    const row = page.getByTestId('api-keys-table').getByRole('row').filter({ hasText: revokeLabel }).filter({ hasText: 'active' }).first()
    await row.getByRole('button', { name: 'Revoke' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click()
    await expect(page.getByTestId('api-keys-table').getByRole('row').filter({ hasText: revokeLabel }).first()).toContainText('revoked')
    return
  }

  const label = `smoke-${Date.now()}`
  await page.getByRole('button', { name: 'Create API key' }).click()
  await page.getByLabel('New key label').fill(label)
  await page.getByRole('dialog').getByRole('button', { name: 'Create API key' }).click()
  const key = ((await page.getByTestId('secret-value').textContent()) ?? '').trim()
  expect(key).toMatch(/^12id_sk_/)
  writeFileSync('.staging/api-key.txt', key)
  writeFileSync('.staging/api-key-label.txt', label)
  await page.getByRole('button', { name: 'I have stored it' }).click()
  await expect(page.getByTestId('api-keys-table')).toContainText(label)
})
