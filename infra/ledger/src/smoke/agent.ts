import 'reflect-metadata'

// Native bindings first - see src/bindings.ts for why the order is load-bearing.
import { anoncreds, askar, indyVdr } from '../bindings.ts'

import { createHash, randomBytes } from 'node:crypto'

import {
  AnonCredsModule,
  DidCommCredentialV1Protocol,
  DidCommProofV1Protocol,
  LegacyIndyDidCommCredentialFormatService,
  LegacyIndyDidCommProofFormatService,
} from '@credo-ts/anoncreds'
import { AskarModule } from '@credo-ts/askar'
import { Agent, DidsModule, LogLevel } from '@credo-ts/core'
import {
  DidCommAutoAcceptCredential,
  DidCommAutoAcceptProof,
  DidCommHttpOutboundTransport,
  type DidCommMediatorPickupStrategy,
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

import type { Express } from 'express'

import { PlainLogger } from '../logger.ts'

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`missing required environment variable ${name}`)
  return value
}

let genesis: string | undefined

async function loadGenesis(): Promise<string> {
  if (genesis) return genesis
  const response = await fetch(env('GENESIS_URL'))
  if (!response.ok) throw new Error(`genesis fetch failed: ${response.status}`)
  const text = await response.text()

  const expected = process.env.GENESIS_SHA256
  if (expected) {
    const actual = createHash('sha256').update(text).digest('hex')
    if (actual !== expected) throw new Error(`genesis sha256 mismatch: expected ${expected}, got ${actual}`)
  }
  genesis = text
  return text
}

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

export interface SmokeAgentOptions {
  name: string
  /** Public DIDComm endpoint advertised in DID documents and invitations. */
  endpoint?: string
  /** Local port for the HTTP inbound transport. Omit for an agent reachable only via a mediator. */
  port?: number
  /** Shares the inbound transport's express app so extra routes can live on the same port. */
  app?: Express
  mediatorInvitationUrl?: string
  pickupStrategy?: DidCommMediatorPickupStrategy
  /**
   * Outbound transports to register (default both). A Credo holder behind a ws-first
   * mediator must use ['http']: Credo's WS outbound transport keys sockets by
   * endpoint+connectionId and closes a new socket after a no-response message, so the
   * mediation grant lands on a socket that is being torn down and never arrives.
   */
  outbound?: Array<'http' | 'ws'>
}

/**
 * A disposable smoke-test agent: in-memory Askar wallet with a random key, so nothing
 * survives the run.
 *
 * Configured with the three settings the native holder needs (4-init §2.7.1): v1 protocols
 * only, the did:sov message type prefix, and unqualified identifiers (enforced by the
 * LegacyIndy format services).
 */
export async function createSmokeAgent(options: SmokeAgentOptions) {
  const outbound = options.outbound ?? ['http', 'ws']
  if (outbound.length === 0) throw new Error(`${options.name}: at least one outbound transport is required`)

  const agent = new Agent({
    config: { logger: new PlainLogger(logLevel(), options.name) },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({
        askar,
        store: {
          id: `${options.name}-${Date.now()}`,
          key: randomBytes(32).toString('base64url'),
          database: { type: 'sqlite', config: { inMemory: true } },
        },
      }),
      indyVdr: new IndyVdrModule({
        indyVdr,
        networks: [
          {
            isProduction: false,
            indyNamespace: env('INDY_NAMESPACE'),
            genesisTransactions: await loadGenesis(),
            connectOnStartup: true,
          },
        ],
      }),
      anoncreds: new AnonCredsModule({ anoncreds, registries: [new IndyVdrAnonCredsRegistry()] }),
      dids: new DidsModule({
        registrars: [new IndyVdrIndyDidRegistrar()],
        resolvers: [new IndyVdrIndyDidResolver(), new IndyVdrSovDidResolver()],
      }),
      didcomm: new DidCommModule({
        endpoints: options.endpoint ? [options.endpoint] : [],
        transports: {
          // The issuer needs WS outbound: holders advertise the mediator's wss:// endpoint.
          outbound: outbound.map((transport) =>
            transport === 'http' ? new DidCommHttpOutboundTransport() : new DidCommWsOutboundTransport()
          ),
          inbound: options.port ? [new DidCommHttpInboundTransport({ port: options.port, app: options.app })] : [],
        },
        useDidSovPrefixWhereAllowed: true,
        connections: { autoAcceptConnections: true },
        mediationRecipient: options.mediatorInvitationUrl
          ? { mediatorInvitationUrl: options.mediatorInvitationUrl, mediatorPickupStrategy: options.pickupStrategy }
          : undefined,
        credentials: {
          autoAcceptCredentials: DidCommAutoAcceptCredential.Always,
          credentialProtocols: [
            new DidCommCredentialV1Protocol({ indyCredentialFormat: new LegacyIndyDidCommCredentialFormatService() }),
          ],
        },
        proofs: {
          autoAcceptProofs: DidCommAutoAcceptProof.Always,
          proofProtocols: [
            new DidCommProofV1Protocol({ indyProofFormat: new LegacyIndyDidCommProofFormatService() }),
          ],
        },
      }),
    },
  })

  await agent.initialize()
  return agent
}

export type SmokeAgent = Awaited<ReturnType<typeof createSmokeAgent>>

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
