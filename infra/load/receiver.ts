/**
 * W4 load test: the load tenant's webhook endpoint, behind the -R 3200 tunnel (smoke-issuer host), for the
 * length of a run. Points the tenant's webhook at itself, then counts events per minute and the lag from
 * an event's createdAt to its arrival (the dispatcher, review M2), and checks every signature.
 *
 *   PLATFORM_TENANT_ID=… node load/receiver.ts [--minutes 60]
 * Env as smoke/platform-common.ts (consoleClient over SSH; WEBHOOK_URL, RECEIVER_PORT).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { consoleClient, env, startReceiver } from '../smoke/platform-common.ts'
import { argValue, loadDir, percentiles } from './wallets.ts'

const minutes = Number(argValue('minutes', '60'))
const setup = consoleClient()
let secret = ''
const receiver = startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret })
await receiver.listening
const endpoint = await setup.must<{ secret?: string }>('PUT', '/v1/webhook', { url: env('WEBHOOK_URL', 'https://smoke-issuer.12id.naziharitsolution.com/webhook') })
secret = endpoint.secret ?? (await setup.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret
console.log(`receiving for ${minutes} min`)

const rows: Array<Record<string, unknown>> = []
let seen = 0
const tick = setInterval(() => {
  const batch = receiver.events.slice(seen)
  seen = receiver.events.length
  const lag = percentiles(batch.map((e) => Date.parse(e.receivedAt) - Date.parse(e.event.createdAt)))
  const byType: Record<string, number> = {}
  for (const e of batch) byType[e.type] = (byType[e.type] ?? 0) + 1
  const row = { at: new Date().toISOString(), events: batch.length, byType, badSignatures: batch.filter((e) => !e.signatureValid).length, lag }
  rows.push(row)
  console.log(JSON.stringify(row))
}, 60_000)
await new Promise((resolve) => setTimeout(resolve, minutes * 60_000))
clearInterval(tick)
const dir = join(loadDir(), 'results')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `receiver-${new Date().toISOString().replace(/[:.]/g, '')}.json`), JSON.stringify(rows, null, 2))
receiver.close()
process.exit(0)
