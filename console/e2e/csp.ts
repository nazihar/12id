/**
 * Content-Security-Policy guard for the specs (platform review M12): every page of the test's
 * context is watched, and a test fails if the browser refused anything under the console's CSP
 * (Chromium reports each refusal as a console error naming the policy). Pages from extra contexts
 * are added with `watchCsp(context, cspViolations)`.
 *
 * The same guard fails a test when React reports a hydration mismatch (the server's HTML and the
 * browser's first render disagree): it recovers by rendering again, so nothing else would notice.
 */
import { type BrowserContext, type Page, test as base, expect } from '@playwright/test'

const CSP_REPORT = /Content[ -]Security[ -]Policy/i
const HYDRATION_REPORT = /Hydration failed|hydration mismatch|did not match the client/i

export function watchCsp(target: BrowserContext | Page, found: string[]) {
  const attach = (page: Page) => page.on('console', (message) => {
    if (CSP_REPORT.test(message.text()) || HYDRATION_REPORT.test(message.text())) found.push(`${page.url()}: ${message.text().slice(0, 600)}`)
  })
  const onError = (page: Page) => page.on('pageerror', (error) => {
    if (HYDRATION_REPORT.test(error.message)) found.push(`${page.url()}: ${error.message.slice(0, 600)}`)
  })
  if ('pages' in target) {
    target.pages().forEach(attach)
    target.pages().forEach(onError)
    target.on('page', attach)
    target.on('page', onError)
  } else {
    attach(target)
    onError(target)
  }
}

export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ context }, use) => {
      const found: string[] = []
      watchCsp(context, found)
      await use(found)
      expect(found, 'Content-Security-Policy violations and hydration mismatches').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
