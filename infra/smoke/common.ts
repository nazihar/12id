import 'reflect-metadata'

// Native bindings before any @credo-ts/* import.
import { anoncreds, askar, indyVdr } from './bindings.ts'

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  AnonCredsModule,
  DidCommCredentialV1Protocol,
  DidCommProofV1Protocol,
  LegacyIndyDidCommCredentialFormatService,
  LegacyIndyDidCommProofFormatService,
} from '@credo-ts/anoncreds'
import { AskarModule, AskarMultiWalletDatabaseScheme, AskarStoreDuplicateError } from '@credo-ts/askar'
import { Agent, CacheModule, DidsModule, InMemoryLruCache, LogLevel, type ModulesMap, TypedArrayEncoder } from '@credo-ts/core'
import {
  DidCommAutoAcceptCredential,
  DidCommAutoAcceptProof,
  DidCommHttpOutboundTransport,
  DidCommMediatorPickupStrategy,
  DidCommModule,
  DidCommWsOutboundTransport,
} from '@credo-ts/didcomm'
import {
  IndyVdrAnonCredsRegistry,
  IndyVdrIndyDidRegistrar,
  IndyVdrIndyDidResolver,
  IndyVdrModule,
  IndyVdrPoolService,
  IndyVdrSovDidResolver,
} from '@credo-ts/indy-vdr'
import { DidCommHttpInboundTransport, agentDependencies } from '@credo-ts/node'
import { TenantsModule } from '@credo-ts/tenants'
import { GetNymRequest } from '@hyperledger/indy-vdr-nodejs'

import { PlainLogger } from './logger.ts'

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`missing required environment variable ${name}`)
  return value
}

// Staging defaults (implement/6-phase-1-findings.md W2). Overridable for a different ledger.
export const INDY_NAMESPACE = env('INDY_NAMESPACE', 'twelveid:staging')
const GENESIS_URL = env('GENESIS_URL', 'https://genesis.12id.naziharitsolution.com/v1/pool_transactions_genesis')
const GENESIS_SHA256 = env('GENESIS_SHA256', '6ab9bc1a3ba5ff257454ca8500a41d45756cd02c3db6c280bde51c7b363a835a')

function logLevel(): LogLevel {
  switch (process.env.LOG_LEVEL) {
    case 'debug':
      return LogLevel.Debug
    case 'info':
      return LogLevel.Info
    default:
      return LogLevel.Warn
  }
}

let genesis: string | undefined
export async function loadGenesis(): Promise<string> {
  if (genesis) return genesis
  const response = await fetch(GENESIS_URL)
  if (!response.ok) throw new Error(`genesis fetch failed: ${response.status}`)
  const text = await response.text()
  const actual = createHash('sha256').update(text).digest('hex')
  if (actual !== GENESIS_SHA256) throw new Error(`genesis sha256 mismatch: expected ${GENESIS_SHA256}, got ${actual}`)
  genesis = text
  return text
}

async function ledgerModules() {
  return {
    indyVdr: new IndyVdrModule({
      indyVdr,
      networks: [
        { isProduction: false, indyNamespace: INDY_NAMESPACE, genesisTransactions: await loadGenesis(), connectOnStartup: true },
      ],
    }),
    anoncreds: new AnonCredsModule({ anoncreds, registries: [new IndyVdrAnonCredsRegistry()] }),
    dids: new DidsModule({
      registrars: [new IndyVdrIndyDidRegistrar()],
      resolvers: [new IndyVdrIndyDidResolver(), new IndyVdrSovDidResolver()],
    }),
  }
}

function v1DidComm(options: {
  endpoint?: string
  port?: number
  outbound: Array<'http' | 'ws'>
  mediatorInvitationUrl?: string
  pickupStrategy?: DidCommMediatorPickupStrategy
  /** Auto-accept credential and proof steps (default true). T3 turns it off to control timing. */
  autoAccept?: boolean
}) {
  const autoAccept = options.autoAccept ?? true
  return new DidCommModule({
    endpoints: options.endpoint ? [options.endpoint] : [],
    transports: {
      outbound: options.outbound.map((t) => (t === 'http' ? new DidCommHttpOutboundTransport() : new DidCommWsOutboundTransport())),
      inbound: options.port ? [new DidCommHttpInboundTransport({ port: options.port })] : [],
    },
    // The three settings the native holder needs (4-init §2.7.1).
    useDidSovPrefixWhereAllowed: true,
    connections: { autoAcceptConnections: true },
    mediationRecipient: options.mediatorInvitationUrl
      ? { mediatorInvitationUrl: options.mediatorInvitationUrl, mediatorPickupStrategy: options.pickupStrategy }
      : undefined,
    credentials: {
      autoAcceptCredentials: autoAccept ? DidCommAutoAcceptCredential.Always : DidCommAutoAcceptCredential.Never,
      credentialProtocols: [new DidCommCredentialV1Protocol({ indyCredentialFormat: new LegacyIndyDidCommCredentialFormatService() })],
    },
    proofs: {
      autoAcceptProofs: autoAccept ? DidCommAutoAcceptProof.Always : DidCommAutoAcceptProof.Never,
      proofProtocols: [new DidCommProofV1Protocol({ indyProofFormat: new LegacyIndyDidCommProofFormatService() })],
    },
  })
}

