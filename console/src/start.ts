/**
 * Global request middleware (TanStack Start `createStart`).
 *
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

const securityHeaders = createMiddleware().server(async ({ next }) => {
  setResponseHeader('X-Content-Type-Options', 'nosniff')
  setResponseHeader('Referrer-Policy', 'no-referrer')
  setResponseHeader('X-Frame-Options', 'DENY')
  return next()
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
