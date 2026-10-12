/**
 * The Verification page and the customer page (implement/22-console-feedback.md C10, C11) on a
 * seeded tenant, as an operator: proof outcomes, face-check outcomes, rejection reasons that filter
 * the list, the log of one check, and everything on one connection. Local run: the local
 * platform-api on 3510; the rows are written straight into its database, as lists.spec does.
 */
import { type Page, expect, test } from '@playwright/test'
import pg from 'pg'

import { PLATFORM_DATABASE_URL } from './env'
import { signInWithTotp } from './operator'

test.describe.configure({ mode: 'serial' })

interface Attempt {
  decision: 'passed' | 'failed'
  reason: string
  liveness: number | null
  match: number | null
}

/**
 * One customer (`user-ada`) with a credential and three proof requests of today: one verified after
 * a second face-check attempt, one stopped by a failed face check, one that did not verify.
 */
async function seed(name: string) {
  const db = new pg.Client({ connectionString: PLATFORM_DATABASE_URL })
  await db.connect()
  try {
    const tenantId = (await db.query<{ id: string }>("insert into tenants (name, agent_tenant_id, status) values ($1, $2, 'ready') returning id", [name, `e2e-${crypto.randomUUID()}`])).rows[0].id
    const now = new Date().toISOString()
    const templateId = (await db.query<{ id: string }>("insert into proof_templates (tenant_id, name, definition) values ($1, 'Approve transfer', '{\"groups\":[]}') returning id", [tenantId])).rows[0].id
    await db.query("insert into biometric_settings (tenant_id, enabled, default_policy) values ($1, true, '{\"required\":false,\"minMatchScore\":80,\"minLivenessScore\":85,\"maxAttempts\":3,\"ttlMinutes\":30}')", [tenantId])
    await db.query("insert into connections (tenant_id, record_id, state, external_id, their_label) values ($1, 'conn-ada', 'completed', 'user-ada', 'Ada phone'), ($1, 'conn-bob', 'completed', 'user-bob', null)", [tenantId])
    await db.query("insert into wallets (tenant_id, external_id, token_hash) values ($1, 'user-ada', $2)", [tenantId, `h-${crypto.randomUUID()}`])
    await db.query("insert into credentials (tenant_id, record_id, connection_id, state, external_id, credential_definition_id, attributes) values ($1, 'cred-1', 'conn-ada', 'done', 'user-ada', 'ABC:3:CL:12:default', '{}')", [tenantId])
    await db.query(
      "insert into proofs (tenant_id, record_id, connection_id, state, verified, template_id, external_id) values ($1, 'proof-ok', 'conn-ada', 'done', true, $2, 'user-ada'), ($1, 'proof-stopped', 'conn-ada', 'abandoned', null, $2, 'user-ada'), ($1, 'proof-bad', 'conn-ada', 'done', false, $2, 'user-ada')",
      [tenantId, templateId]
    )
    const gate = async (recordType: 'credential' | 'proof', recordId: string, status: 'passed' | 'failed', attempts: Attempt[]) => {
      const last = attempts.at(-1)
      const id = (
        await db.query<{ id: string }>(
          "insert into exchange_gates (tenant_id, record_type, record_id, thread_id, check_id, provider_id, status, attempts, max_attempts, thresholds, liveness_score, match_score, reason, expires_at, decided_at) values ($1, $2, $3, $4, $5, 'mock', $6, $7, 3, '{\"minLivenessScore\":85,\"minMatchScore\":80}', $8, $9, $10, $11, $12) returning id",
          [tenantId, recordType, recordId, `thread-${recordId}`, crypto.randomUUID(), status, attempts.length, last?.liveness ?? null, last?.match ?? null, last?.reason ?? null, new Date(Date.now() + 30 * 60_000).toISOString(), now]
        )
      ).rows[0].id
      for (const [index, attempt] of attempts.entries()) {
        await db.query(
          "insert into exchange_gate_events (gate_id, tenant_id, type, attempt, provider_id, liveness_score, match_score, thresholds, decision, reason) values ($1, $2, 'attempt_completed', $3, 'mock', $4, $5, '{\"minLivenessScore\":85,\"minMatchScore\":80}', $6, $7)",
          [id, tenantId, index + 1, attempt.liveness, attempt.match, attempt.decision, attempt.reason]
        )
      }
    }
    await gate('proof', 'proof-ok', 'passed', [{ decision: 'failed', reason: 'match_below_threshold', liveness: 95, match: 12 }, { decision: 'passed', reason: 'passed', liveness: 97, match: 99 }])
    await gate('credential', 'cred-1', 'passed', [{ decision: 'passed', reason: 'passed', liveness: 99, match: 91 }])
    await gate('proof', 'proof-stopped', 'failed', [{ decision: 'failed', reason: 'liveness_below_threshold', liveness: 45, match: null }, { decision: 'failed', reason: 'match_below_threshold', liveness: 93, match: 55 }, { decision: 'failed', reason: 'no_face', liveness: 96, match: null }])
    return tenantId
  } finally {
    await db.end()
  }
}

