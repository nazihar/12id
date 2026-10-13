/**
 * Console feedback sets 1 and 2 (implement/22-console-feedback.md) against staging, as an enrolled operator
 * (`npm run e2e:staging`): the Verification page and a customer page on a tenant that has run face
 * checks, an export in both formats under the deployed Content-Security-Policy (csp.ts fails the
 * test on any refusal), the sign-in and the exports in the audit log, the System health page with
 * monitoring's heartbeat, the audit log's own period set for the tenant and put back, and the
 * Approvals pages (read only; infra/smoke/approvals-check.ts runs a change through approval).
 *
 *   STAGING_EMAIL/PASSWORD   an enrolled operator (as staging.spec.ts; TOTP secret from the same file)
 *   STAGING_FEEDBACK_TENANT  a tenant with face checks in the last 90 days (default: the biometric
 *                            smoke tenant)
 *
 * It reads, and leaves audit rows only (the sign-in, the opened log, the two exports, the period set
 * and reset). The operator
 * must be enrolled already: staging.spec.ts does that on its first run and keeps the secret.
 */
import { existsSync, readFileSync } from 'node:fs'

import { strFromU8, unzipSync } from 'fflate'
import { generateSync } from 'otplib'
import type { Download, Page } from '@playwright/test'

import { expect, test } from './csp'
import { submitSignIn } from './staging-signin'

const url = process.env.STAGING_URL ?? 'https://12id.naziharitsolution.com'
const email = process.env.STAGING_EMAIL ?? ''
const password = process.env.STAGING_PASSWORD ?? ''
const tenantId = process.env.STAGING_FEEDBACK_TENANT ?? 'a249dc92-0163-462b-af3d-b4882f9a099e'
const SECRET_FILE = '.staging/totp-secret.txt'
const secret = process.env.STAGING_TOTP_SECRET ?? (existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, 'utf8').trim() : '')

test.use({ baseURL: url })
test.skip(!email || !password || !secret, 'STAGING_EMAIL, STAGING_PASSWORD and an enrolled TOTP secret are required')

