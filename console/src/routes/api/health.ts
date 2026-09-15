import { createFileRoute } from '@tanstack/react-router'

// Container healthcheck and blackbox probe. Liveness only: it does not touch the database, so a
// database outage shows as failing sign-ins rather than a restart loop.
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => Response.json({ status: 'ok' }),
    },
  },
})
