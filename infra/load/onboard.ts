/**
 * W4 load test, step 1: onboard simulated wallets the way the SDK does, once, with a real Credo holder.
 * Per wallet: POST /v1/wallets (API key) → wallet token → GET /v1/wallet/mediator-invitation → a
 * didcomm-only in-memory Credo holder connects to the mediator and is granted mediation (over HTTP:
 * Credo's WebSocket transport cannot do the handshake with this mediator, 6-phase-1-findings W8) →
 * it creates one out-of-band invitation, so the mediator's keylist holds a recipient key → its keys
 * are read out of the holder's Askar store and the holder is shut down. poll.ts and inject.ts then
 * drive the wallet without Credo.
 *
 *   PLATFORM_API_KEY=… node load/onboard.ts --run r1 --from 0 --count 1000 [--concurrency 20]
 * Env: PLATFORM_API (default staging). Resumable: wallets already in the run's files are skipped,
 * and the wallet's idempotency key (`load-<run>-<n>`) returns the same wallet on a retry.
 * `--invitation-url <url>` skips the platform and uses that (multi-use) invitation: local-mediator.ts.
 */
import '../smoke/bindings.ts'
import 'reflect-metadata'

import { randomBytes } from 'node:crypto'

import { AskarModule, AskarStoreManager } from '@credo-ts/askar'
import { Agent, LogLevel } from '@credo-ts/core'
import { DidCommDocumentService, DidCommHttpOutboundTransport, DidCommMediatorPickupStrategy, DidCommModule } from '@credo-ts/didcomm'
import { agentDependencies } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'

import { PlainLogger } from '../smoke/logger.ts'
import { env, platformClient } from '../smoke/platform-common.ts'
import { base58Encode, didKeyToVerkey } from './didcomm.ts'
import { appendWallet, argValue, type LoadWallet, readWallets, walletsFile } from './wallets.ts'

const run = argValue('run')
const from = Number(argValue('from', '0'))
const count = Number(argValue('count'))
const concurrency = Number(argValue('concurrency', '20'))
const baseUrl = env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')
const directInvitation = process.argv.includes('--invitation-url') ? argValue('invitation-url') : undefined
const api = directInvitation ? undefined : platformClient(baseUrl, env('PLATFORM_API_KEY'))
const file = walletsFile(run, `${from}`)

async function createHolder(n: number, mediatorInvitationUrl: string) {
  const agent = new Agent({
    config: { logger: new PlainLogger(process.env.LOG_LEVEL === 'debug' ? LogLevel.Debug : LogLevel.Error, `load-${n}`) },
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({ askar, store: { id: `load-${run}-${n}-${Date.now()}`, key: randomBytes(32).toString('base64url'), database: { type: 'sqlite', config: { inMemory: true } } } }),
      didcomm: new DidCommModule({
        endpoints: [],
        transports: { outbound: [new DidCommHttpOutboundTransport()], inbound: [] },
        useDidSovPrefixWhereAllowed: true,
        connections: { autoAcceptConnections: true },
        // PickUpV1 like the SDK: the keylist-update response is queued at the mediator and collected by a
        // poll (the holder's DID document names the mediator as its endpoint, so there is no return route).
        mediationRecipient: { mediatorInvitationUrl, mediatorPickupStrategy: DidCommMediatorPickupStrategy.PickUpV1, mediatorPollingInterval: 1_000 },
      }),
    },
  })
  await agent.initialize()
  return agent
}

const verkeyOf = (key: { publicKey: { publicKey: Uint8Array } }) => base58Encode(key.publicKey.publicKey)

