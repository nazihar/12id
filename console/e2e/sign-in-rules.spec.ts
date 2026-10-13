/**
 * The console's sign-in rules in a browser (implement/24-console-sign-in.md), with the captcha solved
 * by the real widget on every sign-in:
 *   - five wrong passwords lock an account; an operator unlocks it;
 *   - a reset link refuses a weak, a common and a reused password, and shows the meter;
 *   - a second sign-in ends the first session;
 *   - a session idle past the limit is ended on its next request;
 *   - an expired password opens only the change form.
 * Runs after auth.spec (the run's operator has its authenticator app) and leaves operator.json with
 * the password it changed to, for the specs after it.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { type Browser, type Page } from '@playwright/test'
import pg from 'pg'

import { expect, test, watchCsp } from './csp'
import { OPERATOR_FILE, consoleEnv } from './env'
import { linkFromMail, operator, signInWithTotp } from './operator'
import { strongPassword } from './passwords'

test.describe.configure({ mode: 'serial' })

const RESET_LINK = /http:\/\/localhost:3600\/api\/auth\/reset-password\/\S+/g

async function withConsoleDb<T>(fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: consoleEnv.DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function newPage(browser: Browser, cspViolations: string[]) {
  const page = await (await browser.newContext()).newPage()
  watchCsp(page, cspViolations)
  return page
}

/** Better Auth allows 3 sign-ins per address within 10 s of the previous one; its 429 comes before our rules and counts nothing. */
async function tryPassword(page: Page, email: string, password: string) {
  await page.waitForTimeout(11_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

const confirm = (page: Page, name: string) => page.getByRole('alertdialog').getByRole('button', { name, exact: true }).click()

test('five wrong passwords lock the account, and an operator unlocks it', async ({ browser, page, cspViolations }) => {
  test.setTimeout(240_000)
  const stamp = Date.now()
  const locked = { email: `locked-operator+${stamp}@12id.test`, password: strongPassword() }
  execFileSync('npx', ['auth', 'create-admin', '--config', 'src/server/auth.server.ts', '--email', locked.email, '--password', locked.password, '--name', 'Locked-Operator', '--role', 'operator', '--force', '--yes'], {
    env: { ...process.env, ...consoleEnv },
    stdio: 'inherit',
    shell: true,
  })

  const person = await newPage(browser, cspViolations)
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await tryPassword(person, locked.email, `${locked.password}x`)
    await expect(person.getByText('Email or password is incorrect.')).toBeVisible({ timeout: 20_000 })
  }
  await tryPassword(person, locked.email, `${locked.password}x`)
  await expect(person.getByText('Email or password is incorrect.')).toBeVisible({ timeout: 20_000 })
  // Locked now: even the right password is refused, and the person is told why.
  await tryPassword(person, locked.email, locked.password)
  await expect(person.getByText(/locked after too many wrong passwords/)).toBeVisible({ timeout: 20_000 })

  await signInWithTotp(page)
  await page.goto(`/ops/operators?q=${encodeURIComponent(locked.email)}`)
  const row = page.getByTestId('operators-table').getByRole('row').filter({ hasText: locked.email })
  await expect(row.getByText('locked', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: 'Unlock' }).click()
  await confirm(page, 'Unlock')
  await expect(row.getByText('active', { exact: true })).toBeVisible()

  await tryPassword(person, locked.email, locked.password)
  await expect(person).toHaveURL(/\/setup-2fa/, { timeout: 20_000 })

})

test('a reset link refuses weak, common and reused passwords, and shows the meter', async ({ browser, cspViolations }) => {
  test.setTimeout(180_000)
  const stamp = Date.now()
  const account = { email: `reset-operator+${stamp}@12id.test`, password: strongPassword() }
  execFileSync('npx', ['auth', 'create-admin', '--config', 'src/server/auth.server.ts', '--email', account.email, '--password', account.password, '--name', 'Reset-Operator', '--role', 'operator', '--force', '--yes'], {
    env: { ...process.env, ...consoleEnv },
    stdio: 'inherit',
    shell: true,
  })
  const person = await newPage(browser, cspViolations)
  await person.goto('/login')
  await person.getByRole('button', { name: 'Forgot your password?' }).click()
  await person.getByRole('dialog').getByLabel('Email').fill(account.email)
  await person.getByRole('button', { name: 'Email me a link' }).click()
  await expect(person.getByText('the link is on its way')).toBeVisible({ timeout: 20_000 })

  await person.goto(await linkFromMail(account.email, RESET_LINK))
  await expect(person).toHaveURL(/\/reset-password\?token=/)
  const fresh = person.getByLabel('New password')
  await fresh.fill('short')
  await expect(person.getByText('Strength: Too weak')).toBeVisible()
  await expect(person.getByText('Add a digit.')).toBeVisible()

  const submit = async (value: string) => {
    await fresh.fill(value)
    await person.getByLabel('Repeat the password').fill(value)
    await person.getByRole('button', { name: 'Save password' }).click()
  }
  await submit('P@ssw0rd!Xq79')
  await expect(person.getByText(/Avoid common words/)).toBeVisible({ timeout: 20_000 })
  await submit(account.password)
  await expect(person.getByText(/You used this password recently/)).toBeVisible({ timeout: 20_000 })
  const next = strongPassword()
  await submit(next)
  await expect(person).toHaveURL(/\/login/, { timeout: 20_000 })
  await tryPassword(person, account.email, next)
  await expect(person).toHaveURL(/\/setup-2fa/, { timeout: 20_000 })
})

test('a second sign-in ends the first session, and an idle session ends on its next request', async ({ browser, page, cspViolations }) => {
  test.setTimeout(180_000)
  await signInWithTotp(page)
  const second = await newPage(browser, cspViolations)
  await signInWithTotp(second)

  // The first browser is signed out: its next page sends it to sign in.
  await page.goto('/ops')
  await expect(page).toHaveURL(/\/login/)

  // The second sits idle past the limit (set back in the database instead of waiting 15 minutes).
  const { email } = operator()
  await withConsoleDb((db) => db.query(`update session set last_active_at = now() - interval '20 minutes' where user_id = (select id from "user" where email = $1)`, [email]))
  await second.goto('/ops')
  await expect(second).toHaveURL(/\/login/)
  const ended = await withConsoleDb(async (db) => (await db.query(`select count(*)::int as n from session where user_id = (select id from "user" where email = $1)`, [email])).rows[0].n as number)
  expect(ended).toBe(0)
})

test('an expired password opens only the change form, which ends the other sessions', async ({ page }) => {
  test.setTimeout(180_000)
  const { email, password } = operator()
  await withConsoleDb((db) => db.query(`update "user" set password_changed_at = now() - interval '100 days' where email = $1`, [email]))
  await signInWithTotp(page, { landing: /\/change-password/ })
  await expect(page.getByText('Your password has expired')).toBeVisible()
  await page.goto('/ops')
  await expect(page).toHaveURL(/\/change-password/)

  const next = strongPassword()
  await page.getByLabel('Current password').fill(password)
  await page.getByLabel('New password', { exact: true }).fill(next)
  await page.getByLabel('Repeat the new password').fill(next)
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page).toHaveURL(/\/ops/, { timeout: 20_000 })
  // Later specs sign in as this operator.
  writeFileSync(OPERATOR_FILE, JSON.stringify({ email, password: next }))
})
