/**
 * Wallets (P5). Two audiences:
 *   - the customer backend (API key) creates wallets and gets the wallet token to hand to its app;
 *   - the app / SDK (wallet token) fetches its mediator invitation and its own status.
 * Wallet endpoints are registered in two scopes by app.ts because the credentials differ.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { WALLET_TOKEN_PREFIX, generateSecret, hashSecret } from '../../auth/tokens.ts'
import type { Database } from '../../db/client.ts'
import { wallets } from '../../db/schema.ts'
import type { MediatorClient } from '../../mediator-client.ts'
import { toWalletView, walletView } from '../../views.ts'
import type { TenantContext, WalletContext } from '../auth.ts'
import { notFound } from '../errors.ts'

const errorBody = z.object({ error: z.string(), reason: z.string() })

export const walletCustomerRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => request.tenant as TenantContext

  app.post(
    '/v1/wallets',
    {
      schema: {
        tags: ['wallets'],
        summary: 'Create a wallet',
        description: 'One wallet per SDK installation. The returned `walletToken` is shown once; pass it to your app, which gives it to the SDK. The platform never learns who the end user is; `externalId` is your own reference and is echoed in `wallet.sync_requested` webhooks.',
        body: z.object({ externalId: z.string().min(1).max(200).optional() }).default({}),
        response: { 201: walletView.extend({ walletToken: z.string() }) },
      },
    },
    async (request, reply) => {
      const token = generateSecret(WALLET_TOKEN_PREFIX)
      const [row] = await deps.db.insert(wallets).values({ tenantId: tenant(request).id, externalId: request.body.externalId ?? null, tokenHash: hashSecret(token) }).returning()
      return reply.code(201).send({ ...toWalletView(row), walletToken: token })
    }
  )

  app.get('/v1/wallets', { schema: { tags: ['wallets'], summary: 'List wallets', querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: z.array(walletView) } } }, async (request) => {
    const rows = await deps.db.select().from(wallets).where(eq(wallets.tenantId, tenant(request).id)).orderBy(desc(wallets.createdAt)).limit(request.query.limit)
    return rows.map(toWalletView)
  })

  app.get('/v1/wallets/:id', { schema: { tags: ['wallets'], summary: 'Get a wallet', params: z.object({ id: z.uuid() }), response: { 200: walletView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(wallets).where(and(eq(wallets.tenantId, tenant(request).id), eq(wallets.id, request.params.id)))
    if (!row) throw notFound('wallet')
    return toWalletView(row)
  })

  app.delete(
    '/v1/wallets/:id',
    { schema: { tags: ['wallets'], summary: 'Revoke a wallet', description: 'Revokes the wallet token; the device keeps its local data and its mediator connection, but the platform stops mapping mediator webhooks to it.', params: z.object({ id: z.uuid() }), response: { 200: walletView, 404: errorBody } } },
    async (request) => {
      const [row] = await deps.db
        .update(wallets)
        .set({ revokedAt: new Date() })
        .where(and(eq(wallets.tenantId, tenant(request).id), eq(wallets.id, request.params.id), isNull(wallets.revokedAt)))
        .returning()
      if (!row) throw notFound('wallet')
      return toWalletView(row)
    }
  )
}

export const walletDeviceRoutes = (deps: { db: Database; mediator: Pick<MediatorClient, 'createInvitation'> }): FastifyPluginAsyncZod => async (app) => {
  const wallet = (request: { wallet?: WalletContext }) => request.wallet as WalletContext

  app.get('/v1/wallet', { schema: { tags: ['wallet (SDK)'], summary: 'This wallet', security: [{ walletToken: [] }], response: { 200: walletView } } }, async (request) => {
    const [row] = await deps.db.select().from(wallets).where(eq(wallets.id, wallet(request).id))
    return toWalletView(row)
  })

  app.get(
    '/v1/wallet/mediator-invitation',
    {
      schema: {
        tags: ['wallet (SDK)'],
        summary: 'Mediator invitation for this wallet',
        description: 'Mints a single-use out-of-band invitation for the platform mediator. Call once at first launch and connect immediately; calling again replaces the previous invitation.',
        security: [{ walletToken: [] }],
        response: { 200: z.object({ invitationUrl: z.string() }), 502: errorBody },
      },
    },
    async (request) => {
      const w = wallet(request)
      const invitation = await deps.mediator.createInvitation()
      await deps.db.update(wallets).set({ mediatorOobId: invitation.outOfBandId, mediatorConnectionId: null }).where(eq(wallets.id, w.id))
      return { invitationUrl: invitation.invitationUrl }
    }
  )
}
