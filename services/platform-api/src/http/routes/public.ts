/** Unauthenticated routes: ledger configuration for SDKs (P5) and a public health probe. */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { PlatformConfig } from '../../config.ts'

export const ledgerView = z.object({
  indyNamespace: z.string(),
  genesis: z.object({ url: z.string(), sha256: z.string(), signatureUrl: z.string(), signingPublicKey: z.string() }),
  vdrProxyUrl: z.string().nullable(),
})

export const publicRoutes = (deps: { config: PlatformConfig; readiness: () => Promise<{ ready: boolean }> }): FastifyPluginAsyncZod => async (app) => {
  app.get(
    '/v1/ledger',
    {
      schema: {
        tags: ['ledger'],
        summary: 'Ledger configuration',
        description: 'What an SDK needs to open the pool: the versioned, immutable genesis file (fetch it once and cache it to a file), its sha256, a minisign signature and the public key to verify it with, and the read-only HTTPS ledger proxy for networks that block Indy client ports.',
        response: { 200: ledgerView },
      },
    },
    async () => ({
      indyNamespace: deps.config.INDY_NAMESPACE,
      genesis: { url: deps.config.GENESIS_URL, sha256: deps.config.GENESIS_SHA256, signatureUrl: deps.config.GENESIS_SIGNATURE_URL, signingPublicKey: deps.config.GENESIS_SIGNING_PUBLIC_KEY },
      vdrProxyUrl: deps.config.VDR_PROXY_URL ?? null,
    })
  )

  app.get('/v1/health', { schema: { tags: ['ledger'], summary: 'Service health', response: { 200: z.object({ status: z.literal('ok') }), 503: z.object({ status: z.literal('degraded') }) } } }, async (_request, reply) => {
    const report = await deps.readiness()
    return report.ready ? { status: 'ok' as const } : reply.code(503).send({ status: 'degraded' as const })
  })
}
