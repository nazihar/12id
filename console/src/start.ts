/**
 * Global request middleware (TanStack Start `createStart`).
 *
 * - CSP (platform review M12): a fresh nonce per request. Only scripts carrying it run: the router
 *   stamps it on every script it renders (`ssr.nonce`, router.tsx), and `'strict-dynamic'` extends the
 *   trust to the modules those scripts import. An injected `<script>` (an XSS in a dependency, a
 *   tenant name rendered unsafely) has no nonce and is refused by the browser, so it cannot act with
 *   an operator's session. Styles stay `'unsafe-inline'`: the UI kit and charts set inline styles, and
 *   styles cannot run code. The nonce travels to the router as request context.
 * - CSRF: TanStack Start's own `createCsrfMiddleware`, which Start installs by itself only when there
 *   is no src/start.ts. It requires same-origin proof (Sec-Fetch-Site, then Origin, then Referer) for
 *   every server function call, GET included, and every other non-GET request (Better Auth's
 *   /api/auth, form posts). Top-level GET navigations are not checked: invitation and password-reset
 *   links arrive cross-site from email. The allowed origin is the console's public origin, not the
 *   internal request URL, which differs behind the edge proxy; without it every check fails closed.
 * - Baseline security headers, so a self-hosted install without our Caddy edge still sends them.
 *
 * Env is read inside callbacks, never at module scope (this file is part of both bundles).
 */
import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'
import { setResponseHeader } from '@tanstack/react-start/server'

/** The policy for one response. Exported for the unit test. */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // The captcha's proof of work runs in a worker file from our own origin (implement/24).
    "worker-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')
}

const securityHeaders = createMiddleware().server(async ({ next }) => {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
  // Not under `vite dev`: its client and React refresh preamble are injected without a nonce.
  if (!import.meta.env.DEV) setResponseHeader('Content-Security-Policy', contentSecurityPolicy(nonce))
  setResponseHeader('X-Content-Type-Options', 'nosniff')
  setResponseHeader('Referrer-Policy', 'no-referrer')
  setResponseHeader('X-Frame-Options', 'DENY')
  return next({ context: { nonce } })
})

function consoleOrigin(): string | null {
  try {
    return process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : null
  } catch {
    return null
  }
}

const csrf = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn' || (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD'),
  origin: (value) => value === consoleOrigin(),
})

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeaders, csrf],
}))
