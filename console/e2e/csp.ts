/**
 * Content-Security-Policy guard for the specs (platform review M12): every page of the test's
 * context is watched, and a test fails if the browser refused anything under the console's CSP
 * (Chromium reports each refusal as a console error naming the policy). Pages from extra contexts
 * are added with `watchCsp(context, cspViolations)`.
 */
import { type BrowserContext, type Page, test as base, expect } from '@playwright/test'

const CSP_REPORT = /Content[ -]Security[ -]Policy/i

export function watchCsp(target: BrowserContext | Page, found: string[]) {
  const attach = (page: Page) => page.on('console', (message) => {
    if (CSP_REPORT.test(message.text())) found.push(`${page.url()}: ${message.text()}`)
  })
  if ('pages' in target) {
    target.pages().forEach(attach)
    target.on('page', attach)
  } else {
    attach(target)
  }
}

export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ context }, use) => {
      const found: string[] = []
      watchCsp(context, found)
      await use(found)
      expect(found, 'Content-Security-Policy violations').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