const tenantNav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Tenant sections' }).getByRole('link', { name, exact: true })
const tile = (page: Page, testId: string) => page.getByTestId(testId)

/** Optional screenshots for a look at the charts (E2E_SHOTS=<dir>); the run does not depend on them. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true })
}

test('proof and face-check outcomes, with the way from a number to the records and to one customer', async ({ page }) => {
  test.setTimeout(240_000)
  const tenantId = await seed(`Outcomes ${Date.now()}`)
  await signInWithTotp(page)

  // The tenant overview carries the headline numbers and the way to the page.
  await page.goto(`/ops/tenants/${tenantId}`)
  await expect(page.getByTestId('verification-summary')).toContainText('1 of 3 proof requests verified')
  await expect(page.getByTestId('verification-summary')).toContainText('2 of 3 face checks passed (67% of those decided)')

  // Proofs: what was asked, what was verified, and where the rest went.
  await tenantNav(page, 'Verification').click()
  await expect(page.getByRole('heading', { name: 'Verification', exact: true })).toBeVisible()
  await expect(tile(page, 'stat-proof-requests')).toContainText('3')
  await expect(tile(page, 'stat-proof-verified')).toContainText('33% of the 3 that finished')
  await expect(tile(page, 'stat-proof-abandoned')).toContainText('1')
  await expect(tile(page, 'stat-proof-failed')).toContainText('1')
  await expect(page.getByTestId('proof-outcome-chart').locator('svg').first()).toBeVisible()
  await expect(page.getByTestId('proof-outcome-chart')).toContainText('Not verified')
  const template = page.getByTestId('template-outcomes').getByRole('row').filter({ hasText: 'Approve transfer' })
  await expect(template).toContainText('33%')
  await shot(page, 'verification-proofs')

  // The window lives in the URL and the page re-reads it.
  await page.getByRole('tab', { name: '7 days' }).click()
  await expect(page).toHaveURL(/days=7/)
  await expect(page.getByText('over the last 7 days')).toBeVisible()

  // Face checks: outcomes, reasons per turned-down attempt, score spread against the minimum.
  await page.getByRole('tab', { name: 'Face checks' }).click()
  await expect(page).toHaveURL(/tab=checks/)
  await expect(tile(page, 'stat-checks')).toContainText('1 for issuance · 2 for proofs')
  await expect(tile(page, 'stat-checks-passed')).toContainText('67% of the 3 decided')
  await expect(tile(page, 'stat-checks-failed')).toContainText('1')
  await expect(page.getByTestId('check-outcome-chart').locator('svg').first()).toBeVisible()
  const reasons = page.getByTestId('rejection-reasons')
  await expect(reasons.getByRole('button').first()).toContainText('Face did not match the reference')
  await expect(reasons.getByRole('button').first()).toContainText('2')
  await expect(page.getByTestId('attempts-to-pass')).toContainText('1 attempt: 1 · 2 attempts: 1')
  await expect(page.getByTestId('liveness-scores')).toContainText('minimum 85')
  await expect(page.getByTestId('liveness-scores')).toContainText('6 scored attempts')
  await expect(page.getByTestId('match-scores')).toContainText('minimum 80')
  const checks = page.getByTestId('checks-table')
  await expect(checks.getByRole('row')).toHaveCount(4)
  await shot(page, 'verification-checks')
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, 'verification-checks-dark')
  await page.emulateMedia({ colorScheme: 'light' })

  // A reason filters the list to the checks it happened in; the filter is in the URL.
  await reasons.getByRole('button', { name: /No face found/ }).click()
  await expect(page).toHaveURL(/reason=no_face/)
  await expect(checks.getByRole('row')).toHaveCount(2)
  await expect(checks.getByRole('row').nth(1)).toContainText('failed')
  await expect(checks.getByRole('row').nth(1)).toContainText('user-ada')

  // The log of that check: every attempt, with its scores against the minimums.
  await checks.getByRole('button', { name: 'Biometric log' }).click()
  await expect(page.getByTestId('biometric-log')).toContainText('liveness_below_threshold')
  await expect(page.getByTestId('biometric-log')).toContainText('45.0 / 85')
  await page.keyboard.press('Escape')

  // The outcome filter and Reset.
  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page).not.toHaveURL(/reason=/)
  await expect(page).toHaveURL(/tab=checks/)
  await page.getByTestId('check-status-filter').click()
  await page.getByRole('menuitemcheckbox', { name: 'passed', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/status=/)
  await expect(checks.getByRole('row')).toHaveCount(3)

  // From a check to its customer: one connection, with its numbers, wallets and records.
  await checks.getByRole('button', { name: 'Customer activity' }).first().click()
  await expect(page).toHaveURL(/\/customers\/conn-ada/)
  await expect(page.getByRole('heading', { name: 'user-ada' })).toBeVisible()
  await expect(tile(page, 'stat-customer-credentials')).toContainText('1')
  await expect(tile(page, 'stat-customer-proofs')).toContainText('33% of 3 requests · 1 failed verification')
  await expect(tile(page, 'stat-customer-checks')).toContainText('1 failed · 0 expired · 3 in all')
  await expect(page.getByTestId('customer-wallets').getByRole('row')).toHaveCount(2)
  await expect(page.getByTestId('credentials-table').getByRole('row')).toHaveCount(2)
  await page.getByRole('tab', { name: 'Proof exchanges' }).click()
  await expect(page).toHaveURL(/tab=proofs/)
  await expect(page.getByTestId('proofs-table').getByRole('row')).toHaveCount(4)
  await page.getByRole('tab', { name: 'Face checks' }).click()
  await expect(page.getByTestId('checks-table').getByRole('row')).toHaveCount(4)
  await shot(page, 'customer')

  // And from the connections list.
  await tenantNav(page, 'Exchanges').click()
  await page.getByTestId('connections-table').getByRole('row').filter({ hasText: 'user-bob' }).getByRole('button', { name: 'Activity' }).click()
  await expect(page).toHaveURL(/\/customers\/conn-bob/)
  await expect(page.getByRole('heading', { name: 'user-bob' })).toBeVisible()
  await expect(page.getByText('No wallet is registered under this external id.')).toBeVisible()

  // The operator dashboard sums the window across tenants.
  await page.goto('/ops')
  await expect(tile(page, 'stat-proofs-verified')).toBeVisible()
  await expect(tile(page, 'stat-face-checks-passed')).toContainText('passed')

  // Nothing overflows sideways on a phone.
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(`/ops/tenants/${tenantId}/verification?tab=checks`)
  await expect(page.getByTestId('checks-table')).toBeVisible()
  await expect(page.getByTestId('check-outcome-chart').locator('svg').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth)).toBe(true)
  await shot(page, 'verification-checks-phone')
})
