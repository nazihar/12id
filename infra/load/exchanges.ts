/**
 * W4 load test, agent side (reviews L9, M1's concurrency switch, M2): M full Credo holders, each behind
 * the mediator with its own wallet, run credential offer → accept → done in a loop through the public
 * platform API for --duration seconds. Measures exchanges per minute, the time from the offer call to the
 * holder's `done`, and (with the receiver) the `credential.state_changed` webhook lag.
 * Run it once per agent setting (PROCESS_MESSAGES_CONCURRENTLY, ASKAR_MAX_CONNECTIONS) with the poll
 * driver holding the background load.
 *
 *   PLATFORM_API_KEY=… PLATFORM_TENANT_ID=… node load/exchanges.ts --holders 50 --duration 600 [--label conc-off]
 * Env as smoke/platform-credo.ts (the console client publishes the catalogue over SSH). With
 * WEBHOOK_URL set and the -R 3200 tunnel open, the webhook endpoint is pointed at this process.
 */
import '../smoke/bindings.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DidCommCredentialState } from '@credo-ts/didcomm'

import { createHolderAgent, type HolderAgent } from '../smoke/common.ts'
import { consoleClient, env, now, offerAttributes, platformClient, publishCatalogue, startReceiver } from '../smoke/platform-common.ts'
import { argValue, loadDir, percentiles } from './wallets.ts'

const holdersCount = Number(argValue('holders', '50'))
const duration = Number(argValue('duration', '600')) * 1000
const label = argValue('label', 'exchanges')
const baseUrl = env('PLATFORM_API', 'https://api.12id.naziharitsolution.com')
const api = platformClient(baseUrl, env('PLATFORM_API_KEY'))
const setup = consoleClient()
const webhookUrl = process.env.WEBHOOK_URL
const run = `x${Date.now()}`

let secret = ''
const receiver = webhookUrl ? startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret }) : undefined
if (receiver) {
  await receiver.listening
  const endpoint = await setup.must<{ secret?: string }>('PUT', '/v1/webhook', { url: webhookUrl })
  secret = endpoint.secret ?? (await setup.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret
}
const catalogue = await publishCatalogue(setup, 'load-badge')

interface Holder {
  n: number
  agent: HolderAgent
  connectionId: string
}

async function startHolder(n: number): Promise<Holder> {
  const wallet = await api.must<{ id: string; walletToken: string }>('POST', '/v1/wallets', { externalId: `${run}-${n}` })
  const { invitationUrl } = await platformClient(baseUrl, wallet.walletToken).must<{ invitationUrl: string }>('GET', '/v1/wallet/mediator-invitation')
  const agent = await createHolderAgent(`${run}-${n}`, { mediatorInvitationUrl: invitationUrl })
  const invitation = await api.must<{ invitationUrl: string }>('POST', '/v1/connections/invitations', { externalId: `${run}-${n}` })
  const received = await agent.modules.didcomm.oob.receiveInvitationFromUrl(invitation.invitationUrl, { label: `${run}-${n}` })
  if (!received.connectionRecord) throw new Error('no holder connection')
  await agent.modules.didcomm.connections.returnWhenIsConnected(received.connectionRecord.id, { timeoutMs: 120_000 })
  // The platform's id for this connection. The mirror follows the agent's outbox, so allow it a moment;
  // externalId is a contains match (`…-1` also finds `…-10`), hence the exact comparison.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const list = await api.must<{ items: Array<{ id: string; externalId: string | null; state: string }> }>('GET', `/v1/connections?externalId=${encodeURIComponent(`${run}-${n}`)}`)
    const connection = list.items.find((c) => c.externalId === `${run}-${n}` && c.state === 'completed')
    if (connection) return { n, agent, connectionId: connection.id }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`platform shows no completed connection for ${run}-${n}`)
}

console.log(`[${now()}] starting ${holdersCount} holders`)
const holders: Holder[] = []
for (let i = 0; i < holdersCount; i += 10) {
  const batch = await Promise.allSettled(Array.from({ length: Math.min(10, holdersCount - i) }, (_, k) => startHolder(i + k)))
  for (const result of batch) {
    if (result.status === 'fulfilled') holders.push(result.value)
    else console.log(`  holder failed to start: ${result.reason}`)
  }
  console.log(`  ${holders.length} holders connected`)
}

const offerToDone: number[] = []
const webhookLag: number[] = []
const errors: Record<string, number> = {}
let completed = 0
const startedAt = Date.now()
const endAt = startedAt + duration

async function loop(holder: Holder) {
  while (Date.now() < endAt) {
    const t0 = Date.now()
    try {
      const done = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 180_000)
        const sub = holder.agent.events.observable<any>('DidCommCredentialStateChanged').subscribe((e) => {
          if (e.payload.credentialExchangeRecord.state === DidCommCredentialState.Done) {
            clearTimeout(timer)
            sub.unsubscribe()
            resolve(Date.now())
          }
        })
      })
      const offer = await api.must<{ id: string }>('POST', '/v1/credentials/offer', { connectionId: holder.connectionId, credentialDefinitionId: catalogue.credentialDefinitionLedgerId, attributes: offerAttributes(`load-${holder.n}`) })
      const doneAt = await done
      offerToDone.push(doneAt - t0)
      completed += 1
      if (receiver) {
        receiver
          .waitFor('done webhook', (e) => e.type === 'credential.state_changed' && e.event.data.id === offer.id && e.event.data.state === 'done', 120_000)
          .then((e) => webhookLag.push(Date.parse(e.receivedAt) - doneAt))
          .catch(() => (errors.webhookMissing = (errors.webhookMissing ?? 0) + 1))
      }
    } catch (error) {
      const key = (error as Error).message.slice(0, 60)
      errors[key] = (errors[key] ?? 0) + 1
    }
  }
}

const ticker = setInterval(() => {
  const minutes = (Date.now() - startedAt) / 60_000
  const p = percentiles(offerToDone)
  console.log(`  [${now()}] ${completed} done (${(completed / minutes).toFixed(1)}/min)  offer→done p50 ${p.p50} p95 ${p.p95} ms  errors ${JSON.stringify(errors)}`)
}, 30_000)
await Promise.all(holders.map(loop))
clearInterval(ticker)
await new Promise((resolve) => setTimeout(resolve, 5_000))

const summary = {
  label, holders: holders.length, durationSeconds: duration / 1000, completed,
  perMinute: +(completed / (duration / 60_000)).toFixed(1),
  offerToDone: percentiles(offerToDone), webhookLag: percentiles(webhookLag), errors,
}
const dir = join(loadDir(), 'results')
mkdirSync(dir, { recursive: true })
const file = join(dir, `exchanges-${label}-${new Date().toISOString().replace(/[:.]/g, '')}.json`)
writeFileSync(file, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log(`→ ${file}`)
for (const h of holders) await h.agent.shutdown().catch(() => undefined)
receiver?.close()
process.exit(0)
