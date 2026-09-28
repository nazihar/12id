// Native bindings before any @credo-ts/* import (4-init §7.1).
import { askar, indyVdr } from '@12id/credo-base/bindings.ts'

import { postgresStore } from '@12id/credo-base/askar-postgres.ts'
import { fetchPinnedGenesis } from '@12id/credo-base/genesis.ts'
import { PinoCredoLogger } from '@12id/credo-base/logger.ts'
import { AskarModule } from '@credo-ts/askar'
import { Agent, DidsModule } from '@credo-ts/core'
import { IndyVdrIndyDidResolver, IndyVdrModule } from '@credo-ts/indy-vdr'
import { agentDependencies } from '@credo-ts/node'
import type { Logger as PinoLogger } from 'pino'

import type { EndorserServiceConfig } from '../config.ts'

/**
 * A Credo agent that only signs. No DIDComm, no AnonCreds registry, no ledger writes: the pool
 * is loaded because signing an unsigned NYM resolves the pool for the endorser DID (T2).
 */
export async function createEndorserAgent(config: EndorserServiceConfig, logger: PinoLogger) {
  const genesisTransactions = await fetchPinnedGenesis(config.GENESIS_URL, config.GENESIS_SHA256)
  return new Agent({
    config: { logger: new PinoCredoLogger(logger.child({ component: 'credo' })) },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar,
        store: postgresStore({
          id: config.ASKAR_STORE_ID,
          key: config.ASKAR_STORE_KEY,
          host: config.POSTGRES_HOST,
          user: config.POSTGRES_USER,
          password: config.POSTGRES_PASSWORD,
        }),
      }),
      indyVdr: new IndyVdrModule({
        indyVdr,
        networks: [{ isProduction: config.INDY_NETWORK_PRODUCTION, indyNamespace: config.INDY_NAMESPACE, genesisTransactions, connectOnStartup: true }],
      }),
      dids: new DidsModule({ resolvers: [new IndyVdrIndyDidResolver()] }),
    },
  })
}

export type EndorserAgent = Awaited<ReturnType<typeof createEndorserAgent>>

/** Fails start-up unless the store holds the configured endorser DID (wrong store or key). */
export async function assertEndorserDidInStore(agent: EndorserAgent, endorserDid: string) {
  const records = await agent.dids.getCreatedDids({ method: 'indy', did: endorserDid })
  if (records.length !== 1) {
    throw new Error(`endorser store does not hold ${endorserDid}; refusing to start`)
  }
}
