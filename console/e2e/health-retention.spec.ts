/**
 * The System health page and the audit log's period (implement/22-console-feedback.md C16, C15), as
 * an operator against the local platform-api on 3510.
 *
 * Monitoring is played by the test: it posts to the webhook Alertmanager posts to, with the secret the
 * local platform-api was started with (`ALERT_WEBHOOK_SECRET`, see env.ts). Without that secret the
 * webhook answers 404 and the alert part is skipped.
 */
import type { Page } from '@playwright/test'
import pg from 'pg'

import { expect, test } from './csp'
import { ALERT_WEBHOOK_SECRET, PLATFORM_DATABASE_URL, consoleEnv } from './env'
import { signInWithTotp } from './operator'

const WEBHOOK = `${consoleEnv.PLATFORM_API_URL}/internal/alerts`

/** One Alertmanager notification, as its webhook receiver sends it. */
function notify(alerts: Array<{ name: string; status: 'firing' | 'resolved'; severity: string; startsAt: string; endsAt?: string; summary?: string; instance?: string }>) {
  return fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ALERT_WEBHOOK_SECRET}` },
    body: JSON.stringify({
      version: '4',
      status: 'firing',
      receiver: 'console',
      alerts: alerts.map((alert) => ({
        status: alert.status,
        labels: { alertname: alert.name, severity: alert.severity, ...(alert.instance ? { instance: alert.instance } : {}) },
        annotations: alert.summary ? { summary: alert.summary } : {},
        startsAt: alert.startsAt,
        endsAt: alert.endsAt ?? '0001-01-01T00:00:00Z',
        fingerprint: `e2e-${alert.name}`,
      })),
    }),
  })
}

async function withPlatformDb<T>(run: (db: pg.Client) => Promise<T>) {
  const db = new pg.Client({ connectionString: PLATFORM_DATABASE_URL })
  await db.connect()
  try {
    return await run(db)
  } finally {
    await db.end()
  }
}

/** Optional screenshots for a look at the pages (E2E_SHOTS=<dir>); the run does not depend on them. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true })
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

test('system health: services, what monitoring reports, and what is running', async ({ page }) => {
  test.setTimeout(180_000)
  // Monitoring has said nothing yet in this run.
  await withPlatformDb((db) => db.query('delete from platform_alerts'))
  const connected = (await notify([])).status !== 404

  await signInWithTotp(page)
  await page.getByRole('navigation', { name: 'Operator sections' }).getByRole('link', { name: 'System health', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'System health', exact: true })).toBeVisible()

  // The local platform-api has no agent-service to call: the check says so and leads the summary.
  await expect(page.getByTestId('health-check-database')).toContainText('answering')
  await expect(page.getByTestId('health-check-agent')).toContainText('not answering')
  await expect(page.getByTestId('health-summary')).toContainText('Agent service is not answering.')
  await expect(page.getByTestId('health-summary')).toHaveAttribute('data-level', 'critical')

  // What is running: platform-api's allow-list and the console's own few, and no secret.
  const settings = page.getByTestId('health-settings')
  await expect(settings).toContainText('Audit log')
  await expect(settings).toContainText('730 days')
  await expect(settings).toContainText('Mail is sent as')
  await expect(settings).toContainText('12 hours')
  await expect(settings).not.toContainText(consoleEnv.CONSOLE_TOKEN)
  await expect(settings).not.toContainText(ALERT_WEBHOOK_SECRET)

  test.skip(!connected, 'the local platform-api was started without ALERT_WEBHOOK_SECRET')
  await expect(page.getByTestId('alerts-firing')).toContainText('No alert is firing.')
  await expect(page.getByText('Monitoring has not reported yet.')).toBeVisible()

  // Monitoring reports: its heartbeat, one critical alert, and one that already ended.
  const reported = await notify([
    { name: 'Watchdog', status: 'firing', severity: 'none', startsAt: ago(600) },
    { name: 'EndpointDown', status: 'firing', severity: 'critical', startsAt: ago(125), summary: 'https://api.12id.test/v1/health is failing from the VM', instance: 'https://api.12id.test/v1/health' },
    { name: 'DiskSpaceLow', status: 'resolved', severity: 'warning', startsAt: ago(300), endsAt: ago(240), summary: 'Less than 15% free on /' },
  ])
  expect(reported.status).toBe(200)
  await page.reload()
  const firing = page.getByTestId('alerts-firing')
  await expect(firing.getByRole('row')).toHaveCount(2)
  await expect(firing).toContainText('EndpointDown')
  await expect(firing).toContainText('critical')
  await expect(firing).toContainText('https://api.12id.test/v1/health is failing from the VM')
  await expect(firing).toContainText('2 h 5 min')
  await expect(firing).not.toContainText('Watchdog')
  const resolved = page.getByTestId('alerts-resolved')
  await expect(resolved).toContainText('DiskSpaceLow')
  await expect(resolved).toContainText('1 h')
  await expect(page.getByTestId('monitoring-signal')).toHaveAttribute('data-silent', 'false')
  await expect(page.getByText(/Monitoring last reported under a minute before this page was loaded\./)).toBeVisible()

  await shot(page, 'health')
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, 'health-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  await shot(page, 'health-phone')
  await page.setViewportSize({ width: 1280, height: 720 })

  // The dashboard carries the count and the way here.
  await page.goto('/ops')
  await expect(page.getByTestId('alerts-firing-count')).toContainText('1 alert firing')
  await page.getByTestId('health-strip').getByRole('link', { name: 'System health' }).click()
  await expect(page).toHaveURL(/\/ops\/health/)

  // It ends: nothing fires, and the list of what ended has it.
  await notify([{ name: 'EndpointDown', status: 'resolved', severity: 'critical', startsAt: ago(125), endsAt: ago(1), instance: 'https://api.12id.test/v1/health' }])
  await page.reload()
  await expect(page.getByTestId('alerts-firing')).toContainText('No alert is firing.')
  await expect(page.getByTestId('alerts-resolved')).toContainText('EndpointDown')
  await page.goto('/ops')
  await expect(page.getByTestId('alerts-firing-count')).toHaveCount(0)
})

test('the audit log has its own period, a year at least', async ({ page }) => {
  test.setTimeout(180_000)
  const name = `Audit period ${Date.now()}`
  const tenantId = await withPlatformDb(async (db) => (await db.query<{ id: string }>("insert into tenants (name, agent_tenant_id, status) values ($1, $2, 'ready') returning id", [name, `e2e-${crypto.randomUUID()}`])).rows[0].id)

  await signInWithTotp(page)
  await page.goto(`/ops/tenants/${tenantId}/data-protection`)
  const inForce = page.getByTestId('audit-retention-in-force')
  await expect(inForce).toContainText('730 days (2 years)')
  await expect(inForce).toContainText('the platform default')
  // The period for end users' data is a different setting and stays what it was.
  await expect(page.getByTestId('retention-in-force')).toContainText('90 days')

  // Under a year cannot be saved.
  const form = page.getByTestId('audit-retention-form')
  await form.getByLabel('Days').fill('90')
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled()
  await form.getByLabel('Days').fill('365')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Audit log period saved.')).toBeVisible()
  await expect(inForce).toContainText('365 days (1 year)')
  await expect(inForce).toContainText('your setting')
  await expect(page.getByTestId('retention-in-force')).toContainText('90 days')

  await shot(page, 'data-protection')

  // The change is in the audit log, like any other.
  await page.goto(`/ops/audit?tenantId=${tenantId}`)
  await expect(page.getByTestId('audit-table')).toContainText('PUT /v1/audit-retention')
})
