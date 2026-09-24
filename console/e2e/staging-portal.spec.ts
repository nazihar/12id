/**
 * Stage 4b acceptance against staging (`npm run e2e:staging`), for the Phase 3 tenant:
 *   STAGING_EMAIL/PASSWORD              the enrolled operator (TOTP secret in .staging/totp-secret.txt)
 *   STAGING_OWNER_EMAIL/OWNER_PASSWORD  a non-operator account (console-tools `auth create-admin --role user`)
 *   STAGING_TENANT                      defaults to acme-platform
 *
 * The operator gives the tenant its organization when it has none; the owner enrolls TOTP on the
 * first run (secret kept in .staging/owner-totp-secret.txt) and then works through every portal page,
 * including the agent-backed ones that the local spec cannot reach. It leaves nothing behind except
 * one connection invitation: the template is deleted and the API key revoked.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import type { Page } from '@playwright/test'

import { expect, test, watchCsp } from './csp'
import { generateSync } from 'otplib'

import { submitSignIn } from './staging-signin'

const url = process.env.STAGING_URL ?? 'https://12id.naziharitsolution.com'
const operatorEmail = process.env.STAGING_EMAIL ?? ''
const operatorPassword = process.env.STAGING_PASSWORD ?? ''
const ownerEmail = (process.env.STAGING_OWNER_EMAIL ?? '').toLowerCase()
const ownerPassword = process.env.STAGING_OWNER_PASSWORD ?? ''
const tenantName = process.env.STAGING_TENANT ?? 'acme-platform'
const OPERATOR_SECRET_FILE = '.staging/totp-secret.txt'
const OWNER_SECRET_FILE = '.staging/owner-totp-secret.txt'

test.use({ baseURL: url })
test.skip(!operatorEmail || !operatorPassword || !ownerEmail || !ownerPassword, 'STAGING_EMAIL, STAGING_PASSWORD, STAGING_OWNER_EMAIL and STAGING_OWNER_PASSWORD are required')

async function signIn(page: Page, email: string, password: string, secretFile: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await submitSignIn(page)
  await expect(page).toHaveURL(/\/(setup-2fa|verify-2fa)/)
  if (page.url().includes('/setup-2fa')) {
    await page.getByLabel('Confirm your password').fill(password)
    await page.getByRole('button', { name: 'Use an authenticator app' }).click()
    const secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').trim()
    writeFileSync(secretFile, secret)
    await page.getByTestId('otp-code').fill(generateSync({ secret }))
    await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click()
  } else {
    expect(existsSync(secretFile), `${secretFile} is needed for an enrolled account`).toBe(true)
    await page.getByTestId('otp-code').fill(generateSync({ secret: readFileSync(secretFile, 'utf8').trim() }))
    await page.getByRole('button', { name: 'Verify' }).click()
  }
}

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Organization sections' }).getByRole('link', { name, exact: true })

test('staging: tenant owner works through the portal', async ({ browser, page, cspViolations }) => {
  test.setTimeout(300_000)
  mkdirSync('.staging', { recursive: true })
  const stamp = Date.now()

  // Operator: the tenant's organization, with the owner account as owner.
  await signIn(page, operatorEmail, operatorPassword, OPERATOR_SECRET_FILE)
  await expect(page).toHaveURL(/\/ops/)
  await page.goto('/ops/tenants')
  await page.getByTestId('tenants-table').getByRole('link', { name: tenantName, exact: true }).click()
  const createOrganization = page.getByRole('button', { name: 'Create organization' })
  const members = page.getByTestId('members-table')
  await expect(createOrganization.or(members)).toBeVisible()
  if (await createOrganization.isVisible()) {
    await createOrganization.click()
    await page.getByLabel('Owner name').fill('Staging Owner')
    await page.getByLabel('Owner email').fill(ownerEmail)
    await page.getByRole('dialog').getByRole('button', { name: 'Create organization' }).click()
  }
  await expect(members).toContainText(ownerEmail)

  // Owner.
  const ownerContext = await browser.newContext({ baseURL: url })
  watchCsp(ownerContext, cspViolations)
  const owner = await ownerContext.newPage()
  await signIn(owner, ownerEmail, ownerPassword, OWNER_SECRET_FILE)
  await expect(owner).toHaveURL(/\/account/)
  await owner.getByTestId('organizations').getByText(tenantName, { exact: true }).click()

  // Overview (C8) first: real numbers for the Phase 3 tenant, then the catalogue.
  await expect(owner).toHaveURL(/\/t\/[^/]+$/)
  await expect(owner.getByTestId('stat-credentials')).toBeVisible()
  await expect(owner.getByTestId('catalogue-summary')).toContainText('published')
  await tab(owner, 'Catalogue').click()
  await expect(owner).toHaveURL(/\/catalogue/)
  await expect(owner.getByTestId('schemas-table')).toContainText('smoke-badge')
  // Schemas and credential definitions are two tabs (C9).
  await owner.getByRole('tab', { name: 'Credential definitions' }).click()
  await expect(owner.getByTestId('definitions-table')).toContainText('smoke-badge')
  await expect(owner.getByRole('button', { name: 'Publish a schema' })).toBeVisible()

  // Template builder → platform-api validation → delete again.
  const templateName = `staging-portal-${stamp}`
  await tab(owner, 'Proof templates').click()
  await owner.getByRole('link', { name: 'New template' }).click()
  const builder = owner.getByTestId('template-builder')
  const removeRef = builder.getByRole('button', { name: 'Remove credential type' })
  while ((await removeRef.count()) > 0) await removeRef.first().click()
  // The first schema is preselected; the combobox opens its list only for a different query.
  const schema = builder.getByLabel('Schema', { exact: true })
  if ((await schema.inputValue()) !== 'smoke-badge') {
    await schema.fill('smoke-badge')
    await owner.getByRole('option', { name: 'smoke-badge' }).click()
  }
  await builder.getByRole('button', { name: 'Add', exact: true }).click()
  await builder.getByRole('checkbox').first().check()
  await owner.getByLabel('Template name').fill(templateName)
  await owner.getByRole('button', { name: 'Save template' }).click()
  const templates = owner.getByTestId('templates-table')
  await expect(templates).toContainText(templateName)
  await templates.getByRole('row').filter({ hasText: templateName }).getByRole('button', { name: 'Delete' }).click()
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Delete template' }).click()
  await expect(templates).not.toContainText(templateName)

  await tab(owner, 'Exchanges').click()
  await owner.getByRole('button', { name: 'Create invitation' }).click()
  await owner.getByRole('dialog').getByRole('button', { name: 'Create invitation' }).click()
  await expect(owner.getByTestId('invitation-qr')).toBeVisible({ timeout: 30_000 })
  await owner.getByRole('button', { name: 'Done' }).click()

  await tab(owner, 'Wallets').click()
  await expect(owner.getByTestId('wallets-table')).toBeVisible()

  await tab(owner, 'Webhooks').click()
  await expect(owner.getByTestId('deliveries-table')).toBeVisible()

  // API key: shown once, then revoked.
  const keyLabel = `staging-portal-${stamp}`
  await tab(owner, 'API keys').click()
  await owner.getByRole('button', { name: 'Create API key' }).click()
  await owner.getByLabel('New key label').fill(keyLabel)
  await owner.getByRole('dialog').getByRole('button', { name: 'Create API key' }).click()
  await expect(owner.getByTestId('secret-value')).toContainText('12id_sk_')
  await owner.getByRole('button', { name: 'I have stored it' }).click()
  const keyRow = owner.getByTestId('api-keys-table').getByRole('row').filter({ hasText: keyLabel })
  await keyRow.getByRole('button', { name: 'Revoke' }).click()
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click()
  await expect(keyRow).toContainText('revoked')

  await tab(owner, 'Members').click()
  await expect(owner.getByTestId('members-table')).toContainText(ownerEmail)

  // The operator sees the owner's changes in the audit log.
  await page.goto('/ops/audit')
  await expect(page.getByText(ownerEmail).first()).toBeVisible()
})
