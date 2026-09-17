/**
 * Submits the sign-in form against staging. Better Auth allows 3 sign-in requests per 10 s per IP
 * (12-phase-4-findings.md), and the staging specs run back to back from one address, so a "Too many
 * attempts" answer waits out the window and submits again.
 */
import type { Page } from '@playwright/test'

export async function submitSignIn(page: Page) {
  for (let attempt = 0; ; attempt += 1) {
    await page.getByRole('button', { name: 'Sign in' }).click()
    const limited = page.getByText('Too many attempts')
    await Promise.race([page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 }).catch(() => {}), limited.waitFor({ timeout: 15_000 }).catch(() => {})])
    if (!page.url().includes('/login') || attempt >= 3) return
    await page.waitForTimeout(11_000)
  }
}
