/**
 * Tenant portal (stage 4b): an operator gives two tenants organizations; owner A sets a password,
 * enrolls email codes and configures the tenant; a member joins by invitation and is limited by role;
 * the member cannot open organization B; role changes and removal take effect on the next request.
 * Pages backed by agent-service (catalogue, templates, exchanges) are covered by staging-portal.spec.ts.
 */
import { type Browser, type Page, expect, test } from '@playwright/test'
import pg from 'pg'

import { PLATFORM_DATABASE_URL } from './env'
import { linkFromMail, signInWithTotp } from './operator'

test.describe.configure({ mode: 'serial' })

const RESET_LINK = /http:\/\/localhost:3600\/api\/auth\/reset-password\/\S+/g
const INVITE_LINK = /http:\/\/localhost:3600\/invite\/\S+/g

/** Same rule as tenant-owner.functions.ts. */
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
  const context = await browser.newContext()
  return context.newPage()
}

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Organization sections' }).getByRole('link', { name, exact: true })

test('owners run their tenant, members are limited by role and organization', async ({ browser, page }) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const nameA = `Portal A ${stamp}`
  const nameB = `Portal B ${stamp}`
  const [tenantA, tenantB] = [await seedReadyTenant(nameA), await seedReadyTenant(nameB)]
  const ownerA = `owner-a+${stamp}@12id.test`
  const ownerB = `owner-b+${stamp}@12id.test`
  const memberEmail = `member+${stamp}@12id.test`
  const password = `Portal-E2e-${stamp}`

  // Operator: organizations with their first owners.
  await signInWithTotp(page)
  for (const [tenantId, ownerEmail] of [
    [tenantA, ownerA],
    [tenantB, ownerB],
  ]) {
    await page.goto(`/ops/tenants/${tenantId}`)
    await page.getByLabel('Owner name').fill('E2E Owner')
    await page.getByLabel('Owner email').fill(ownerEmail)
    await page.getByRole('button', { name: 'Create organization' }).click()
    await expect(page.getByTestId('members-table')).toContainText(ownerEmail)
  }

  // Owner A: first password from the emailed link, email codes as second factor.
  const owner = await newPage(browser)
  await owner.goto(await linkFromMail(ownerA, RESET_LINK))
  await expect(owner).toHaveURL(/\/reset-password\?token=/)
  await owner.getByLabel('New password').fill(password)
  await owner.getByLabel('Repeat the password').fill(password)
  await owner.getByRole('button', { name: 'Save password' }).click()
  await expect(owner).toHaveURL(/\/login/)
  await owner.getByLabel('Email').fill(ownerA)
  await owner.getByLabel('Password').fill(password)
  await owner.getByRole('button', { name: 'Sign in' }).click()
  await enrollEmailCodes(owner, password)

  await owner.getByTestId('organizations').getByText(nameA).click()
  await expect(owner).toHaveURL(new RegExp(`/t/${slugFor(nameA, tenantA)}/catalogue`))
  // The catalogue lives in agent-service, which is not running locally: the error stays inside the portal (staging spec covers the page).
  await expect(owner.getByText('This page could not be loaded')).toBeVisible()

  await tab(owner, 'API keys').click()
  await owner.getByLabel('New key label').fill('e2e-backend')
  await owner.getByRole('button', { name: 'Create API key' }).click()
  await expect(owner.getByTestId('secret-value')).toContainText('12id_sk_')
  await owner.getByRole('button', { name: 'I have stored it' }).click()
  await expect(owner.getByTestId('api-keys-table')).toContainText('e2e-backend')

  await tab(owner, 'Webhooks').click()
  await owner.getByLabel('HTTPS URL').fill('https://backend.example.com/12id/webhooks')
  await owner.getByRole('button', { name: 'Create endpoint' }).click()
  await expect(owner.getByTestId('secret-value')).toContainText('whsec_')
  await owner.getByRole('button', { name: 'I have stored it' }).click()
  await expect(owner.getByText('https://backend.example.com/12id/webhooks').first()).toBeVisible()

  await tab(owner, 'Members').click()
  await owner.getByLabel('Email', { exact: true }).fill(memberEmail)
  await owner.getByRole('button', { name: 'Send invitation' }).click()
  await expect(owner.getByTestId('invitations-table')).toContainText(memberEmail)

  // Member: account from the invitation, read-only.
  const member = await newPage(browser)
  await member.goto(await linkFromMail(memberEmail, INVITE_LINK))
  await expect(member.getByText(`Join ${nameA}`)).toBeVisible()
  await member.getByLabel('Your name').fill('E2E Member')
  await member.getByLabel('Password', { exact: true }).fill(password)
  await member.getByLabel('Repeat the password').fill(password)
  await member.getByRole('button', { name: 'Create account and join' }).click()
  await enrollEmailCodes(member, password)
  await expect(member.getByTestId('organizations')).toContainText(nameA)
  await expect(member.getByTestId('organizations')).not.toContainText(nameB)

  const memberBase = `/t/${slugFor(nameA, tenantA)}`
  await member.goto(`${memberBase}/webhooks`)
  await expect(member.getByText('https://backend.example.com/12id/webhooks')).toBeVisible()
  await expect(member.getByRole('button', { name: 'Rotate signing secret' })).toHaveCount(0)
  await member.goto(`${memberBase}/api-keys`)
  await expect(member.getByTestId('api-keys-table')).toContainText('e2e-backend')
  await expect(member.getByRole('button', { name: 'Create API key' })).toHaveCount(0)
  await member.goto(`${memberBase}/members`)
  await expect(member.getByTestId('members-table')).toContainText(ownerA)
  await expect(member.getByRole('button', { name: 'Send invitation' })).toHaveCount(0)

  // Another tenant's organization is refused, however the URL was obtained.
  await member.goto(`/t/${slugFor(nameB, tenantB)}/api-keys`)
  await expect(member.getByText('You are not a member of this organization.')).toBeVisible()

  // Owner promotes the member: the next request carries the new role.
  await owner.reload()
  await owner.getByLabel(`Role of ${memberEmail}`).selectOption('admin')
  await expect(owner.getByText('Role changed.')).toBeVisible()
  await member.goto(`${memberBase}/api-keys`)
  await expect(member.getByRole('button', { name: 'Create API key' })).toBeVisible()

  // Removal ends access to the organization immediately.
  await owner.getByTestId('members-table').getByRole('row').filter({ hasText: memberEmail }).getByRole('button', { name: 'Remove' }).click()
  await expect(owner.getByText('Member removed.')).toBeVisible()
  await member.goto(`${memberBase}/api-keys`)
  await expect(member.getByText('You are not a member of this organization.')).toBeVisible()
})
