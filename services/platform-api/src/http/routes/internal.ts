/**
 * Not for customers. `/internal/mediator/:secret` is the mediator's push webhook target (P7);
 * `/internal/alerts` is where Alertmanager's webhook receiver reports (implement/22 C16);
 * `/healthz` and `/readyz` serve container checks. The edge answers 404 for /internal/*.
 */
import { tokenMatches } from '@12id/credo-base/internal-token.ts'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { alertmanagerBody, recordAlerts, sweepAlerts } from '../../alerts.ts'
import { bearerToken } from '../../auth/tokens.ts'
import type { Database } from '../../db/client.ts'
import type { WakeOutcome } from '../../wake.ts'

export interface InternalDeps {
  webhookSecret: string
  wake: (connectionId: string) => Promise<WakeOutcome>
  readiness: () => Promise<{ ready: boolean; draining: boolean; checks: Record<string, boolean> }>
  /** Absent, or without a secret: the alerts route does not exist for callers (404). */
  alerts?: { db: Database; secret: string | undefined }
}

export const internalRoutes = (deps: InternalDeps): FastifyPluginAsyncZod => async (app) => {
  app.get('/healthz', { schema: { hide: true, response: { 200: z.object({ status: z.literal('ok') }) } } }, async () => ({ status: 'ok' as const }))

  const readiness = z.object({ ready: z.boolean(), draining: z.boolean(), checks: z.record(z.string(), z.boolean()) })
  app.get('/readyz', { schema: { hide: true, response: { 200: readiness, 503: readiness } } }, async (_request, reply) => {
    const report = await deps.readiness()
    return reply.code(report.ready ? 200 : 503).send(report)
  })

  // The mediator sends `{ connectionId, fcmToken? }` with no authentication (findings W5); the
  // secret path is the only credential. Always answer quickly: the mediator never retries.
  app.post(
    '/internal/mediator/:secret',
    { schema: { hide: true, params: z.object({ secret: z.string() }), body: z.object({ connectionId: z.string().min(1) }).passthrough(), response: { 200: z.object({ outcome: z.string() }), 404: z.object({ error: z.string() }) } } },
    async (request, reply) => {
      if (!tokenMatches(request.params.secret, deps.webhookSecret)) return reply.code(404).send({ error: 'not_found' })
      const outcome = await deps.wake(request.body.connectionId)
      return { outcome }
    }
  )

  // Alertmanager sends every notification here: what fires, what resolved, and a Watchdog heartbeat
  // every five minutes. It runs on the host and reaches the published port on 127.0.0.1; the secret
  // is its bearer token (compose.monitoring.yml). A 5xx makes Alertmanager retry; a 4xx does not.
  app.post(
    '/internal/alerts',
    { schema: { hide: true, body: alertmanagerBody, response: { 200: z.object({ received: z.number().int() }), 401: z.object({ error: z.string() }), 404: z.object({ error: z.string() }) } } },
    async (request, reply) => {
      if (!deps.alerts?.secret) return reply.code(404).send({ error: 'not_found' })
      if (!tokenMatches(bearerToken(request.headers.authorization, ''), deps.alerts.secret)) return reply.code(401).send({ error: 'unauthorized' })
      await recordAlerts(deps.alerts.db, request.body.alerts)
      await sweepAlerts(deps.alerts.db)
      return { received: request.body.alerts.length }
    }
  )
}
