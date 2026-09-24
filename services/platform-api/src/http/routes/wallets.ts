/**
 * Wallets (P5). Two audiences:
 *   - the customer backend (API key) creates wallets and gets the wallet token to hand to its app;
 *   - the app / SDK (wallet token) fetches its mediator invitation and its own status.
 * Wallet endpoints are registered in two scopes by app.ts because the credentials differ.
 */
import { type SQL, and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { preHandlerAsyncHookHandler } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { WALLET_TOKEN_PREFIX, generateSecret, hashSecret } from '../../auth/tokens.ts'
import type { Database } from '../../db/client.ts'
import { wallets } from '../../db/schema.ts'
import type { MediatorClient } from '../../mediator-client.ts'
import { toWalletView, walletView } from '../../views.ts'
import type { TenantContext, WalletContext } from '../auth.ts'
import { notFound } from '../errors.ts'
import { containsI, createdBetween, createdRange, listPage, pageOf, pageQuery, searchQuery } from '../list.ts'

const errorBody = z.object({ error: z.string(), reason: z.string() })

export const walletCustomerRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => request.tenant as TenantContext

  app.post(
    '/v1/wallets',
    {
      schema: {
        tags: ['wallets'],
        summary: 'Create a wallet',
        description:
          'One wallet per SDK installation. The returned `walletToken` is shown once; pass it to your app, which gives it to the SDK. The platform never learns who the end user is; `externalId` is your own reference (for example your user id, shared by that user\'s devices) and is echoed in `wallet.sync_requested` webhooks.\n\n' +
          'Retries: send your app\'s installation id (a UUID the app generates once and keeps) as `Idempotency-Key`. A retry with the same key and body returns the **same wallet with a new `walletToken`**, and earlier tokens for that wallet stop working, so always give the app the most recent token. Tokens are never stored. While the first request is still running, a retry answers 409 `idempotency_in_progress`; retry after `Retry-After` seconds. If that wallet was revoked, a retry answers 409 `wallet_revoked`.',
        body: z.object({ externalId: z.string().min(1).max(200).optional() }).default({}),
        response: { 201: walletView.extend({ walletToken: z.string() }), 409: errorBody },
      },
      config: {
        idempotency: {
          store: (body) => {
            const { walletToken: _token, ...wallet } = body as Record<string, unknown>
            return wallet
          },
          // Nobody received the first token (that is why the request is retried): mint a new one for the same wallet.
          replay: async (request, reply, stored) => {
            const walletId = (stored.body as { id: string }).id
            const token = generateSecret(WALLET_TOKEN_PREFIX)
            const [row] = await deps.db
              .update(wallets)
              .set({ tokenHash: hashSecret(token) })
              .where(and(eq(wallets.tenantId, tenant(request).id), eq(wallets.id, walletId), isNull(wallets.revokedAt)))
              .returning()
            if (!row) return reply.code(409).send({ error: 'wallet_revoked', reason: 'The wallet created for this Idempotency-Key has been revoked; use a new key to create another wallet' })
            return reply.code(201).send({ ...toWalletView(row), walletToken: token })
          },
        },
      },
    },
    async (request, reply) => {
      const token = generateSecret(WALLET_TOKEN_PREFIX)
      const [row] = await deps.db.insert(wallets).values({ tenantId: tenant(request).id, externalId: request.body.externalId ?? null, tokenHash: hashSecret(token) }).returning()
      return reply.code(201).send({ ...toWalletView(row), walletToken: token })
    }
  )

  app.get(
    '/v1/wallets',
    {
      schema: {
        tags: ['wallets'],
        summary: 'List wallets',
        description: 'Newest first (`createdAt` descending), paged with `page` and `pageSize`. `q` matches the external id.',
        querystring: pageQuery.extend(createdRange.shape).extend(searchQuery.shape).extend({ status: z.enum(['active', 'revoked']).optional() }),
        response: { 200: pageOf(walletView) },
      },
    },
    async (request) => {
      const { q, status } = request.query
      const filters: SQL[] = [eq(wallets.tenantId, tenant(request).id), ...createdBetween(wallets.createdAt, request.query)]
      if (q) filters.push(containsI(wallets.externalId, q))
      if (status) filters.push(status === 'active' ? isNull(wallets.revokedAt) : isNotNull(wallets.revokedAt))
      const page = await listPage(deps.db, { table: wallets, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(wallets).where(where).orderBy(desc(wallets.createdAt), desc(wallets.id)).limit(limit).offset(offset)
      )
      return { ...page, items: page.items.map(toWalletView) }
    }
  )

  app.get('/v1/wallets/:id', { schema: { tags: ['wallets'], summary: 'Get a wallet', params: z.object({ id: z.uuid() }), response: { 200: walletView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(wallets).where(and(eq(wallets.tenantId, tenant(request).id), eq(wallets.id, request.params.id)))
    if (!row) throw notFound('wallet')
    return toWalletView(row)
  })

  app.delete(
    '/v1/wallets/:id',
    { schema: { tags: ['wallets'], summary: 'Revoke a wallet', description: 'Revokes the wallet token at once: the app gets 401 and the platform stops mapping mediator webhooks to it. The device keeps its local data. 30 days later the platform also removes its mediator connection, so the app can no longer receive messages; it must call reset() and credentials are issued again. Wallets that never connected to the mediator are revoked by the platform after 7 days (revokedReason never_connected).', params: z.object({ id: z.uuid() }), response: { 200: walletView, 404: errorBody } } },
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

export const walletDeviceRoutes = (deps: { db: Database; mediator: Pick<MediatorClient, 'createInvitation'>; invitationLimit?: preHandlerAsyncHookHandler }): FastifyPluginAsyncZod => async (app) => {
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
        response: { 200: z.object({ invitationUrl: z.string() }), 429: errorBody, 502: errorBody },
      },
      // Each call creates a mediator record (review M4): a few per 10 minutes per wallet.
      ...(deps.invitationLimit ? { preHandler: deps.invitationLimit } : {}),
    },
    async (request) => {
      const w = wallet(request)
      const invitation = await deps.mediator.createInvitation()
      await deps.db.update(wallets).set({ mediatorOobId: invitation.outOfBandId, mediatorConnectionId: null }).where(eq(wallets.id, w.id))
      return { invitationUrl: invitation.invitationUrl }
    }
  )
}
