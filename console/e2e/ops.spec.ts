/**
 * Operator console screens (stage 4a) against the local platform-api. Its agent-service is not
 * running locally, so tenant creation surfaces platform-api's refusal instead of succeeding; the
 * cross-tenant pages, operator management and the audit trail are exercised for real.
 */
import { readFileSync } from 'node:fs'

import { expect, test } from '@playwright/test'

import { operator, signInWithTotp } from './operator'

test.describe.configure({ mode: 'serial' })

test('operator screens load through the console scope', async ({ page }) => {
  test.setTimeout(120_000)
  await signInWithTotp(page)

  await page.getByRole('link', { name: 'Dead deliveries' }).click()
  await expect(page.getByRole('heading', { name: 'Dead webhook deliveries' })).toBeVisible()

  await page.getByRole('link', { name: 'Audit log' }).click()
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()

  await page.getByRole('link', { name: 'Operators', exact: true }).click()
  await expect(page.getByTestId('operators-table')).toContainText(operator().email)
  await expect(page.getByTestId('operators-table')).toContainText('you')

  // Inviting an operator (dialog) creates the account and emails a set-password link.
  const invitee = `invited+${Date.now()}@12id.test`
  await page.getByRole('button', { name: 'Add operator' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Invited Operator')
  await page.getByLabel('Email', { exact: true }).fill(invitee)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByTestId('operators-table')).toContainText(invitee)
  const outbox = readFileSync('test-results/mail.jsonl', 'utf8')
  expect(outbox).toContain(invitee)
  expect(outbox).toContain('/api/auth/reset-password/')

  // Tenant creation reaches platform-api, which cannot onboard without agent-service: the error is shown, no crash.
  await page.getByRole('link', { name: 'Tenants', exact: true }).click()
  await page.getByRole('button', { name: 'New tenant' }).click()
  // Submitting the empty dialog shows a field error, not a browser bubble.
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await expect(page.getByRole('dialog').getByRole('alert').first()).toContainText('Enter the organization name.')
  await page.getByLabel('Organization name').fill('Acme E2E')
  await page.getByRole('button', { name: 'Create tenant' }).click()
  await expect(page.getByRole('dialog').getByRole('alert').or(page.getByText(/onboarding|created|Acme E2E/i).first())).toBeVisible({ timeout: 30_000 })
})
