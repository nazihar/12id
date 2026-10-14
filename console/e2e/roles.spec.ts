/**
 * Roles by action and user administration (implement/26): an owner makes a custom role from the
 * portal actions and gives it to a member, who can do exactly that; a role in use cannot be deleted;
 * the owner disables the membership until a day with a note, which closes this organization only,
 * and re-enables it; the access report, who is signed in now, and the members export.
 */
import { type Browser, type Page, expect, test } from '@playwright/test'
import pg from 'pg'

import { PLATFORM_DATABASE_URL } from './env'
import { linkFromMail, signInWithTotp } from './operator'
import { strongPassword } from './passwords'

test.describe.configure({ mode: 'serial' })

const RESET_LINK = /http:\/\/localhost:3600\/api\/auth\/reset-password\/\S+/g
const INVITE_LINK = /http:\/\/localhost:3600\/invite\/\S+/g
const slugFor = (name: string, tenantId: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${tenantId.slice(0, 8)}`

async function seedReadyTenant(name: string) {
  const client = new pg.Client({ connectionString: PLATFORM_DATABASE_URL })
  await client.connect()
  try {
    const result = await client.query<{ id: string }>("insert into tenants (name, agent_tenant_id, status) values ($1, $2, 'ready') returning id", [name, `e2e-${crypto.randomUUID()}`])
    return result.rows[0].id
  } finally {
    await client.end()
  }
}

async function enrollEmailCodes(page: Page, password: string) {
  await expect(page).toHaveURL(/\/setup-2fa/)
  await page.getByLabel('Confirm your password').fill(password)
  await page.getByRole('button', { name: 'Email me codes instead' }).click()
  await expect(page).toHaveURL(/\/account/)
}

async function newPage(browser: Browser) {
  return (await browser.newContext()).newPage()
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Organization sections' }).getByRole('link', { name, exact: true })

test('a custom role allows its actions only; an owner disables a membership for this organization', async ({ browser, page }) => {
  test.setTimeout(300_000)
  const stamp = Date.now()
  const name = `Roles ${stamp}`
  const otherName = `Roles other ${stamp}`
  const [tenantId, otherTenantId] = [await seedReadyTenant(name), await seedReadyTenant(otherName)]
  const ownerEmail = `roles-owner+${stamp}@12id.test`
  const otherOwnerEmail = `roles-owner-b+${stamp}@12id.test`
  const memberEmail = `roles-member+${stamp}@12id.test`
  const password = strongPassword()
  const base = `/t/${slugFor(name, tenantId)}`

  await signInWithTotp(page)
  for (const [id, email] of [
    [tenantId, ownerEmail],
    [otherTenantId, otherOwnerEmail],
  ]) {
    await page.goto(`/ops/tenants/${id}`)
    await page.getByRole('button', { name: 'Create organization' }).click()
    await page.getByLabel('Owner name').fill('E2E Owner')
    await page.getByLabel('Owner email').fill(email)
    await page.getByRole('dialog').getByRole('button', { name: 'Create organization' }).click()
    await expect(page.getByTestId('members-table')).toContainText(email)
  }

  const owner = await newPage(browser)
  await owner.goto(await linkFromMail(ownerEmail, RESET_LINK))
  await owner.getByLabel('New password').fill(password)
  await owner.getByLabel('Repeat the password').fill(password)
  await owner.getByRole('button', { name: 'Save password' }).click()
  await owner.getByLabel('Email').fill(ownerEmail)
  await owner.getByLabel('Password').fill(password)
  await owner.getByRole('button', { name: 'Sign in' }).click()
  await enrollEmailCodes(owner, password)
  await owner.getByTestId('organizations').getByText(name).click()

  // The built-in roles are listed and locked; a new role is made from actions.
  await nav(owner, 'Roles').click()
  const roles = owner.getByTestId('roles-table')
  for (const builtIn of ['Owner', 'Admin', 'Member']) await expect(roles).toContainText(builtIn)
  await expect(roles.getByRole('button', { name: 'Edit Owner' })).toHaveCount(0)
  await owner.getByRole('button', { name: 'New role' }).click()
  const dialog = owner.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Owner')
  await dialog.getByRole('checkbox', { name: 'Manage integration' }).click()
  await dialog.getByRole('button', { name: 'Create role' }).click()
  await expect(dialog.getByText('Owner, Admin and Member are built in.')).toBeVisible()
  await dialog.getByLabel('Name').fill('Integrations')
  await dialog.getByLabel('Description').fill('Runs the backend connection')
  await dialog.getByRole('checkbox', { name: 'Export' }).click()
  await dialog.getByRole('button', { name: 'Create role' }).click()
  await expect(owner.getByText('Role created.')).toBeVisible()
  const integrations = roles.getByRole('row').filter({ hasText: 'Integrations' })
  await expect(integrations).toContainText('Manage integration')
  await expect(integrations).toContainText('Export')

  // A member invited with it.
  await nav(owner, 'Members').click()
  await owner.getByRole('button', { name: 'Invite member' }).click()
  await owner.getByLabel('Email', { exact: true }).fill(memberEmail)
  await owner.getByRole('dialog').getByLabel('Role').fill('Integ')
  await owner.getByRole('option', { name: /^Integrations/ }).click()
  await owner.getByRole('button', { name: 'Send invitation' }).click()
  await owner.getByRole('tab', { name: 'Pending invitations' }).click()
  await expect(owner.getByTestId('invitations-table')).toContainText('Integrations')

  const member = await newPage(browser)
  await member.goto(await linkFromMail(memberEmail, INVITE_LINK))
  await member.getByLabel('Your name').fill('E2E Integrator')
  await member.getByLabel('Password', { exact: true }).fill(password)
  await member.getByLabel('Repeat the password').fill(password)
  await member.getByRole('button', { name: 'Create account and join' }).click()
  await enrollEmailCodes(member, password)
  await expect(member.getByTestId('organizations')).toContainText('Integrations')

  // What the role allows, and nothing more.
  await member.goto(`${base}/api-keys`)
  await expect(member.getByRole('button', { name: 'Create API key' })).toBeVisible()
  await member.goto(`${base}/wallets`)
  await expect(member.getByTestId('export-menu')).toBeVisible()
  await member.goto(`${base}/data-protection`)
  await expect(member.getByRole('button', { name: 'Save' })).toHaveCount(0)
  await member.goto(`${base}/members`)
  await expect(member.getByRole('button', { name: 'Invite member' })).toHaveCount(0)
  await expect(nav(member, 'Roles')).toHaveCount(0)
  await member.goto(`${base}/roles`)
  await expect(member).toHaveURL(new RegExp(`${base}/members`))

  // A role somebody holds cannot be deleted.
  await owner.goto(`${base}/roles`)
  await expect(roles.getByRole('row').filter({ hasText: 'Integrations' }).getByRole('button', { name: 'Delete Integrations' })).toBeDisabled()

  // The owner disables the membership until a day, with a note: this organization closes for them.
  await owner.goto(`${base}/members`)
  const row = owner.getByTestId('members-table').getByRole('row').filter({ hasText: memberEmail })
  await row.getByRole('button', { name: 'Disable' }).click()
  const disable = owner.getByRole('dialog')
  await disable.getByRole('button', { name: 'Disable' }).click()
  await expect(disable.getByText('Say why')).toBeVisible()
  await disable.getByLabel('Until').click()
  await owner.locator('[data-slot=calendar] button[data-day]:not([disabled])').first().click()
  await disable.getByLabel('Why').fill('on leave')
  await disable.getByRole('button', { name: 'Disable' }).click()
  await expect(owner.getByText('Member disabled in this organization.')).toBeVisible()
  await expect(row).toContainText('disabled')
  await expect(row).toContainText('on leave')
  await expect(owner.getByTestId('access-closed')).toContainText('1 disabled')

  await member.goto(`${base}/api-keys`)
  await expect(member.getByText('Your membership of this organization is disabled.')).toBeVisible()
  await member.goto('/account')
  await expect(member.getByTestId('organization-disabled')).toContainText('on leave')

  // Filtered by state, and exported.
  await owner.goto(`${base}/members?state=disabled`)
  await expect(owner.getByTestId('members-table')).toContainText(memberEmail)
  await expect(owner.getByTestId('members-table')).not.toContainText(ownerEmail)
  await owner.getByTestId('export-menu').click()
  const [download] = await Promise.all([owner.waitForEvent('download'), owner.getByRole('menuitem', { name: /^CSV/ }).click()])
  expect(download.suggestedFilename()).toMatch(/^members-\d{4}-\d{2}-\d{2}\.csv$/)

  // Re-enabled: it opens again on the next request.
  await owner.goto(`${base}/members`)
  await row.getByRole('button', { name: 'Re-enable here' }).click()
  await owner.getByRole('alertdialog').getByRole('button', { name: 'Re-enable' }).click()
  await expect(owner.getByText('Member re-enabled.')).toBeVisible()
  await member.goto(`${base}/api-keys`)
  await expect(member.getByRole('button', { name: 'Create API key' })).toBeVisible()

  // Who is signed in now: both of them.
  await owner.getByRole('tab', { name: 'Signed in now' }).click()
  await expect(owner.getByTestId('signed-in-table')).toContainText(memberEmail)
  await expect(owner.getByTestId('signed-in-table')).toContainText('Integrations')
  await expect(owner.getByTestId('signed-in-table').getByRole('button', { name: 'End session' })).toHaveCount(0)

  // The audit has the role and the disable.
  await page.goto('/ops/audit?kind=account')
  await expect(page.getByTestId('audit-table')).toContainText('Role created')
  await expect(page.getByTestId('audit-table')).toContainText('Member disabled in the organization')
})

test('operators see the access report and who is signed in', async ({ page }) => {
  test.setTimeout(120_000)
  await signInWithTotp(page)
  await page.goto('/ops/operators')
  await expect(page.getByTestId('access-total')).toBeVisible()
  await page.goto('/ops/operators?tab=signed-in')
  await expect(page.getByRole('tab', { name: 'Signed in now' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('signed-in-table')).toContainText('(you)')
  await page.goto('/ops/operators?status=disabled')
  await expect(page.getByTestId('operators-table')).toBeVisible()
})
