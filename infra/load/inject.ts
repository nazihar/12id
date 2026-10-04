/**
 * W4 load test, step 3: queue messages for the simulated wallets the way an issuer does. Each message
 * is a `forward` to the mediator's routing key, carrying a trust ping anoncrypted to the wallet's
 * recipient key. The mediator queues it (QueueAndLiveModeDelivery) and fires one webhook per queued
 * message, so this also drives platform-api's wake path (wake.ts → wallet.sync_requested → the
 * webhook dispatcher, review M2). poll.ts collects the messages and records the delivery latency.
 *
 *   node load/inject.ts --run r1 --wallets 1000 --rate 10 --duration 600
 *   node load/inject.ts --run r1 --wallets 1000 --burst 1000 --burst-seconds 10
 *
 * Every sent id goes to LOAD_DIR/sent-<run>.jsonl; delivery-report.ts compares it with the received files.
 */
import '../smoke/bindings.ts'

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { connect, type ClientHttp2Session, constants as h2 } from 'node:http2'
import { join } from 'node:path'

import { forwardFor } from './didcomm.ts'
import { argValue, loadDir, percentiles, readWallets } from './wallets.ts'

const run = argValue('run')
const wallets = readWallets(run, Number(argValue('wallets')))
if (wallets.length === 0) throw new Error(`run ${run} has no wallets`)
const burst = process.argv.includes('--burst') ? Number(argValue('burst')) : 0
const rate = burst > 0 ? burst / Number(argValue('burst-seconds', '10')) : Number(argValue('rate', '10'))
const total = burst > 0 ? burst : Math.round(rate * Number(argValue('duration', '600')))
const sentFile = join(loadDir(), `sent-${run}.jsonl`)

// https in staging; plain http only against local-mediator.ts.
const endpoint = new URL(wallets[0].mediatorEndpoints.find((e) => e.startsWith('https://')) ?? wallets[0].mediatorEndpoints.find((e) => e.startsWith('http://')) ?? '')
// A few connections, like one agent-service process with keep-alive.
const sessions: ClientHttp2Session[] = []
function session(i: number): ClientHttp2Session {
  const slot = i % 4
  const existing = sessions[slot]
  if (existing && !existing.closed && !existing.destroyed) return existing
  const created = connect(endpoint.origin)
  created.on('error', () => undefined)
  sessions[slot] = created
  return created
}

async function post(i: number, body: string): Promise<number> {
  if (endpoint.protocol === 'http:') {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/didcomm-envelope-enc' }, body, signal: AbortSignal.timeout(30_000) })
    await response.arrayBuffer()
    return response.status
  }
  return new Promise((resolve, reject) => {
    const request = session(i).request({ [h2.HTTP2_HEADER_METHOD]: 'POST', [h2.HTTP2_HEADER_PATH]: endpoint.pathname || '/', 'content-type': 'application/didcomm-envelope-enc' })
    let status = 0
    const timer = setTimeout(() => {
      request.close(h2.NGHTTP2_CANCEL)
      reject(new Error('timeout'))
    }, 30_000)
    request.on('response', (headers) => (status = Number(headers[h2.HTTP2_HEADER_STATUS])))
    request.on('data', () => undefined)
    request.on('error', (error) => (clearTimeout(timer), reject(error)))
    request.on('end', () => (clearTimeout(timer), resolve(status)))
    request.end(body)
  })
}

console.log(`run ${run}: ${total} messages to ${wallets.length} wallets at ${rate.toFixed(1)}/s via ${endpoint.origin}`)
const latencies: number[] = []
const statuses: Record<string, number> = {}
const inFlight = new Set<Promise<void>>()
const started = Date.now()
for (let i = 0; i < total; i += 1) {
  const due = started + (i / rate) * 1000
  const wait = due - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  const wallet = wallets[Math.floor(Math.random() * wallets.length)]
  const id = randomUUID()
  const body = JSON.stringify(forwardFor(wallet.recipient.verkey, wallet.routingKeys, id))
  const t0 = performance.now()
  const task = post(i, body)
    .then((status) => {
      latencies.push(performance.now() - t0)
      statuses[status] = (statuses[status] ?? 0) + 1
      if (status < 300) appendFileSync(sentFile, `${JSON.stringify({ id, n: wallet.n, at: new Date().toISOString() })}\n`)
    })
    .catch((error: Error) => {
      statuses[error.message] = (statuses[error.message] ?? 0) + 1
    })
    .finally(() => inFlight.delete(task))
  inFlight.add(task)
  if (i > 0 && i % Math.max(1, Math.round(rate * 30)) === 0) console.log(`  ${i} sent, statuses ${JSON.stringify(statuses)}`)
}
await Promise.all(inFlight)
const p = percentiles(latencies)
console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s: statuses ${JSON.stringify(statuses)}, POST latency p50 ${p.p50.toFixed(0)} p95 ${p.p95.toFixed(0)} p99 ${p.p99.toFixed(0)} ms`)
for (const s of sessions) s?.close()
