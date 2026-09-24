/**
 * Server-paged lists (Phase 4 C9) on a seeded ready tenant, as an operator: the sidebar order,
 * pages through the URL, external-id search, state filter, created-date range, and External id as
 * the first column of credential and proof exchanges. Local run: the local platform-api on 3510.
 */
import { expect, test } from '@playwright/test'
import pg from 'pg'

import { PLATFORM_DATABASE_URL } from './env'
import { signInWithTotp } from './operator'

test.describe.configure({ mode: 'serial' })

/** 30 connections (one per day), 3 credential and 2 proof exchanges, 2 wallets. */
async function seed(name: string) {
  const db = new pg.Client({ connectionString: PLATFORM_DATABASE_URL })
  await db.connect()
  try {
    const tenantId = (await db.query<{ id: string }>("insert into tenants (name, agent_tenant_id, status) values ($1, $2, 'ready') returning id", [name, `e2e-${crypto.randomUUID()}`])).rows[0].id
    const day = (n: number) => new Date(Date.UTC(2026, 7, 1 + n, 12)).toISOString()
    for (let i = 0; i < 30; i += 1) {
      await db.query('insert into connections (tenant_id, record_id, state, external_id, their_label, created_at) values ($1, $2, $3, $4, $5, $6)', [
        tenantId,
        `conn-${String(i).padStart(2, '0')}`,
        i % 3 === 0 ? 'completed' : 'response-sent',
        `customer-${String(i).padStart(2, '0')}`,
        i === 4 ? 'Ada Lovelace' : null,
        day(i),
      ])
    }
    const credential = (id: string, state: string, externalId: string, n: number) =>
      db.query("insert into credentials (tenant_id, record_id, connection_id, state, external_id, credential_definition_id, attributes, created_at) values ($1, $2, 'conn-01', $3, $4, 'ABC:3:CL:12:default', '{}', $5)", [tenantId, id, state, externalId, day(n)])
    await credential('cred-1', 'done', 'order-4711-a', 1)
    await credential('cred-2', 'offer-sent', 'order-4712-b', 5)
    await credential('cred-3', 'abandoned', 'order-9000-c', 9)
    await db.query("insert into proofs (tenant_id, record_id, connection_id, state, external_id, created_at) values ($1, 'proof-1', 'conn-01', 'done', 'check-1', $2), ($1, 'proof-2', 'conn-01', 'request-sent', 'check-2', $3)", [tenantId, day(2), day(3)])
    await db.query("insert into wallets (tenant_id, external_id, token_hash, created_at) values ($1, 'phone-a', $2, $3), ($1, 'phone-b', $4, $5)", [tenantId, `h-${crypto.randomUUID()}`, day(1), `h-${crypto.randomUUID()}`, day(2)])
    return tenantId
  } finally {
    await db.end()
  }
}

test('lists page, search and filter on the server, with the fixed newest-first order', async ({ page }) => {
  test.setTimeout(180_000)
  const tenantId = await seed(`Lists ${Date.now()}`)
  await signInWithTotp(page)
  await page.goto(`/ops/tenants/${tenantId}`)

  // Sidebar: Wallets comes before Exchanges.
  const sections = page.getByRole('navigation', { name: 'Tenant sections' }).getByRole('link')
  const labels = await sections.allInnerTexts()
  expect(labels.findIndex((l) => l.includes('Wallets'))).toBeLessThan(labels.findIndex((l) => l.includes('Exchanges')))

  // Connections: 25 per page, newest first; page 2 through the pager, kept in the URL.
  await page.getByRole('navigation', { name: 'Tenant sections' }).getByRole('link', { name: 'Exchanges', exact: true }).click()
  const connections = page.getByTestId('connections-table')
  await expect(connections.getByTestId('pager-range')).toHaveText('1–25 of 30')
  await expect(connections.getByRole('row').nth(1)).toContainText('customer-29')
  await connections.getByRole('button', { name: 'Next page' }).click()
  await expect(page).toHaveURL(/page=2/)
  await expect(connections.getByTestId('pager-range')).toHaveText('26–30 of 30')
  await page.reload()
  await expect(page.getByTestId('connections-table').getByTestId('pager-range')).toHaveText('26–30 of 30')

  // External-id search: a fragment in the middle, case-insensitive; back on page 1.
  await page.getByPlaceholder('Search external id or holder label').fill('MER-1')
  await expect(page).toHaveURL(/q=MER-1/)
  await expect(page).not.toHaveURL(/page=/)
  await expect(connections.getByTestId('pager-range')).toHaveText('1–10 of 10')
  await page.getByPlaceholder('Search external id or holder label').fill('lovelace')
  await expect(connections.getByRole('row')).toHaveCount(2)
  await expect(connections).toContainText('customer-04')

  // Credential exchanges: External id is the first column; state filter and date range narrow it.
  await page.getByRole('tab', { name: 'Credential exchanges' }).click()
  const credentials = page.getByTestId('credentials-table')
  await expect(credentials.getByRole('columnheader').first()).toHaveText('External id')
  await expect(credentials.getByRole('row')).toHaveCount(4)
  await expect(credentials.getByRole('row').nth(1)).toContainText('order-9000-c')
  await page.getByPlaceholder('Search external id').fill('47')
  await expect(credentials.getByRole('row')).toHaveCount(3)
  await page.getByTestId('state-filter').click()
  await page.getByRole('menuitemcheckbox', { name: 'done', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/state=/)
  await expect(credentials.getByRole('row')).toHaveCount(2)
  await expect(credentials).toContainText('order-4711-a')
  // Reset clears the search and every filter, and keeps the tab.
  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page).not.toHaveURL(/state=|q=/)
  await expect(page).toHaveURL(/tab=credentials/)
  await expect(credentials.getByRole('row')).toHaveCount(4)

  // Created range: a range in the URL shows on the button; two clicks on the calendar pick another.
  await page.goto(`/ops/tenants/${tenantId}/exchanges?tab=credentials&from=2026-08-05&to=2026-08-06`)
  await expect(page.getByTestId('date-range')).toContainText('Aug 5, 2026 – Aug 6, 2026')
  await expect(credentials.getByRole('row')).toHaveCount(2)
  await expect(credentials).toContainText('order-4712-b')
  await page.getByTestId('date-range').click()
  await page.getByRole('button', { name: /August 9(th)?, 2026/ }).click()
  await page.getByRole('button', { name: /August 10(th)?, 2026/ }).click()
  await expect(page).toHaveURL(/from=2026-08-09/)
  await expect(page).toHaveURL(/to=2026-08-10/)
  await expect(credentials.getByRole('row')).toHaveCount(2)
  await expect(credentials).toContainText('order-9000-c')

  // Proof exchanges: External id first as well; switching tabs clears the filters.
  await page.getByRole('tab', { name: 'Proof exchanges' }).click()
  await expect(page).not.toHaveURL(/from=/)
  const proofs = page.getByTestId('proofs-table')
  await expect(proofs.getByRole('columnheader').first()).toHaveText('External id')
  await expect(proofs.getByRole('row').nth(1)).toContainText('check-2')

  // Wallets: search and status.
  await page.getByRole('navigation', { name: 'Tenant sections' }).getByRole('link', { name: 'Wallets', exact: true }).click()
  const wallets = page.getByTestId('wallets-table')
  await expect(wallets.getByRole('row').nth(1)).toContainText('phone-b')
  await page.getByPlaceholder('Search external id').fill('-a')
  await expect(wallets.getByRole('row')).toHaveCount(2)
  await expect(wallets).toContainText('phone-a')
})
