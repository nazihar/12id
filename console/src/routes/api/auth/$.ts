import { createFileRoute } from '@tanstack/react-router'

import { auth } from '@/server/auth.server'

// Better Auth's HTTP endpoints: sign-in, 2FA, organizations, admin. Its rate limiting, origin checks
// and cookies apply here. Tenant data never goes through this route; it comes from server functions.
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
})