/** Optional screenshots for a look at the charts on real data (E2E_SHOTS=<dir>); the run does not depend on them. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true })
}

async function exportAs(page: Page, format: 'Excel' | 'CSV'): Promise<Download> {
  await page.getByTestId('export-menu').click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: new RegExp(`^${format}`) }).click()])
  return download
}

test('staging: verification page, customer page, export in both formats, audit entries', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await submitSignIn(page)
  await expect(page).toHaveURL(/\/verify-2fa/)
  await page.getByTestId('otp-code').fill(generateSync({ secret }))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL(/\/ops/)

  // The operator dashboard carries the two verification tiles.
  await expect(page.getByTestId('stat-proofs-verified')).toBeVisible()

  // Proofs over the widest window, so the page does not depend on when the smoke last ran.
  await page.goto(`/ops/tenants/${tenantId}/verification?days=90`)
  await expect(page.getByRole('heading', { name: 'Verification', exact: true })).toBeVisible()
  await expect(page.getByTestId('stat-proof-requests')).toBeVisible()
  await expect(page.getByTestId('proof-outcome-chart').locator('svg').first()).toBeVisible()

  await shot(page, 'staging-verification-proofs')

  // Face checks: outcomes, reasons, scores and the list.
  await page.getByRole('tab', { name: 'Face checks' }).click()
  await expect(page).toHaveURL(/tab=checks/)
  await expect(page.getByTestId('stat-checks')).toBeVisible()
  await expect(page.getByTestId('check-outcome-chart').locator('svg').first()).toBeVisible()
  await expect(page.getByTestId('rejection-reasons').getByRole('button').first()).toBeVisible()
  await expect(page.getByTestId('liveness-scores')).toContainText('minimum')
  const checks = page.getByTestId('checks-table')
  await expect(checks.getByRole('row').nth(1)).toBeVisible()

  await shot(page, 'staging-verification-checks')

  // The log of one check opens.
  await checks.getByRole('button', { name: 'Biometric log' }).first().click()
  await expect(page.getByTestId('biometric-log')).toBeVisible()
  await page.keyboard.press('Escape')

  // CSV: the header and as many lines as the console says it exported.
  const csvFile = await exportAs(page, 'CSV')
  expect(csvFile.suggestedFilename()).toMatch(/^face-checks-\d{4}-\d{2}-\d{2}\.csv$/)
  const said = page.getByText(/[\d,]+ rows? exported to face-checks-.*\.csv/)
  await expect(said).toBeVisible()
  const exportedRows = Number(((await said.textContent()) ?? '').match(/^([\d,]+) rows?/)?.[1].replaceAll(',', ''))
  const csv = readFileSync(await csvFile.path()).toString('utf8')
  expect(csv.charCodeAt(0)).toBe(0xfeff)
  expect(exportedRows).toBeGreaterThan(0)
  expect(csv.slice(1).trimEnd().split('\r\n')).toHaveLength(exportedRows + 1)

  // Excel: a real workbook with a header row.
  const workbook = await exportAs(page, 'Excel')
  expect(workbook.suggestedFilename()).toMatch(/^face-checks-\d{4}-\d{2}-\d{2}\.xlsx$/)
  const files = unzipSync(new Uint8Array(readFileSync(await workbook.path())))
  expect(strFromU8(files['xl/sharedStrings.xml'])).toContain('>Outcome<')
  expect(strFromU8(files['xl/worksheets/sheet1.xml'])).not.toContain('<f>')

  // From a check to its customer.
  await checks.getByRole('button', { name: 'Customer activity' }).first().click()
  await expect(page).toHaveURL(/\/customers\//)
  await expect(page.getByTestId('stat-customer-checks')).toBeVisible()
  await expect(page.getByTestId('stat-customer-proofs')).toBeVisible()

  await shot(page, 'staging-customer')

  // Set 2: system health. Monitoring pushes to platform-api, so a fresh heartbeat proves the whole path.
  await page.goto('/ops/health')
  await expect(page.getByRole('heading', { name: 'System health', exact: true })).toBeVisible()
  await expect(page.getByTestId('health-check-database')).toContainText('answering')
  await expect(page.getByTestId('health-check-agent')).toContainText('answering')
  await expect(page.getByTestId('health-check-agent')).not.toContainText('not answering')
  await expect(page.getByTestId('monitoring-signal')).toHaveAttribute('data-silent', 'false')
  await expect(page.getByTestId('alerts-firing')).not.toContainText('Watchdog')
  await expect(page.getByTestId('health-settings')).toContainText('Version')
  await shot(page, 'staging-health')

  // Set 2: the audit log's own period, set for the tenant and put back to the platform default.
  await page.goto(`/ops/tenants/${tenantId}/data-protection`)
  const inForce = page.getByTestId('audit-retention-in-force')
  await expect(inForce).toContainText('the platform default')
  const period = page.getByTestId('audit-retention-form')
  await period.getByLabel('Days').fill('365')
  await period.getByRole('button', { name: 'Save' }).click()
  await expect(inForce).toContainText('365 days (1 year)')
  await period.getByLabel('Days').fill('')
  await period.getByRole('button', { name: 'Save' }).click()
  await expect(inForce).toContainText('the platform default')
  await shot(page, 'staging-data-protection')

  // Set 2: approvals. The operator area's page (a server setting, no switch) and the tenant's.
  await page.getByRole('navigation', { name: 'Operator sections' }).getByRole('link', { name: 'Approvals', exact: true }).click()
  await expect(page.getByTestId('approval-requirement')).toContainText('Set on the server (OPERATOR_APPROVALS)')
  await page.goto(`/ops/tenants/${tenantId}/approvals`)
  await expect(page.getByTestId('approval-requirement')).toBeVisible()
  await page.getByTestId('approval-requirement').getByText('What waits for a second person').click()
  await expect(page.getByTestId('approval-types')).toContainText('Set the webhook endpoint')
  await expect(page.getByTestId('change-requests')).toBeVisible()
  await shot(page, 'staging-approvals')

  // The audit log holds this sign-in and the exports, under the operator's email.
  await page.goto('/ops/audit?kind=sign-in')
  const audit = page.getByTestId('audit-table')
  await expect(audit.getByRole('row').filter({ hasText: 'Signed in' }).first()).toContainText(email)
  await page.goto('/ops/audit?kind=export')
  const exported = audit.getByRole('row').filter({ hasText: 'List exported' })
  await expect(exported.first()).toContainText(email)
  await exported.first().getByRole('button', { name: 'Details' }).click()
  await expect(page.getByTestId('audit-changes')).toContainText('"list": "checks"')
  await expect(page.getByTestId('audit-changes')).toContainText('"format": "xlsx"')
})
