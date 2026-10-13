/** The run's operator (created in global-setup, TOTP-enrolled by auth.spec) signing in again. */
import { readFileSync } from 'node:fs'

import { type Page, expect } from '@playwright/test'
import { generateSync } from 'otplib'

import { MAIL_OUTBOX_FILE, OPERATOR_FILE, TOTP_SECRET_FILE } from './env'

export const operator = () => JSON.parse(readFileSync(OPERATOR_FILE, 'utf8')) as { email: string; password: string }

/** TOTP codes repeat within a 30 s window; wait for the next one so a code used earlier is never replayed. */
async function nextTotpWindow(page: Page) {
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 1_000)
}

/** `landing`: where the sign-in should end up (the operator console, unless a rule sends them elsewhere). */
export async function signInWithTotp(page: Page, { landing = /\/ops/ }: { landing?: RegExp } = {}) {
  const { email, password } = operator()
  const secret = readFileSync(TOTP_SECRET_FILE, 'utf8').trim()
  await nextTotpWindow(page)
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/verify-2fa/)
  await page.getByTestId('otp-code').fill(generateSync({ secret }))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page).toHaveURL(landing)
}

/** The newest link in a message to `to` matching `pattern`, waiting for the mail to arrive. */
export async function linkFromMail(to: string, pattern: RegExp) {
  let link: string | undefined
  await expect
    .poll(() => {
      const lines = readFileSync(MAIL_OUTBOX_FILE, 'utf8').trim().split('\n')
      const texts = lines.map((line) => JSON.parse(line) as { to: string; text: string }).filter((mail) => mail.to === to)
      link = texts.flatMap((mail) => mail.text.match(pattern) ?? []).at(-1)
      return link
    })
    .toBeTruthy()
  return link as string
}
