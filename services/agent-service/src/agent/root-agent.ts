// Native bindings before any @credo-ts/* import (4-init §7.1).
import { anoncreds, askar, indyVdr } from '@12id/credo-base/bindings.ts'

import { TENANT_STORAGE_SCHEME, postgresStore } from '@12id/credo-base/askar-postgres.ts'
import { multiTenantCacheModule } from '@12id/credo-base/cache.ts'
import { fetchPinnedGenesis } from '@12id/credo-base/genesis.ts'
import { PinoCredoLogger } from '@12id/credo-base/logger.ts'
import {
  AnonCredsModule,
  DidCommCredentialV1Protocol,
  DidCommProofV1Protocol,
  LegacyIndyDidCommCredentialFormatService,
  LegacyIndyDidCommProofFormatService,
} from '@credo-ts/anoncreds'
import { AskarModule } from '@credo-ts/askar'
import { Agent, DidsModule } from '@credo-ts/core'
import {
  DidCommAutoAcceptCredential,
  DidCommAutoAcceptProof,
  DidCommHttpOutboundTransport,
  DidCommModule,
  DidCommWsOutboundTransport,
} from '@credo-ts/didcomm'
import {
  IndyVdrAnonCredsRegistry,
  IndyVdrIndyDidRegistrar,
  IndyVdrIndyDidResolver,
  IndyVdrModule,
  IndyVdrSovDidResolver,
} from '@credo-ts/indy-vdr'
import { DidCommHttpInboundTransport, agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import type { Express } from 'express'
import type { Logger as PinoLogger } from 'pino'

import type { AgentServiceConfig } from '../config.ts'

export interface RootAgentOptions {
  /**
   * Express app for the DIDComm port. Credo adds its POST route to it; we add GET /readyz so the
   * edge can health-check the same port it proxies (the internal API is not reachable by Caddy).
   */
  didcommApp?: Express
}

/**
 * Modules every tenant agent inherits. Typed separately so `withTenantAgent` hands out a tenant
 * agent with typed modules (the spikes had to cast).
 */
function tenantModules(config: AgentServiceConfig, genesisTransactions: string, options: RootAgentOptions) {
  return {
    askar: new AskarModule({
      askar,
      multiWalletDatabaseScheme: TENANT_STORAGE_SCHEME,
      store: postgresStore({
        id: config.ASKAR_STORE_ID,
        key: config.ASKAR_STORE_KEY,
        host: config.POSTGRES_HOST,
        user: config.POSTGRES_USER,
        password: config.POSTGRES_PASSWORD,
        adminUser: config.POSTGRES_ADMIN_USER,
        adminPassword: config.POSTGRES_ADMIN_PASSWORD,
        maxConnections: config.ASKAR_MAX_CONNECTIONS,
      }),
    }),
    indyVdr: new IndyVdrModule({
      indyVdr,
      networks: [
        { isProduction: config.INDY_NETWORK_PRODUCTION, indyNamespace: config.INDY_NAMESPACE, genesisTransactions, connectOnStartup: true },
      ],
    }),
    anoncreds: new AnonCredsModule({ anoncreds, registries: [new IndyVdrAnonCredsRegistry()] }),
    dids: new DidsModule({
      registrars: [new IndyVdrIndyDidRegistrar()],
      resolvers: [new IndyVdrIndyDidResolver(), new IndyVdrSovDidResolver()],
    }),
    // Shared by all tenants; public ledger data only (T1 trap 1-2).
    cache: multiTenantCacheModule(),
    didcomm: new DidCommModule({
      endpoints: [config.DIDCOMM_ENDPOINT],
      transports: {
        inbound: [new DidCommHttpInboundTransport({ port: config.DIDCOMM_PORT, app: options.didcommApp })],
        // WS outbound is required: native holders advertise the mediator's wss:// endpoint.
        outbound: [new DidCommHttpOutboundTransport(), new DidCommWsOutboundTransport()],
      },
      processDidCommMessagesConcurrently: config.PROCESS_MESSAGES_CONCURRENTLY,
      // The three settings the native holder needs; each fails silently when wrong (4-init §2.7.1).
      useDidSovPrefixWhereAllowed: true,
      connections: { autoAcceptConnections: true },
      credentials: {
        // ContentApproved: continue only when the holder's message matches what we sent (their
        // request matches our offer). Holder-initiated proposals still wait for the platform.
        autoAcceptCredentials: DidCommAutoAcceptCredential.ContentApproved,
        credentialProtocols: [
          new DidCommCredentialV1Protocol({ indyCredentialFormat: new LegacyIndyDidCommCredentialFormatService() }),
        ],
      },
      proofs: {
        // Verify a presentation automatically when it answers our own proof request.
        autoAcceptProofs: DidCommAutoAcceptProof.ContentApproved,
        proofProtocols: [new DidCommProofV1Protocol({ indyProofFormat: new LegacyIndyDidCommProofFormatService() })],
      },
    }),
  }
}

export type TenantModules = ReturnType<typeof tenantModules>

/** Builds (does not initialize) the root agent. `provision.ts` and `main.ts` share it. */
export async function createRootAgent(config: AgentServiceConfig, logger: PinoLogger, options: RootAgentOptions = {}) {
  const genesisTransactions = await fetchPinnedGenesis(config.GENESIS_URL, config.GENESIS_SHA256)
  return new Agent({
    config: { logger: new PinoCredoLogger(logger.child({ component: 'credo' })) },
    dependencies: agentDependencies,
    modules: {
      ...tenantModules(config, genesisTransactions, options),
      tenants: new TenantsModule<TenantModules>({
        sessionLimit: config.TENANT_SESSION_LIMIT,
        sessionAcquireTimeout: config.TENANT_SESSION_ACQUIRE_TIMEOUT_MS,
      }),
    },
  })
}

export type RootAgent = Awaited<ReturnType<typeof createRootAgent>>
