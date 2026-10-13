/**
 * Approval by a second person (implement/22-console-feedback.md C17–C19), in a browser, with two
 * people of one organization: an owner and an admin. Each change is asked by one and decided by the
 * other; what hands out a secret is applied by the person who asked. The operator then reads the
 * same requests and the audit log. Local run: the local platform-api on 3510.
 */
import { type Browser, type Page } from '@playwright/test'
import pg from 'pg'

import { expect, test, watchCsp } from './csp'
import { PLATFORM_DATABASE_URL } from './env'
import { linkFromMail, signInWithTotp } from './operator'
import { strongPassword } from './passwords'

const RESET_LINK = /http:\/\/localhost:3600\/api\/auth\/reset-password\/\S+/g
const INVITE_LINK = /http:\/\/localhost:3600\/invite\/\S+/g

/** Same rule as tenant-owner.functions.ts. */
const slugFor = (name: string, tenantId: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${tenantId.slice(0, 8)}`

async function seedReadyTenant(name: string) {
  const client = new pg.Client({ connectionString: PLATFORM_DATABASE_URL })
  await client.connect()
  try {
    return (await client.query<{ id: string }>("insert into tenants (name, agent_tenant_id, status) values ($1, $2, 'ready') returning id", [name, `e2e-${crypto.randomUUID()}`])).rows[0].id
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

/** Optional screenshots for a look at the pages (E2E_SHOTS=<dir>); the run does not depend on them. */
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png`, fullPage: true })
}

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Organization sections' }).getByRole('link', { name, exact: true })
const requests = (page: Page) => page.getByTestId('change-requests')
const request = (page: Page, text: string) => requests(page).getByRole('row').filter({ hasText: text })
const confirm = (page: Page, name: string) => page.getByRole('alertdialog').getByRole('button', { name, exact: true }).click()

