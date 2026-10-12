/**
 * Exports (implement/22-console-feedback.md C12) on a seeded tenant, as an operator: a list comes
 * out as a real Excel file and as CSV under the filters on screen, references survive as written,
 * a formula-like value is neutralised in CSV, every export lands in the audit log, and the audit log
 * exports itself. The console's Content-Security-Policy must not object to the download (csp.ts).
 */
import { readFileSync } from 'node:fs'

import { strFromU8, unzipSync } from 'fflate'
import pg from 'pg'
import type { Download, Page } from '@playwright/test'

import { expect, test } from './csp'
import { PLATFORM_DATABASE_URL } from './env'
import { operator, signInWithTotp } from './operator'

/** A reference with leading zeros, one that reads as a formula, and a plain one. */
const REFERENCES = { zeros: '00123456789012345', formula: '=1+1', plain: 'order-7' }

async function seed(name: string) {
  const db = new pg.Client({ connectionString: PLATFORM_DATABASE_URL })
  await db.connect()
  try {
    const tenantId = (await db.query<{ id: string }>("insert into tenants (name, agent_tenant_id, status) values ($1, $2, 'ready') returning id", [name, `e2e-${crypto.randomUUID()}`])).rows[0].id
    await db.query("insert into connections (tenant_id, record_id, state, external_id) values ($1, 'conn-1', 'completed', 'user-1')", [tenantId])
    const credential = (id: string, state: string, externalId: string, attributes: string) =>
      db.query("insert into credentials (tenant_id, record_id, connection_id, state, external_id, credential_definition_id, attributes) values ($1, $2, 'conn-1', $3, $4, 'ABC:3:CL:12:default', $5)", [tenantId, id, state, externalId, attributes])
    await credential('cred-zeros', 'offer-sent', REFERENCES.zeros, '{"name":"Ada Lovelace"}')
    await credential('cred-formula', 'done', REFERENCES.formula, '{"name":"Grace Hopper"}')
    await credential('cred-plain', 'abandoned', REFERENCES.plain, '{}')
    return tenantId
  } finally {
    await db.end()
  }
}

/** Opens the Export menu, picks a format and returns the browser's download. */
async function exportAs(page: Page, format: 'Excel' | 'CSV'): Promise<Download> {
  await page.getByTestId('export-menu').click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: new RegExp(`^${format}`) }).click()])
  return download
}

const bytesOf = async (download: Download) => readFileSync(await download.path())

test('lists leave the console as Excel and CSV, as filtered, and every export is audited', async ({ page }) => {
  test.setTimeout(240_000)
  const tenantId = await seed(`Export ${Date.now()}`)
  await signInWithTotp(page)
  await page.goto(`/ops/tenants/${tenantId}/exchanges?tab=credentials`)
  const credentials = page.getByTestId('credentials-table')
  await expect(credentials.getByRole('row')).toHaveCount(4)

  // Excel: a real workbook, references stored as text, no attribute values.
  const workbook = await exportAs(page, 'Excel')
  expect(workbook.suggestedFilename()).toMatch(/^credential-exchanges-\d{4}-\d{2}-\d{2}\.xlsx$/)
  await expect(page.getByText(/3 rows exported to credential-exchanges-/)).toBeVisible()
  const files = unzipSync(new Uint8Array(await bytesOf(workbook)))
  const strings = strFromU8(files['xl/sharedStrings.xml'])
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml'])
  expect(strings).toContain('>External id<')
  expect(strings).toContain(`>${REFERENCES.zeros}<`)
  expect(strings).toContain(`>${REFERENCES.formula}<`)
  expect(sheet).not.toContain('<f>')
  expect(strings).not.toContain('Ada Lovelace')
  expect(strings).not.toContain('Grace Hopper')

  // CSV, after a filter: only what the list shows, and the formula-like reference cannot run.
  await page.getByTestId('state-filter').click()
  await page.getByRole('menuitemcheckbox', { name: 'done', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/state=/)
  await expect(credentials.getByRole('row')).toHaveCount(2)
  const csvFile = await exportAs(page, 'CSV')
  expect(csvFile.suggestedFilename()).toMatch(/^credential-exchanges-\d{4}-\d{2}-\d{2}\.csv$/)
  const csv = (await bytesOf(csvFile)).toString('utf8')
  expect(csv.charCodeAt(0)).toBe(0xfeff)
  const lines = csv.slice(1).trimEnd().split('\r\n')
  expect(lines).toHaveLength(2)
  expect(lines[0].startsWith('External id,State,Face check,Credential definition,')).toBe(true)
  expect(lines[1].startsWith(`'${REFERENCES.formula},done,`)).toBe(true)
  expect(csv).not.toContain('Grace Hopper')
  await expect(page.getByText(/1 row exported to credential-exchanges-/)).toBeVisible()

  // Both exports are in the audit log: who, which list, which filters, how many rows.
  await page.goto('/ops/audit?kind=export')
  const exported = page.getByTestId('audit-table').getByRole('row').filter({ hasText: 'List exported' })
  await expect(exported.first()).toContainText(operator().email)
  await exported.first().getByRole('button', { name: 'Details' }).click()
  const details = page.getByTestId('audit-changes')
  await expect(details).toContainText('"list": "credentials"')
  await expect(details).toContainText('"format": "csv"')
  await expect(details).toContainText('"rows": 1')
  await expect(details).toContainText('"done"')
  await page.keyboard.press('Escape')

  // The audit log exports itself, with its details.
  const auditFile = await exportAs(page, 'CSV')
  expect(auditFile.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/)
  const audit = (await bytesOf(auditFile)).toString('utf8')
  expect(audit.slice(1).startsWith('When (UTC),Actor,Actor id,Role,Tenant id,Action,Result,Reason,Details,')).toBe(true)
  expect(audit).toContain('List exported')
  expect(audit).toContain(operator().email)
})