/**
 * T1: the multi-tenant root agent. Askar on Postgres with one profile per tenant in a
 * single store (Credo's default is still DatabasePerWallet, for backwards compatibility).
 */
export async function createRootAgent(options: { storeId: string; storeKey: string; endpoint: string; port: number }) {
  const agent = new Agent({
    config: { logger: new PlainLogger(logLevel(), 'root') },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar,
        multiWalletDatabaseScheme: AskarMultiWalletDatabaseScheme.ProfilePerWallet,
        store: {
          id: options.storeId,
          key: options.storeKey,
          database: {
            type: 'postgres',
            config: { host: env('POSTGRES_HOST', '127.0.0.1:55432'), connectTimeout: 10 },
            credentials: {
              account: env('POSTGRES_USER', 'postgres'),
              password: env('POSTGRES_PASSWORD', 'spike-only'),
              adminAccount: env('POSTGRES_USER', 'postgres'),
              adminPassword: env('POSTGRES_PASSWORD', 'spike-only'),
            },
          },
        },
      }),
      ...(await ledgerModules()),
      // The default SingleContextStorageLruCache binds to the first agent context that uses it;
      // the second tenant then fails ledger reads with "can not be used with multiple agent
      // context instances" (T1). InMemoryLruCache is shared across contexts.
      cache: new CacheModule({ cache: new InMemoryLruCache({ limit: 500 }) }),
      didcomm: v1DidComm({ endpoint: options.endpoint, port: options.port, outbound: ['http', 'ws'] }),
      tenants: new TenantsModule({ sessionLimit: 20, sessionAcquireTimeout: 10_000 }),
    },
  })

  try {
    await agent.modules.askar.provisionStore()
    console.log(`provisioned Askar store '${options.storeId}' on postgres`)
  } catch (error) {
    if (!(error instanceof AskarStoreDuplicateError)) throw error
    console.log(`Askar store '${options.storeId}' already exists`)
  }
  await agent.initialize()
  return agent
}

export type RootAgent = Awaited<ReturnType<typeof createRootAgent>>

/** A disposable agent with an in-memory SQLite store. */
async function createMemoryAgent<M extends ModulesMap>(name: string, extra: M) {
  const agent = new Agent({
    config: { logger: new PlainLogger(logLevel(), name) },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar,
        store: { id: `${name}-${Date.now()}`, key: randomBytes(32).toString('base64url'), database: { type: 'sqlite', config: { inMemory: true } } },
      }),
      ...(await ledgerModules()),
      ...extra,
    },
  })
  await agent.initialize()
  return agent
}

/** Stands in for the endorser-service in the spikes: holds a throwaway ENDORSER DID. */
export async function createEndorserAgent() {
  return createMemoryAgent('endorser', {})
}
export type EndorserAgent = Awaited<ReturnType<typeof createEndorserAgent>>

/** A Credo holder behind the staging mediator (HTTP outbound + PickUpV2: findings W8). */
export async function createHolderAgent(name: string, options: { autoAccept?: boolean } = {}) {
  const invitationFile = env('MEDIATOR_INVITATION_FILE')
  return createMemoryAgent(name, {
    didcomm: v1DidComm({
      outbound: ['http'],
      mediatorInvitationUrl: readFileSync(invitationFile, 'utf8').trim(),
      pickupStrategy: DidCommMediatorPickupStrategy.PickUpV2,
      autoAccept: options.autoAccept,
    }),
  })
}
export type HolderAgent = Awaited<ReturnType<typeof createHolderAgent>>

export interface NymData {
  dest: string
  verkey: string
  role: string | null
}

export async function readNym(agent: { dependencyManager: RootAgent['dependencyManager'] }, nym: string): Promise<NymData | null> {
  const pool = agent.dependencyManager.resolve(IndyVdrPoolService).getPoolForNamespace(INDY_NAMESPACE)
  const response = await pool.submitRequest(new GetNymRequest({ dest: nym }))
  const data = (response.result as { data?: string | null }).data
  return data ? (JSON.parse(data) as NymData) : null
}

/**
 * Registers the spike endorser DID through von-network's /register, reached over the SSH
 * tunnel (LEDGER_REGISTER_URL). Throwaway: the real staging endorser key never leaves the VM.
 */
export async function createSpikeEndorserDid(endorser: EndorserAgent, alias: string) {
  const { keyId, publicJwk } = await endorser.kms.createKey({ type: { kty: 'OKP', crv: 'Ed25519' } })
  const publicKeyBytes = TypedArrayEncoder.fromBase64Url((publicJwk as { x: string }).x)
  const verkey = TypedArrayEncoder.toBase58(publicKeyBytes)
  const nym = TypedArrayEncoder.toBase58(publicKeyBytes.slice(0, 16))
  const did = `did:indy:${INDY_NAMESPACE}:${nym}`

  const response = await fetch(env('LEDGER_REGISTER_URL', 'http://127.0.0.1:19000/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did: nym, verkey, alias, role: 'ENDORSER' }),
  })
  if (!response.ok) throw new Error(`endorser NYM registration failed: ${response.status} ${await response.text()}`)

  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      await endorser.dids.import({ did, keys: [{ kmsKeyId: keyId, didDocumentRelativeKeyId: '#verkey' }], overwrite: true })
      break
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  return { did, nym, verkey }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s waiting for ${what}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