test('a change waits for a second person: asked by one, decided by another, applied by the one who asked', async ({ browser, page, cspViolations }) => {
  test.setTimeout(420_000)
  const stamp = Date.now()
  const name = `Approvals ${stamp}`
  const tenantId = await seedReadyTenant(name)
  const base = `/t/${slugFor(name, tenantId)}`
  const ownerEmail = `owner+${stamp}@12id.test`
  const adminEmail = `admin+${stamp}@12id.test`
  const password = strongPassword()

  // The operator gives the tenant an organization with its first owner.
  await signInWithTotp(page)
  await page.goto(`/ops/tenants/${tenantId}`)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await page.getByLabel('Owner name').fill('E2E Owner')
  await page.getByLabel('Owner email').fill(ownerEmail)
  await page.getByRole('dialog').getByRole('button', { name: 'Create organization' }).click()
  await expect(page.getByTestId('members-table')).toContainText(ownerEmail)

  // The owner signs in and invites an admin. Nothing waits yet: approval is off.
  const owner = await newPage(browser)
  watchCsp(owner, cspViolations)
  await owner.goto(await linkFromMail(ownerEmail, RESET_LINK))
  await owner.getByLabel('New password').fill(password)
  await owner.getByLabel('Repeat the password').fill(password)
  await owner.getByRole('button', { name: 'Save password' }).click()
  await owner.getByLabel('Email').fill(ownerEmail)
  await owner.getByLabel('Password').fill(password)
  await owner.getByRole('button', { name: 'Sign in' }).click()
  await enrollEmailCodes(owner, password)
  await owner.goto(`${base}/approvals`)
  const requirement = owner.getByTestId('approval-requirement')
  await expect(requirement).toHaveAttribute('data-required', 'false')
  // One person who could approve: the requirement cannot be switched on.
  await expect(requirement).toContainText('it takes two')
  await expect(requirement.getByRole('button', { name: 'Require a second person' })).toBeDisabled()

  await tab(owner, 'Members').click()
  await owner.getByRole('button', { name: 'Invite member' }).click()
  await owner.getByLabel('Email', { exact: true }).fill(adminEmail)
  await owner.getByRole('dialog').getByLabel('Role').fill('adm')
  await owner.getByRole('option', { name: /^admin/ }).click()
  await owner.getByRole('button', { name: 'Send invitation' }).click()
  await expect(owner.getByText(`Invitation sent to ${adminEmail}.`)).toBeVisible()

  const admin = await newPage(browser)
  watchCsp(admin, cspViolations)
  await admin.goto(await linkFromMail(adminEmail, INVITE_LINK))
  await admin.getByLabel('Your name').fill('E2E Admin')
  await admin.getByLabel('Password', { exact: true }).fill(password)
  await admin.getByLabel('Repeat the password').fill(password)
  await admin.getByRole('button', { name: 'Create account and join' }).click()
  await enrollEmailCodes(admin, password)

  // Two people who can decide: the owner switches the requirement on. It takes effect at once.
  await owner.goto(`${base}/approvals`)
  await expect(requirement).toContainText('2 of the owners and admins')
  await requirement.getByText('What waits for a second person').click()
  await expect(owner.getByTestId('approval-types')).toContainText('Create an API key')
  await expect(owner.getByTestId('approval-types')).toContainText('Create a proof template')
  await expect(owner.getByTestId('approval-types')).not.toContainText('operator')
  await requirement.getByRole('button', { name: 'Require a second person' }).click()
  await confirm(owner, 'Require a second person')
  await expect(requirement).toHaveAttribute('data-required', 'true')
  await expect(requests(owner)).toContainText('Nothing is waiting for a second person.')

  // --- a webhook endpoint: held, approved by the admin, applied by the owner, who gets the secret ---
  await tab(owner, 'Webhooks').click()
  await owner.getByRole('button', { name: 'Create endpoint' }).click()
  await owner.getByLabel('HTTPS URL').fill('https://backend.example.com/12id/webhooks')
  await owner.getByRole('dialog').getByRole('button', { name: 'Create endpoint' }).click()
  await expect(owner.getByText('Sent for approval: Send events to https://backend.example.com/12id/webhooks.')).toBeVisible()
  await expect(owner.getByTestId('secret-value')).toHaveCount(0)
  await expect(owner.getByTestId('pending-changes')).toContainText('Send events to https://backend.example.com/12id/webhooks, asked by you.')
  await expect(owner.getByText('No webhook endpoint configured')).toBeVisible()
  await expect(owner.getByTestId('nav-count-approvals')).toHaveText('1')
  // Loaded afresh, the page still says so: the notice and the count come after hydration, without a
  // mismatch against the server's HTML (the guard in csp.ts fails the test on one).
  await owner.reload()
  await expect(owner.getByTestId('pending-changes')).toContainText('asked by you')
  await expect(owner.getByTestId('nav-count-approvals')).toHaveText('1')
  // The same thing cannot be asked for twice.
  await owner.getByRole('button', { name: 'Create endpoint' }).click()
  await owner.getByLabel('HTTPS URL').fill('https://other.example.com/hook')
  await owner.getByRole('dialog').getByRole('button', { name: 'Create endpoint' }).click()
  await expect(owner.getByRole('dialog')).toContainText('already waiting')
  await owner.keyboard.press('Escape')

  await tab(owner, 'Approvals').click()
  const webhook = 'Set the webhook endpoint'
  await expect(request(owner, webhook)).toContainText('waiting for a second person')
  await expect(request(owner, webhook)).toContainText('(you)')
  // The person who asked is offered no Approve.
  await expect(request(owner, webhook).getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await expect(request(owner, webhook).getByRole('button', { name: 'Cancel request' })).toBeVisible()
  await shot(owner, 'approvals-waiting')

  await admin.getByTestId('organizations').getByText(name).click()
  await expect(admin.getByTestId('nav-count-approvals')).toHaveText('1')
  await admin.goto(`${base}/webhooks`)
  await expect(admin.getByTestId('pending-changes')).toContainText(`asked by ${ownerEmail}`)
  await tab(admin, 'Approvals').click()
  await request(admin, webhook).getByRole('button', { name: 'Details' }).click()
  await expect(admin.getByTestId('change-asked')).toContainText('https://backend.example.com/12id/webhooks')
  await shot(admin, 'approvals-details')
  await admin.keyboard.press('Escape')
  await request(admin, webhook).getByRole('button', { name: 'Approve' }).click()
  await expect(admin.getByRole('alertdialog')).toContainText('Once approved, they apply it themselves.')
  await confirm(admin, 'Approve')
  await expect(admin.getByText('Approved.')).toBeVisible()
  await expect(request(admin, webhook)).toContainText(`approved: waiting for ${ownerEmail} to apply it`)
  // The approver cannot apply it.
  await expect(request(admin, webhook).getByRole('button', { name: 'Apply' })).toHaveCount(0)

  await owner.reload()
  await expect(request(owner, webhook)).toContainText('approved: apply it now')
  await request(owner, webhook).getByRole('button', { name: 'Apply' }).click()
  await confirm(owner, 'Apply')
  await expect(owner.getByTestId('secret-value')).toContainText('whsec_')
  await owner.getByRole('button', { name: 'I have stored it' }).click()
  await expect(requests(owner)).toContainText('Nothing is waiting for a second person.')
  await owner.getByRole('tab', { name: 'History' }).click()
  await expect(owner).toHaveURL(/tab=history/)
  await expect(request(owner, webhook)).toContainText('approved and applied')
  await expect(request(owner, webhook)).toContainText(adminEmail)
  await tab(owner, 'Webhooks').click()
  await expect(owner.getByText('https://backend.example.com/12id/webhooks').first()).toBeVisible()
  await expect(owner.getByTestId('pending-changes')).toHaveCount(0)

  // --- a period: asked by the admin, in force the moment the owner approves ---------------------------
  await tab(admin, 'Data protection').click()
  const retention = admin.getByTestId('retention-form')
  await retention.getByLabel('Days').fill('30')
  await retention.getByRole('button', { name: 'Save' }).click()
  await expect(admin.getByText('Sent for approval: Keep personal data of finished exchanges for 30 days.')).toBeVisible()
  await expect(admin.getByTestId('retention-in-force')).toContainText('90 days')
  await expect(admin.getByTestId('pending-changes')).toContainText('asked by you')
  await tab(owner, 'Approvals').click()
  const period = 'Change the retention period'
  await request(owner, period).getByRole('button', { name: 'Details' }).click()
  await expect(owner.getByTestId('change-before')).toContainText('"retentionDays": null')
  await expect(owner.getByTestId('change-asked')).toContainText('"retentionDays": 30')
  await owner.keyboard.press('Escape')
  await request(owner, period).getByRole('button', { name: 'Approve' }).click()
  await expect(owner.getByRole('alertdialog')).toContainText('It takes effect at once.')
  await confirm(owner, 'Approve')
  await expect(owner.getByText('Approved.')).toBeVisible()
  await admin.reload()
  await expect(admin.getByTestId('retention-in-force')).toContainText('30 days')
  await expect(admin.getByTestId('pending-changes')).toHaveCount(0)

  // --- an API key: asked by the owner, rejected by the admin with a reason; no key exists ---------------
  await tab(owner, 'API keys').click()
  await owner.getByRole('button', { name: 'Create API key' }).click()
  await owner.getByLabel('New key label').fill('reporting')
  await owner.getByRole('dialog').getByRole('button', { name: 'Create API key' }).click()
  await expect(owner.getByText('Sent for approval: New API key "reporting".')).toBeVisible()
  await expect(owner.getByTestId('secret-value')).toHaveCount(0)
  await tab(admin, 'Approvals').click()
  const key = 'Create an API key'
  await request(admin, key).getByRole('button', { name: 'Reject' }).click()
  // A reason is required.
  await confirm(admin, 'Reject')
  await expect(admin.getByRole('alertdialog')).toContainText('Say why')
  await admin.getByRole('alertdialog').getByLabel('Reason (required)').fill('Use the existing backend key.')
  await confirm(admin, 'Reject')
  await expect(admin.getByText('Rejected.')).toBeVisible()
  await admin.getByRole('tab', { name: 'History' }).click()
  await request(admin, key).getByRole('button', { name: 'Details' }).click()
  await expect(admin.getByTestId('change-request')).toContainText('Use the existing backend key.')
  await admin.keyboard.press('Escape')
  await tab(owner, 'API keys').click()
  await expect(owner.getByTestId('api-keys-table')).not.toContainText('reporting')

  // --- inviting a member: the console performs it, under the owner's session, once approved ----------
  const memberEmail = `member+${stamp}@12id.test`
  await tab(owner, 'Members').click()
  await owner.getByRole('button', { name: 'Invite member' }).click()
  await owner.getByLabel('Email', { exact: true }).fill(memberEmail)
  await owner.getByRole('button', { name: 'Send invitation' }).click()
  await expect(owner.getByText(`Sent for approval: Invite ${memberEmail} as member.`)).toBeVisible()
  await owner.getByRole('tab', { name: 'Pending invitations' }).click()
  await expect(owner.getByTestId('invitations-table')).not.toContainText(memberEmail)
  await admin.getByRole('tab', { name: 'Waiting' }).click()
  await request(admin, 'Invite a member').getByRole('button', { name: 'Approve' }).click()
  await confirm(admin, 'Approve')
  await expect(admin.getByText('Approved.')).toBeVisible()
  await tab(owner, 'Approvals').click()
  await request(owner, 'Invite a member').getByRole('button', { name: 'Apply' }).click()
  await confirm(owner, 'Apply')
  await expect(owner.getByText('Applied.')).toBeVisible()
  await tab(owner, 'Members').click()
  await owner.getByRole('tab', { name: 'Pending invitations' }).click()
  await expect(owner.getByTestId('invitations-table')).toContainText(memberEmail)
  // What only closes access never waits.
  await owner.getByRole('button', { name: 'Cancel invitation' }).click()
  await confirm(owner, 'Cancel invitation')
  await expect(owner.getByText('Invitation cancelled.')).toBeVisible()

  // --- switching the requirement off is itself held ---------------------------------------------------
  await tab(owner, 'Approvals').click()
  await requirement.getByRole('button', { name: 'Stop requiring' }).click()
  await confirm(owner, 'Ask to stop')
  await expect(owner.getByText('Sent for approval: Stop requiring a second person for sensitive changes.')).toBeVisible()
  await expect(requirement).toHaveAttribute('data-required', 'true')
  await admin.reload()
  await request(admin, 'Stop requiring a second person').getByRole('button', { name: 'Approve' }).click()
  await confirm(admin, 'Approve')
  await expect(admin.getByText('Approved.')).toBeVisible()
  await expect(admin.getByTestId('approval-requirement')).toHaveAttribute('data-required', 'false')
  await shot(admin, 'approvals-history-off')

  // --- the operator reads the same requests, and the audit log tells the story ----------------------
  await page.goto(`/ops/tenants/${tenantId}/approvals?tab=history`)
  await expect(request(page, webhook)).toContainText('approved and applied')
  await expect(request(page, key)).toContainText('rejected')
  await page.goto(`/ops/audit?kind=approval&tenantId=${tenantId}`)
  const audit = page.getByTestId('audit-table')
  await expect(audit).toContainText('PUT /v1/webhook')
  await expect(audit).toContainText('POST /v1/change-requests/:id/approve')
  await expect(audit).toContainText('POST /v1/change-requests/:id/reject')
  await expect(audit).toContainText(ownerEmail)
  await expect(audit).toContainText(adminEmail)
  // Changes to operator accounts have a page of their own; here the server setting is off.
  await page.getByRole('navigation', { name: 'Operator sections' }).getByRole('link', { name: 'Approvals', exact: true }).click()
  await expect(page.getByTestId('approval-requirement')).toContainText('Set on the server (OPERATOR_APPROVALS)')
  await expect(page.getByTestId('approval-requirement')).toHaveAttribute('data-required', 'false')
})
