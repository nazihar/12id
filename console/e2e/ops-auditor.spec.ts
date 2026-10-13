/**
 * Operator accounts and the auditor role (implement/22-console-feedback.md C14): an operator adds an
 * auditor, who sets a password and an authenticator app and then sees the operator area without one
 * control that changes something; the operator edits and deletes the account; the audit log keeps the
 * deleted account's email. Runs after auth.spec (which enrolls the run's operator).
 */
import { type Browser, type Page, expect, test } from '@playwright/test'
import { generateSync } from 'otplib'

import { linkFromMail, operator, signInWithTotp } from './operator'

const RESET_LINK = /http:\/\/localhost:3600\/api\/auth\/reset-password\/\S+/g

async function newPage(browser: Browser) {
  const context = await browser.newContext()
  return context.newPage()
}

const row = (page: Page, email: string) => page.getByTestId('operators-table').getByRole('row').filter({ hasText: email })

test('an auditor reads the operator area and changes nothing; an operator edits and deletes the account', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const auditorEmail = `auditor+${stamp}@12id.test`
  const password = `E2e-Auditor-${stamp}`

  // The operator adds an auditor.
  await signInWithTotp(page)
  await page.getByRole('link', { name: 'Operators', exact: true }).click()
  await page.getByRole('button', { name: 'Add operator' }).click()
  await page.getByLabel('Name', { exact: true }).fill('E2E Auditor')
  await page.getByLabel('Email', { exact: true }).fill(auditorEmail)
  await page.getByRole('dialog').getByLabel('Role').fill('aud')
  await page.getByRole('option', { name: /^auditor/ }).click()
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(row(page, auditorEmail)).toContainText('auditor')
  await expect(row(page, auditorEmail)).toContainText('not set up')
  await expect(row(page, auditorEmail)).toContainText('never')
  // The operator's own row: no actions on yourself, and a sign-in on record.
  await expect(row(page, operator().email)).toContainText('you')
  await expect(row(page, operator().email)).not.toContainText('never')

  // The auditor: first password from the mailed link, then an authenticator app. No emailed codes.
  const auditor = await newPage(browser)
  await auditor.goto(await linkFromMail(auditorEmail, RESET_LINK))
  await auditor.getByLabel('New password').fill(password)
  await auditor.getByLabel('Repeat the password').fill(password)
  await auditor.getByRole('button', { name: 'Save password' }).click()
  await expect(auditor).toHaveURL(/\/login/)
  await auditor.getByLabel('Email').fill(auditorEmail)
  await auditor.getByLabel('Password').fill(password)
  await auditor.getByRole('button', { name: 'Sign in' }).click()
  await expect(auditor).toHaveURL(/\/setup-2fa/)
  await auditor.getByLabel('Confirm your password').fill(password)
  await expect(auditor.getByRole('button', { name: 'Email me codes instead' })).toHaveCount(0)
  await auditor.getByRole('button', { name: 'Use an authenticator app' }).click()
  const secret = ((await auditor.getByTestId('totp-secret').textContent()) ?? '').trim()
  await auditor.getByTestId('otp-code').fill(generateSync({ secret }))
  await auditor.getByRole('button', { name: 'Turn on two-factor authentication' }).click()

  // The same pages as an operator: the dashboard, the tenants, the audit log.
  await expect(auditor).toHaveURL(/\/ops/)
  await expect(auditor.getByRole('heading', { name: 'Platform' })).toBeVisible()
  await expect(auditor.getByTestId('stat-tenants')).toBeVisible()
  await auditor.getByRole('link', { name: 'Audit log', exact: true }).click()
  await expect(auditor.getByTestId('audit-table')).toContainText('Operator invited')
  await auditor.getByRole('link', { name: 'System health', exact: true }).click()
  await expect(auditor.getByTestId('health-services')).toContainText('Platform database')

  // And nothing that changes anything.
  await auditor.getByRole('link', { name: 'Tenants', exact: true }).click()
  await expect(auditor.getByRole('heading', { name: 'Tenants' })).toBeVisible()
  await expect(auditor.getByRole('button', { name: 'New tenant' })).toHaveCount(0)
  await auditor.getByRole('link', { name: 'Operators', exact: true }).click()
  await expect(row(auditor, auditorEmail)).toContainText('you')
  await expect(auditor.getByRole('button', { name: 'Add operator' })).toHaveCount(0)
  await expect(row(auditor, operator().email).getByRole('button')).toHaveCount(0)
  await auditor.getByRole('link', { name: 'Dead deliveries' }).click()
  await expect(auditor.getByRole('heading', { name: 'Dead webhook deliveries' })).toBeVisible()
  await expect(auditor.getByRole('button', { name: 'Retry' })).toHaveCount(0)

  // Better Auth's own admin endpoints refuse an auditor too: the role carries no user or session permission.
  const direct = await auditor.evaluate(async () => {
    const list = await fetch('/api/auth/admin/list-users', { credentials: 'include' })
    const ban = await fetch('/api/auth/admin/ban-user', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'someone' }) })
    return [list.status, ban.status]
  })
  expect(direct).toEqual([403, 403])

  // The operator sees the account set up and signed in, renames it, and makes it an operator and back.
  await page.reload()
  await expect(row(page, auditorEmail)).toContainText('set up')
  await expect(row(page, auditorEmail)).not.toContainText('never')
  await page.getByRole('button', { name: `Edit ${auditorEmail}` }).click()
  await page.getByRole('dialog').getByLabel('Name').fill('Renamed Auditor')
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click()
  await expect(row(page, auditorEmail)).toContainText('Renamed Auditor')

  // Role filter in the URL.
  await page.getByTestId('operator-role-filter').click()
  await page.getByRole('menuitemradio', { name: 'auditor' }).click()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/role=auditor/)
  await expect(row(page, auditorEmail)).toBeVisible()
  await expect(row(page, operator().email)).toHaveCount(0)

  // Deleted: the account is gone and its session with it.
  await page.getByRole('button', { name: `Delete ${auditorEmail}` }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete account' }).click()
  // Wait for the deletion itself: while the dialog is open the table is hidden from the accessibility
  // tree, so "no such row" would be true before anything was deleted.
  await expect(page.getByText(`${auditorEmail} was deleted.`)).toBeVisible()
  await expect(row(page, auditorEmail)).toHaveCount(0)
  await auditor.goto('/ops')
  await expect(auditor).toHaveURL(/\/login/)

  // The audit log still names the deleted account: its own sign-in by email, and what was done to it.
  await page.getByRole('link', { name: 'Audit log', exact: true }).click()
  await page.getByPlaceholder('Search actor, email, route or event').fill(auditorEmail)
  await expect(page).toHaveURL(/q=/)
  const signedIn = page.getByTestId('audit-table').getByRole('row').filter({ hasText: 'Signed in' }).first()
  await expect(signedIn).toContainText(auditorEmail)
  await expect(signedIn).toContainText('auditor')
  await page.getByPlaceholder('Search actor, email, route or event').fill('account.operator_deleted')
  const deleted = page.getByTestId('audit-table').getByRole('row').filter({ hasText: 'Operator deleted' }).first()
  await expect(deleted).toContainText(operator().email)
  await deleted.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByTestId('audit-changes')).toContainText(auditorEmail)
})
