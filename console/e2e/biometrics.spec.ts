/**
 * Phase 6 biometric gate in the console. Local run: platform-api on 3510 with BIOMETRIC_SERVICE_URL,
 * and biometric-service on 3530 with BIOMETRIC_ENABLE_MOCK=true (so the only provider is `mock`).
 * Recipe in 17-phase-6-biometric-findings.md ("Console Playwright").
 *
 * An owner configures the provider, runs the connection test and switches the gate on; sets a
 * template's face-check policy; sees the Biometric column and the biometric log on a (seeded) gated
 * exchange. The operator sees the tenant's settings read-only and the same log.
 */
import { type Page, expect, test } from '@playwright/test'
import pg from 'pg'

import { PLATFORM_DATABASE_URL } from './env'
import { linkFromMail, signInWithTotp } from './operator'

test.describe.configure({ mode: 'serial' })

const RESET_LINK = /http:\/\/localhost:3600\/api\/auth\/reset-password\/\S+/g
const slugFor = (name: string, tenantId: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${tenantId.slice(0, 8)}`

async function withPlatformDb<T>(fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: PLATFORM_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** A ready tenant, a proof template and one gated credential exchange with its biometric log. */
async function seed(name: string) {
  return withPlatformDb(async (db) => {
    const tenantId = (await db.query<{ id: string }>("insert into tenants (name, agent_tenant_id, status) values ($1, $2, 'ready') returning id", [name, `e2e-${crypto.randomUUID()}`])).rows[0].id
    const definition = { name: 'Badge check', groups: [{ key: 'badge', attributes: ['name'], credentials: [{ schemaName: 'employee-badge', versions: 'all' }] }] }
    await db.query('insert into proof_templates (tenant_id, name, definition) values ($1, $2, $3)', [tenantId, 'Badge check', definition])
    const recordId = `cred-${crypto.randomUUID()}`
    await db.query("insert into credentials (tenant_id, record_id, connection_id, state, thread_id, credential_definition_id, attributes) values ($1, $2, 'conn-1', 'done', $3, 'ABC:3:CL:12:default', '{}')", [tenantId, recordId, `thread-${recordId}`])
    const thresholds = { minLivenessScore: 90, minMatchScore: 90 }
    const gateId = (
      await db.query<{ id: string }>(
        "insert into exchange_gates (tenant_id, record_type, record_id, thread_id, check_id, provider_id, status, attempts, max_attempts, thresholds, liveness_score, match_score, reason, expires_at, hold_reached_at, decided_at, settled_at) values ($1, 'credential', $2, $3, gen_random_uuid(), 'mock', 'passed', 2, 3, $4, 97, 99, 'passed', now() + interval '30 minutes', now(), now(), now()) returning id",
        [tenantId, recordId, `thread-${recordId}`, thresholds]
      )
    ).rows[0].id
    const events: Array<[string, Record<string, unknown>]> = [
      ['gate_created', { thresholds }],
      ['session_started', { attempt: 1, vendor_session_id: 'mock-session-1' }],
      ['attempt_completed', { attempt: 1, vendor_session_id: 'mock-session-1', liveness_score: 97, match_score: 12, thresholds, decision: 'failed', reason: 'match_below_threshold' }],
      ['session_started', { attempt: 2, vendor_session_id: 'mock-session-2' }],
      ['attempt_completed', { attempt: 2, vendor_session_id: 'mock-session-2', liveness_score: 97, match_score: 99, thresholds, decision: 'passed', reason: 'passed' }],
      ['hold_reached', {}],
      ['issued', {}],
    ]
    for (const [type, e] of events) {
      await db.query(
        "insert into exchange_gate_events (gate_id, tenant_id, type, provider_id, attempt, vendor_session_id, liveness_score, match_score, thresholds, decision, reason) values ($1, $2, $3, 'mock', $4, $5, $6, $7, $8, $9, $10)",
        [gateId, tenantId, type, e.attempt ?? null, e.vendor_session_id ?? null, e.liveness_score ?? null, e.match_score ?? null, e.thresholds ?? null, e.decision ?? null, e.reason ?? null]
      )
    }
    return tenantId
  })
}

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Organization sections' }).getByRole('link', { name, exact: true })

test('owners configure the biometric gate and audit it per exchange; operators see it read-only', async ({ browser, page }) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const name = `Biometric ${stamp}`
  const tenantId = await seed(name)
  const ownerEmail = `bio-owner+${stamp}@12id.test`
  const password = `Bio-E2e-${stamp}`

  // Operator: an organization with its owner.
  await signInWithTotp(page)
  await page.goto(`/ops/tenants/${tenantId}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await page.getByLabel('Owner name').fill('E2E Owner')
  await page.getByLabel('Owner email').fill(ownerEmail)
  await page.getByRole('dialog').getByRole('button', { name: 'Create organization' }).click()
  await expect(page.getByTestId('members-table')).toContainText(ownerEmail)

  // Owner: password from the mail, email codes.
  const owner = await (await browser.newContext()).newPage()
  await owner.goto(await linkFromMail(ownerEmail, RESET_LINK))
  await owner.getByLabel('New password').fill(password)
  await owner.getByLabel('Repeat the password').fill(password)
  await owner.getByRole('button', { name: 'Save password' }).click()
  await owner.getByLabel('Email').fill(ownerEmail)
  await owner.getByLabel('Password').fill(password)
  await owner.getByRole('button', { name: 'Sign in' }).click()
  await expect(owner).toHaveURL(/\/setup-2fa/)
  await owner.getByLabel('Confirm your password').fill(password)
  await owner.getByRole('button', { name: 'Email me codes instead' }).click()
  await expect(owner).toHaveURL(/\/account/)
  await owner.goto(`/t/${slugFor(name, tenantId)}`)

  // Biometrics: provider → test → switch on.
  await tab(owner, 'Biometrics').click()
  await expect(owner.getByText('No provider configured')).toBeVisible()
  await owner.getByTestId('aws-setup').locator('summary').click()
  await expect(owner.getByTestId('aws-setup')).toContainText(/12id-[0-9a-f-]{36}/)
  await owner.getByRole('button', { name: 'Configure provider' }).click()
  await owner.getByRole('dialog').getByRole('button', { name: 'Save provider' }).click()
  await expect(owner.getByText('Provider saved. Run the connection test next.')).toBeVisible()
  await expect(owner.getByText('untested')).toBeVisible()
  await owner.getByRole('button', { name: 'Test connection' }).click()
  await expect(owner.getByText('Connection test passed.')).toBeVisible()
  await expect(owner.getByText('ok', { exact: true })).toBeVisible()
  await owner.getByRole('switch', { name: 'Biometric gate on' }).click()
  await owner.getByLabel('Minimum face match (0–100)').fill('92')
  await owner.getByRole('button', { name: 'Save settings' }).click()
  await expect(owner.getByText('Biometric settings saved.')).toBeVisible()
  await owner.reload()
  await expect(owner.getByRole('switch', { name: 'Biometric gate on' })).toBeChecked()
  await expect(owner.getByLabel('Minimum face match (0–100)')).toHaveValue('92')

  // Template policy: default → always.
  await tab(owner, 'Proof templates').click()
  const row = owner.getByRole('row', { name: /Badge check/ })
  await expect(row).toContainText('default')
  await row.getByRole('button', { name: 'Face check' }).click()
  const dialog = owner.getByRole('dialog')
  await dialog.getByLabel('Face check').fill('Always')
  await owner.getByRole('option', { name: 'Always require a face check' }).click()
  await dialog.getByLabel('Minimum match').fill('95')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(owner.getByText('Face check policy saved.')).toBeVisible()
  await expect(owner.getByRole('row', { name: /Badge check/ })).toContainText('required')

  // Exchanges: the Biometric column and the log.
  await tab(owner, 'Exchanges').click()
  await expect(owner.getByTestId('biometric-cell').first()).toContainText('passed')
  await expect(owner.getByTestId('biometric-cell').first()).toContainText('match 99.0')
  await owner.getByRole('button', { name: 'Biometric log' }).first().click()
  const log = owner.getByTestId('biometric-log')
  await expect(log).toContainText('2 attempts')
  await expect(log).toContainText('Check required')
  await expect(log).toContainText('12.0 / 90')
  await expect(log).toContainText('match_below_threshold')
  await expect(log).toContainText('99.0 / 90')
  await expect(log).toContainText('mock-session-2')
  await expect(log).toContainText('Credential issued')

  // Operator: read-only settings and the same log.
  await page.goto(`/ops/tenants/${tenantId}/biometrics`)
  await expect(page.getByText('On; required only where a definition or template says so.')).toBeVisible()
  await expect(page.getByText('Minimum match 92')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Configure provider' })).toHaveCount(0)
  await page.goto(`/ops/tenants/${tenantId}/exchanges`)
  await page.getByRole('button', { name: 'Biometric log' }).first().click()
  await expect(page.getByTestId('biometric-log')).toContainText('mock-session-1')
})
