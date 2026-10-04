/**
 * Compares what inject.ts sent with what poll.ts received: lost and duplicated messages, and the
 * delivery latency. Used for the steady-state runs and for the mediator failover test (plan B2).
 *
 *   node load/delivery-report.ts --run r1 [--since 2026-10-02T10:00:00Z] [--grace 60]
 * Messages sent in the last --grace seconds before the newest receipt are not counted as lost.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { argValue, loadDir, percentiles } from './wallets.ts'

const run = argValue('run')
const since = Date.parse(argValue('since', '1970-01-01T00:00:00Z'))
const grace = Number(argValue('grace', '60')) * 1000
const dir = loadDir()

const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { id: string; n: number; at: string; deliveryMs?: number }) : [])

const sent = lines(join(dir, `sent-${run}.jsonl`)).filter((s) => Date.parse(s.at) >= since)
const received = readdirSync(dir).filter((f) => f.startsWith(`received-${run}.`)).flatMap((f) => lines(join(dir, f)))
const receivedCount = new Map<string, number>()
for (const r of received) receivedCount.set(r.id, (receivedCount.get(r.id) ?? 0) + 1)
const newest = Math.max(0, ...received.map((r) => Date.parse(r.at)))

const counted = sent.filter((s) => Date.parse(s.at) <= newest - grace)
const lost = counted.filter((s) => !receivedCount.has(s.id))
const duplicated = [...receivedCount.entries()].filter(([, c]) => c > 1)
const sentIds = new Set(sent.map((s) => s.id))
const delivery = percentiles(received.filter((r) => sentIds.has(r.id) && r.deliveryMs !== undefined).map((r) => r.deliveryMs as number))

console.log(JSON.stringify({ run, sent: sent.length, counted: counted.length, received: received.length, lost: lost.length, duplicated: duplicated.length, delivery }, null, 2))
if (lost.length > 0) {
  console.log('lost (first 20):')
  for (const l of lost.slice(0, 20)) console.log(`  ${l.at} wallet ${l.n} ${l.id}`)
}
