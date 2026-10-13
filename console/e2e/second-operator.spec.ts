/**
 * Changes to operator accounts wait for a second operator (implement/22-console-feedback.md C18),
 * when the deployment asks for it. Run only against a platform-api started with
 * `OPERATOR_APPROVALS=on` (`E2E_OPERATOR_APPROVALS=on` says so): with the setting on, the specs that
 * add operators directly would be held, so this spec has a run of its own.
 *
 *   E2E_OPERATOR_APPROVALS=on npx playwright test auth second-operator
 *
 * The second operator exists before the first one asks for anything, as the setting requires. It is
 * created the way the first operator of a deployment is, through the Better Auth CLI.
 */
import { execFileSync } from 'node:child_process'

import { type Browser, type Page } from '@playwright/test'
import { generateSync } from 'otplib'

import { expect, test, watchCsp } from './csp'
import { consoleEnv } from './env'
import { linkFromMail, operator, signInWithTotp } from './operator'

const RESET_LINK = /http:\/\/localhost:3600\/api\/auth\/reset-password\/\S+/g

test.skip(process.env.E2E_OPERATOR_APPROVALS !== 'on', 'needs a platform-api started with OPERATOR_APPROVALS=on')

async function newPage(browser: Browser) {
  const context = await browser.newContext()
  return context.newPage()
}

const confirm = (page: Page, name: string) => page.getByRole('alertdialog').getByRole('button', { name, exact: true }).click()
const request = (page: Page, text: string) => page.getByTestId('change-requests').getByRole('row').filter({ hasText: text })
const operators = (page: Page) => page.getByTestId('operators-table')

test('adding an operator account waits for a second operator, and is applied by the one who asked', async ({ browser, page, cspViolations }) => {
  test.setTimeout(300_000)
  const stamp = Date.now()
  const second = { email: `second-operator+${stamp}@12id.test`, password: `E2e-Second-${stamp}` }
  const added = `added-operator+${stamp}@12id.test`

  // The second operator, with an authenticator app like every operator.
  execFileSync('npx', ['auth', 'create-admin', '--config', 'src/server/auth.server.ts', '--email', second.email, '--password', second.password, '--name', 'Second-Operator', '--role', 'operator', '--force', '--yes'], {
    env: { ...process.env, ...consoleEnv },
    stdio: 'inherit',
    shell: true,
  })
  const approver = await newPage(browser)
  watchCsp(approver, cspViolations)
  await approver.goto('/login')
  await approver.getByLabel('Email').fill(second.email)
  await approver.getByLabel('Password').fill(second.password)
  await approver.getByRole('button', { name: 'Sign in' }).click()
  await expect(approver).toHaveURL(/\/setup-2fa/)
  await approver.getByLabel('Confirm your password').fill(second.password)
  await approver.getByRole('button', { name: 'Use an authenticator app' }).click()
  const secret = ((await approver.getByTestId('totp-secret').textContent()) ?? '').trim()
  await approver.getByTestId('otp-code').fill(generateSync({ secret }))
  await approver.getByRole('button', { name: 'Turn on two-factor authentication' }).click()
  await expect(approver).toHaveURL(/\/ops/)

  // The first operator asks for a new account: it is not created.
  await signInWithTotp(page)
  await page.getByRole('link', { name: 'Approvals', exact: true }).click()
  await expect(page.getByTestId('approval-requirement')).toHaveAttribute('data-required', 'true')
  await expect(page.getByTestId('approval-requirement')).toContainText('Set on the server (OPERATOR_APPROVALS)')
  await page.getByRole('link', { name: 'Operators', exact: true }).click()
  await page.getByRole('button', { name: 'Add operator' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Added Operator')
  await page.getByLabel('Email', { exact: true }).fill(added)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText(`Sent for approval: Add ${added} as operator.`)).toBeVisible()
  await expect(page.getByTestId('pending-changes')).toContainText(`Add ${added} as operator, asked by you.`)
  await expect(operators(page)).not.toContainText(added)
  await expect(page.getByTestId('nav-count-approvals')).toHaveText('1')
  await page.reload()
  await expect(page.getByTestId('pending-changes')).toContainText('asked by you')

  // The second operator approves; nothing is created by that either.
  await approver.getByRole('link', { name: 'Approvals', exact: true }).click()
  const invite = 'Add an operator account'
  await expect(request(approver, invite)).toContainText(operator().email)
  await request(approver, invite).getByRole('button', { name: 'Approve' }).click()
  await confirm(approver, 'Approve')
  await expect(approver.getByText('Approved.')).toBeVisible()
  await approver.getByRole('link', { name: 'Operators', exact: true }).click()
  await expect(operators(approver)).not.toContainText(added)

  // The one who asked applies it, under their own session: the account exists and gets its link.
  await page.getByRole('link', { name: 'Approvals', exact: true }).click()
  await expect(request(page, invite)).toContainText('approved: apply it now')
  await request(page, invite).getByRole('button', { name: 'Apply' }).click()
  await confirm(page, 'Apply')
  await expect(page.getByText('Applied.')).toBeVisible()
  await page.getByRole('link', { name: 'Operators', exact: true }).click()
  await expect(operators(page)).toContainText(added)
  expect(await linkFromMail(added, RESET_LINK)).toContain('/reset-password/')

  // Banning never waits; unbanning does.
  const row = operators(page).getByRole('row').filter({ hasText: added })
  await row.getByRole('button', { name: 'Ban' }).click()
  await confirm(page, 'Ban account')
  await expect(page.getByText(`${added} is banned and signed out.`)).toBeVisible()
  await row.getByRole('button', { name: 'Unban' }).click()
  await confirm(page, 'Unban')
  await expect(page.getByText(`Sent for approval: Unban ${added}.`)).toBeVisible()
  await expect(row).toContainText('banned')

  // The audit log: who asked, who approved, and the account that was added because of it.
  await page.goto('/ops/audit?kind=approval')
  await expect(page.getByTestId('audit-table')).toContainText('POST /admin/change-requests/:id/approve')
  await expect(page.getByTestId('audit-table')).toContainText(second.email)
  await page.goto('/ops/audit?kind=account')
  await page.getByTestId('audit-table').getByRole('row').filter({ hasText: 'Operator invited' }).first().getByRole('button', { name: 'Details' }).click()
  await expect(page.getByTestId('audit-changes')).toContainText(second.email)
  await expect(page.getByTestId('audit-changes')).toContainText(added)
})