async function onboard(n: number): Promise<LoadWallet> {
  let wallet = { id: `local-${run}-${n}` }
  let invitationUrl = directInvitation ?? ''
  if (api) {
    const created = await api.must<{ id: string; walletToken: string }>('POST', '/v1/wallets', { externalId: `load-${run}-${n}` }, { 'idempotency-key': `load-${run}-${n}` })
    wallet = created
    invitationUrl = (await platformClient(baseUrl, created.walletToken).must<{ invitationUrl: string }>('GET', '/v1/wallet/mediator-invitation')).invitationUrl
  }
  const agent = await createHolder(n, invitationUrl)
  try {
    const mediation = await agent.modules.didcomm.mediationRecipient.findDefaultMediator()
    if (!mediation || mediation.state !== 'granted') throw new Error(`mediation not granted (${mediation?.state ?? 'none'})`)
    const connection = await agent.modules.didcomm.connections.getById(mediation.connectionId)
    if (!connection.did || !connection.theirDid) throw new Error('mediation connection without DIDs')
    const documents = agent.dependencyManager.resolve(DidCommDocumentService)
    const theirServices = await documents.resolveServicesFromDid(agent.context, connection.theirDid)
    const ourServices = await documents.resolveServicesFromDid(agent.context, connection.did)
    const mediatorVerkey = verkeyOf(theirServices[0].recipientKeys[0])
    const holderVerkey = verkeyOf(ourServices[0].recipientKeys[0])

    // The keylist update happens here: Credo asks the mediator for routing for the new invitation.
    const oob = await agent.modules.didcomm.oob.createInvitation({ label: `load-${n}` })
    const service = oob.outOfBandInvitation.getInlineServices()[0]
    if (!service) throw new Error('invitation without an inline service')
    const recipientVerkey = didKeyToVerkey(service.recipientKeys[0])
    const routingKeys = (service.routingKeys ?? []).map(didKeyToVerkey)
    if (routingKeys.length === 0) throw new Error('invitation without mediator routing keys')

    const secrets = new Map<string, string>()
    const entries = await agent.dependencyManager.resolve(AskarStoreManager).withSession(agent.context, (session) => session.fetchAllKeys({}))
    for (const entry of entries) {
      if (entry.algorithm !== 'ed25519') continue
      secrets.set(base58Encode(entry.key.publicBytes), base58Encode(entry.key.secretBytes))
    }
    const holderSecret = secrets.get(holderVerkey)
    const recipientSecret = secrets.get(recipientVerkey)
    if (!holderSecret || !recipientSecret) throw new Error(`keys not found in the holder store (${secrets.size} keys)`)

    return {
      n,
      walletId: wallet.id,
      mediatorEndpoints: theirServices.map((s) => s.serviceEndpoint),
      mediatorVerkey,
      holder: { verkey: holderVerkey, secret: holderSecret },
      recipient: { verkey: recipientVerkey, secret: recipientSecret },
      routingKeys,
      createdAt: new Date().toISOString(),
    }
  } finally {
    await agent.modules.didcomm.mediationRecipient.stopMessagePickup().catch(() => undefined)
    await agent.shutdown().catch(() => undefined)
  }
}

// A holder's background pickup can still reject after its agent shut down; that is not a failed onboarding.
let stray = 0
process.on('unhandledRejection', (error) => {
  stray += 1
  if (stray <= 3) console.log(`  (ignored a stray rejection from a closed holder: ${error instanceof Error ? error.message.slice(0, 120) : error})`)
})

const done = new Set(readWallets(run).map((w) => w.n))
const queue: number[] = []
for (let n = from; n < from + count; n += 1) if (!done.has(n)) queue.push(n)
console.log(`run ${run}: ${queue.length} to onboard (${count - queue.length} already done), concurrency ${concurrency}, writing ${file}`)

const started = Date.now()
let ok = 0
let failed = 0
const durations: number[] = []
async function worker() {
  for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
    const t0 = Date.now()
    try {
      appendWallet(file, await onboard(n))
      ok += 1
      durations.push(Date.now() - t0)
    } catch (error) {
      failed += 1
      console.log(`  wallet ${n} failed after ${Date.now() - t0} ms: ${error instanceof Error ? error.message : error}`)
    }
    if ((ok + failed) % 50 === 0) {
      const rate = ((ok / (Date.now() - started)) * 60_000).toFixed(0)
      console.log(`  ${ok} ok, ${failed} failed, ${rate}/min`)
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
durations.sort((a, b) => a - b)
console.log(`done: ${ok} ok, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(0)} s; per wallet p50 ${durations[Math.floor(durations.length / 2)] ?? 0} ms, p95 ${durations[Math.floor(durations.length * 0.95)] ?? 0} ms`)
process.exit(failed > 0 ? 1 : 0)
