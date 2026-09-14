import { AskarStoreDuplicateError } from '@credo-ts/askar';
import { Agent } from '@credo-ts/core';
import { DidCommHttpOutboundTransport, DidCommMimeType, DidCommModule, DidCommOutOfBandRole, DidCommOutOfBandState, DidCommWsOutboundTransport, } from '@credo-ts/didcomm';
import { DidCommPushNotificationsFcmModule } from '@credo-ts/didcomm-push-notifications';
import { agentDependencies, DidCommHttpInboundTransport, DidCommWsInboundTransport } from '@credo-ts/node';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import Redis from 'ioredis';
import { WebSocketServer } from 'ws';
import { loadAskar } from './config/askarLoader.js';
import { loadCacheStorage } from './config/cacheLoader.js';
import { loadMessagePickupStorage } from './config/messagePickupLoader.js';
import { loadPushNotificationSender } from './config/pushNotificationLoader.js';
import { loadRedisMessageDelivery } from './config/redisMessageDeliveryLoader.js';
import { loadStorage } from './config/storageLoader.js';
import { config, logger } from './config.js';
async function createModules({ queueTransportRepository, app, socketServer, }) {
    const modules = {
        didcomm: new DidCommModule({
            endpoints: config.agentEndpoints,
            useDidSovPrefixWhereAllowed: true,
            didCommMimeType: DidCommMimeType.V0,
            queueTransportRepository,
            transports: {
                inbound: [
                    new DidCommHttpInboundTransport({ app, port: config.agentPort }),
                    new DidCommWsInboundTransport({ server: socketServer }),
                ],
                outbound: [new DidCommHttpOutboundTransport(), new DidCommWsOutboundTransport()],
            },
            connections: {
                autoAcceptConnections: true,
            },
            mediator: {
                autoAcceptMediationRequests: true,
                messageForwardingStrategy: config.messagePickup.forwardingStrategy,
            },
            // Protocols not needed for mediator
            basicMessages: false,
            credentials: false,
            proofs: false,
        }),
        pushNotificationsFcm: new DidCommPushNotificationsFcmModule(),
    };
    return modules;
}
export async function createAgent() {
    // We create our own instance of express here. This is not required
    // but allows use to use the same server (and port) for both WebSockets and HTTP
    const app = express();
    const socketServer = new WebSocketServer({ noServer: true });
    const redisClient = config.cache.type === 'redis' ? new Redis.default(config.cache.redisUrl) : undefined;
    const queueTransportRepository = await loadMessagePickupStorage();
    const storageModules = loadStorage();
    const askarModules = await loadAskar();
    const cacheModules = loadCacheStorage({
        redisClient,
    });
    const modules = {
        ...storageModules,
        ...askarModules,
        ...cacheModules,
        ...(await createModules({
            queueTransportRepository,
            app,
            socketServer,
        })),
    };
    const agent = new Agent({
        config: {
            logger,
            autoUpdateStorageOnStartup: true,
        },
        dependencies: agentDependencies,
        modules: modules,
    });
    // Added health check endpoint
    app.get('/health', async (_req, res) => {
        res.sendStatus(202);
    });
    app.get('/invite', async (req, res) => {
        if (!req.query._oobid || typeof req.query._oobid !== 'string') {
            return res.status(400).send('Missing or invalid _oobid');
        }
        const outOfBandRecord = await agent.didcomm.oob.findById(req.query._oobid);
        if (!outOfBandRecord ||
            outOfBandRecord.role !== DidCommOutOfBandRole.Sender ||
            outOfBandRecord.state !== DidCommOutOfBandState.AwaitResponse) {
            return res.status(400).send(`No invitation found for _oobid ${req.query._oobid}`);
        }
        return res.send(outOfBandRecord.outOfBandInvitation.toJSON());
    });
    // 12id patch (Phase 3 P1): per-wallet single-use invitations, minted by the platform API.
    // Internal network only (the edge answers 404 for /admin/*); the route is disabled unless
    // ADMIN_API_TOKEN is set. Same options as the startup invitation in index.js.
    const adminApiToken = process.env.ADMIN_API_TOKEN;
    app.post('/admin/invitations', express.json(), async (req, res) => {
        if (!adminApiToken || adminApiToken.length < 32) {
            return res.status(404).send('Not Found');
        }
        const presented = req.get('x-admin-token');
        const a = Buffer.from(typeof presented === 'string' ? presented : '');
        const b = Buffer.from(adminApiToken);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            return res.status(401).send('Unauthorized');
        }
        const outOfBandRecord = await agent.didcomm.oob.createInvitation({
            multiUseInvitation: false,
            goalCode: config.invitationGoalCode,
            goal: 'Mediator Invitation',
        });
        const invitationUrl = outOfBandRecord.outOfBandInvitation.toUrl({ domain: config.invitationUrl });
        return res.json({ outOfBandId: outOfBandRecord.id, invitationUrl });
    });
    try {
        await agent.modules.askar.provisionStore();
        agent.config.logger.info('Provisioned store');
    }
    catch (error) {
        if (error instanceof AskarStoreDuplicateError) {
            agent.config.logger.info('Store already exists');
        }
        else {
            agent.config.logger.error('Error provisioning store', {
                error,
            });
        }
    }
    // Optionally initialize queue transport repository
    // TODO: We should refactor this so it's handled by the agent.initialize (using a module?)
    await queueTransportRepository.initialize?.(agent);
    await agent.initialize();
    const inboundTransport = agent.didcomm.config.inboundTransports.find((transport) => transport instanceof DidCommHttpInboundTransport);
    inboundTransport?.server?.on('listening', () => {
        logger.info(`Agent listening on port ${config.agentPort}`);
    });
    inboundTransport?.server?.on('error', (err) => {
        logger.error(`Agent failed to start on port ${config.agentPort}`, err);
    });
    inboundTransport?.server?.on('close', () => {
        logger.info(`Agent stopped listening on port ${config.agentPort}`);
    });
    // When an 'upgrade' to WS is made on our http server, we forward the
    // request to the WS server
    inboundTransport?.server?.on('upgrade', (request, socket, head) => {
        socketServer.handleUpgrade(request, socket, head, (socket) => {
            socketServer.emit('connection', socket, request);
        });
    });
    await loadPushNotificationSender(agent);
    await loadRedisMessageDelivery({
        agent,
        // FIXME: somehow reusing the same Redis client makes everything fail
        /* redisClient */
    });
    return agent;
}
//# sourceMappingURL=agent.js.map