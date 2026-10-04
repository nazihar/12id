/**
 * W4 load test, step 2: the PickUpV1 poll driver. Every simulated wallet does what the SDK's
 * MediationRecipient does (sdk-android/ariesframework …/routing/MediationRecipient.kt): every 10 s a
 * `batch-pickup` (batch size 10, legacy did:sov prefix, return route) authcrypted to the mediator,
 * sent to the mediator connection's endpoint. Like OkHttp, each wallet keeps its own connection
 * (HTTP/2 over TLS) and, like the SDK's timer, a slow reply does not delay the next poll.
 * Phase 5 observed the SDK polling over https (4-init §2.7.2); `--transport wss` holds one
 * WebSocket per wallet instead, and `--transport http` uses HTTP/1.1 keep-alive (local-mediator.ts only).
 *
 *   node load/poll.ts --run r1 --steps 1000,2000,3000 --hold 600 [--workers 4] [--interval 10000]
 *        [--transport https|wss] [--label staging] [--stop-on-breach]
 *
 * The wallets stay connected across steps: step k activates wallets [0, steps[k]). Each wallet
 * starts at a random offset inside the interval. Messages injected by inject.ts are unpacked, and
 * their ids and delivery latency are recorded (received-<run>.w<k>.jsonl) for delivery-report.ts.
 * A JSON summary per step goes to LOAD_DIR/results/.
 *
 * Stop rule (plan A1): p95 above 2 s or more than 1 % errors in a minute. Two such minutes in a row end
 * the ramp when --stop-on-breach is set; otherwise they are flagged in the summary.
 */
import '../smoke/bindings.ts'

import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { connect, type ClientHttp2Session, constants as h2 } from 'node:http2'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import WebSocket from 'ws'

import { type Jwe, keyPairFromSecret, type KeyPair, pack, unpack } from './didcomm.ts'
import { argValue, type LoadWallet, loadDir, percentiles, readWallets } from './wallets.ts'

const MIME = 'application/didcomm-envelope-enc'
const POLL_TIMEOUT_MS = 30_000

interface WorkerStats {
  kind: 'stats'
  worker: number
  active: number
  connected: number
  polls: number
  latencies: number[]
  errors: Record<string, number>
  reconnects: number
  received: number
  deliveryLatencies: number[]
}

// ---------------------------------------------------------------------------------------------------
// Worker: drives the wallets whose index i satisfies i % workers === worker.
// ---------------------------------------------------------------------------------------------------

interface Pending {
  t0: number
  resolve: (jwe: Jwe | null) => void
}

class SimWallet {
  readonly w: LoadWallet
  readonly holder: KeyPair
  readonly recipient: KeyPair
  readonly endpoint: URL
  private session?: ClientHttp2Session
  private agent?: HttpAgent
  private socket?: WebSocket
  private readonly pending = new Map<string, Pending>()
  timer?: NodeJS.Timeout
  connected = false

  constructor(w: LoadWallet, transport: 'https' | 'wss' | 'http') {
    this.w = w
    this.holder = keyPairFromSecret(w.holder.secret)
    this.recipient = keyPairFromSecret(w.recipient.secret)
    const endpoint = w.mediatorEndpoints.find((e) => e.startsWith(`${transport}://`))
    if (!endpoint) throw new Error(`wallet ${w.n} has no ${transport} mediator endpoint`)
    this.endpoint = new URL(endpoint)
  }

  /** One batch-pickup; resolves with the reply (or null) and its latency, rejects on error/timeout. */
  async poll(): Promise<{ latency: number; reply: Jwe | null }> {
    const id = randomUUID()
    const message = {
      '@type': 'did:sov:BzCbsNYhMrjHiqZDTUASHg;spec/messagepickup/1.0/batch-pickup',
      '@id': id,
      batch_size: 10,
      '~transport': { return_route: 'all' },
    }
    const body = JSON.stringify(pack(message, [this.w.mediatorVerkey], this.holder))
    const t0 = performance.now()
    const reply = this.endpoint.protocol === 'https:' ? await this.postHttp2(body) : this.endpoint.protocol === 'http:' ? await this.postHttp1(body) : await this.sendWs(id, body)
    return { latency: performance.now() - t0, reply }
  }

  private http2(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session
    if (this.session) stats.reconnects += 1
    const session = connect(this.endpoint.origin)
    session.on('error', () => undefined)
    session.on('connect', () => (this.connected = true))
    session.on('close', () => (this.connected = false))
    this.session = session
    return session
  }

  private postHttp2(body: string): Promise<Jwe | null> {
    return new Promise((resolve, reject) => {
      const request = this.http2().request({ [h2.HTTP2_HEADER_METHOD]: 'POST', [h2.HTTP2_HEADER_PATH]: this.endpoint.pathname || '/', 'content-type': MIME })
      const timer = setTimeout(() => {
        request.close(h2.NGHTTP2_CANCEL)
        reject(new Error('timeout'))
      }, POLL_TIMEOUT_MS)
      let status = 0
      const chunks: Buffer[] = []
      request.on('response', (headers) => (status = Number(headers[h2.HTTP2_HEADER_STATUS])))
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`h2 ${(error as NodeJS.ErrnoException).code ?? error.message}`))
      })
      request.on('end', () => {
        clearTimeout(timer)
        if (status >= 400) return reject(new Error(`http ${status}`))
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? (JSON.parse(text) as Jwe) : null)
      })
      request.end(body)
    })
  }

  private postHttp1(body: string): Promise<Jwe | null> {
    this.agent ??= new HttpAgent({ keepAlive: true, maxSockets: 2 })
    return new Promise((resolve, reject) => {
      const request = httpRequest(this.endpoint, { method: 'POST', agent: this.agent, headers: { 'content-type': MIME }, timeout: POLL_TIMEOUT_MS }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          this.connected = true
          if ((response.statusCode ?? 0) >= 400) return reject(new Error(`http ${response.statusCode}`))
          const text = Buffer.concat(chunks).toString('utf8')
          resolve(text ? (JSON.parse(text) as Jwe) : null)
        })
      })
      request.on('timeout', () => request.destroy(new Error('timeout')))
      request.on('error', (error) => reject(new Error((error as NodeJS.ErrnoException).code ?? error.message)))
      request.end(body)
    })
  }

  private ws(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve(this.socket)
    if (this.socket) stats.reconnects += 1
    const socket = new WebSocket(this.endpoint)
    this.socket = socket
    socket.on('message', (data) => this.onWsMessage(data.toString()))
    socket.on('close', () => {
      this.connected = false
      for (const [id, p] of this.pending) {
        this.pending.delete(id)
        p.resolve(null)
      }
    })
    socket.on('error', () => undefined)
    return new Promise((resolve, reject) => {
      socket.once('open', () => {
        this.connected = true
        resolve(socket)
      })
      socket.once('error', (error) => reject(new Error(`ws ${error.message}`)))
    })
  }

  private onWsMessage(text: string) {
    let jwe: Jwe
    let thid: string | undefined
    try {
      jwe = JSON.parse(text) as Jwe
      const { message } = unpack(jwe, this.holder)
      thid = (message['~thread'] as { thid?: string } | undefined)?.thid
      handleReply(this, message)
    } catch {
      stats.errors.unreadable = (stats.errors.unreadable ?? 0) + 1
      return
    }
    // The batch reply carries the request's id as its thread id; the reply itself was handled above.
    const pending = thid ? this.pending.get(thid) : undefined
    if (thid && pending) {
      this.pending.delete(thid)
      pending.resolve(null)
    }
  }

  private async sendWs(id: string, body: string): Promise<Jwe | null> {
    const socket = await this.ws()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('timeout'))
      }, POLL_TIMEOUT_MS)
      this.pending.set(id, { t0: performance.now(), resolve: (value) => (clearTimeout(timer), resolve(value)) })
      socket.send(body)
    })
  }

  close() {
    clearInterval(this.timer)
    this.session?.close()
    this.agent?.destroy()
    this.socket?.close()
  }
}

const stats = { polls: 0, latencies: [] as number[], errors: {} as Record<string, number>, reconnects: 0, received: 0, deliveryLatencies: [] as number[] }
let receivedFile = ''

/** A `batch` reply: unpack each attached message (injected pings are anoncrypted to the recipient key). */
function handleReply(wallet: SimWallet, message: Record<string, unknown>) {
  if (!String(message['@type']).endsWith('messagepickup/1.0/batch')) return
  const attachments = (message['messages~attach'] as Array<{ '@id': string; message: Jwe }> | undefined) ?? []
  const lines: string[] = []
  for (const attachment of attachments) {
    let inner: Record<string, unknown>
    try {
      inner = unpack(attachment.message, wallet.recipient).message
    } catch {
      try {
        inner = unpack(attachment.message, wallet.holder).message
      } catch {
        stats.errors.undecryptable = (stats.errors.undecryptable ?? 0) + 1
        continue
      }
    }
    stats.received += 1
    const outTime = (inner['~timing'] as { out_time?: string } | undefined)?.out_time
    const delivery = outTime ? Date.now() - Date.parse(outTime) : undefined
    if (delivery !== undefined) stats.deliveryLatencies.push(delivery)
    lines.push(JSON.stringify({ id: inner['@id'], n: wallet.w.n, at: new Date().toISOString(), deliveryMs: delivery }))
  }
  if (lines.length > 0) appendFileSync(receivedFile, `${lines.join('\n')}\n`)
}

async function runWorker() {
  const run = argValue('run')
  const worker = Number(argValue('worker'))
  const workers = Number(argValue('workers'))
  const max = Number(argValue('max'))
  const interval = Number(argValue('interval'))
  const transport = argValue('transport') as 'https' | 'wss' | 'http'
  receivedFile = join(loadDir(), `received-${run}.w${worker}.jsonl`)
  const mine = readWallets(run, max).filter((_, i) => i % workers === worker).map((w) => new SimWallet(w, transport))
  let active = 0

  const tick = (wallet: SimWallet) => {
    stats.polls += 1
    wallet
      .poll()
      .then(({ latency, reply }) => {
        stats.latencies.push(latency)
        if (reply) {
          try {
            handleReply(wallet, unpack(reply, wallet.holder).message)
          } catch {
            stats.errors.unreadable = (stats.errors.unreadable ?? 0) + 1
          }
        }
      })
      .catch((error: Error) => {
        const key = error.message.slice(0, 60)
        stats.errors[key] = (stats.errors[key] ?? 0) + 1
      })
  }

  const activate = (upTo: number) => {
    // Global index i of mine[k] is k * workers + worker.
    while (active < mine.length && active * workers + worker < upTo) {
      const wallet = mine[active]
      setTimeout(() => {
        tick(wallet)
        wallet.timer = setInterval(() => tick(wallet), interval)
      }, Math.random() * interval)
      active += 1
    }
  }

  process.on('message', (msg: { kind: string; upTo?: number }) => {
    if (msg.kind === 'activate' && msg.upTo !== undefined) activate(msg.upTo)
    if (msg.kind === 'stop') {
      for (const w of mine) w.close()
      setTimeout(() => process.exit(0), 500)
    }
  })

  setInterval(() => {
    const report: WorkerStats = {
      kind: 'stats',
      worker,
      active,
      connected: mine.filter((w) => w.connected).length,
      polls: stats.polls,
      latencies: stats.latencies,
      errors: stats.errors,
      reconnects: stats.reconnects,
      received: stats.received,
      deliveryLatencies: stats.deliveryLatencies,
    }
    process.send?.(report)
    stats.polls = 0
    stats.latencies = []
    stats.errors = {}
    stats.reconnects = 0
    stats.received = 0
    stats.deliveryLatencies = []
  }, 5_000)
  process.send?.({ kind: 'ready', worker, wallets: mine.length })
}

// ---------------------------------------------------------------------------------------------------
// Master: forks the workers, ramps the steps, aggregates per minute, writes one summary per step.
// ---------------------------------------------------------------------------------------------------

interface Window {
  polls: number
  latencies: number[]
  errors: Record<string, number>
  reconnects: number
  received: number
  deliveryLatencies: number[]
}
const emptyWindow = (): Window => ({ polls: 0, latencies: [], errors: {}, reconnects: 0, received: 0, deliveryLatencies: [] })
const errorCount = (w: Window) => Object.values(w.errors).reduce((a, b) => a + b, 0)

async function runMaster() {
  const run = argValue('run')
  const steps = argValue('steps').split(',').map(Number)
  const hold = Number(argValue('hold', '600')) * 1000
  const workers = Number(argValue('workers', '4'))
  const interval = Number(argValue('interval', '10000'))
  const transport = argValue('transport', 'https')
  const label = argValue('label', 'staging')
  const stopOnBreach = process.argv.includes('--stop-on-breach')
  const max = Math.max(...steps)
  const available = readWallets(run).length
  if (available < max) throw new Error(`run ${run} has ${available} wallets, the ramp needs ${max}`)
  const resultsDir = join(loadDir(), 'results')
  mkdirSync(resultsDir, { recursive: true })

  const self = fileURLToPath(import.meta.url)
  const children: ChildProcess[] = []
  const latest = new Map<number, WorkerStats>()
  let minute = emptyWindow()
  let step = emptyWindow()
  const ready = new Promise<void>((resolve) => {
    let count = 0
    for (let k = 0; k < workers; k += 1) {
      const child = fork(self, ['--worker', String(k), '--workers', String(workers), '--run', run, '--max', String(max), '--interval', String(interval), '--transport', transport])
      child.on('message', (msg: WorkerStats | { kind: 'ready' }) => {
        if (msg.kind === 'ready' && ++count === workers) resolve()
        if (msg.kind !== 'stats') return
        const s = msg as WorkerStats
        latest.set(s.worker, s)
        for (const w of [minute, step]) {
          w.polls += s.polls
          w.latencies.push(...s.latencies)
          for (const [k2, v] of Object.entries(s.errors)) w.errors[k2] = (w.errors[k2] ?? 0) + v
          w.reconnects += s.reconnects
          w.received += s.received
          w.deliveryLatencies.push(...s.deliveryLatencies)
        }
      })
      children.push(child)
    }
  })
  await ready
  console.log(`${workers} workers ready, ${max} wallets loaded (run ${run}, ${transport}, every ${interval} ms)`)

  let consecutiveBreaches = 0
  let stopped = false
  for (const target of steps) {
    if (stopped) break
    for (const child of children) child.send({ kind: 'activate', upTo: target })
    step = emptyWindow()
    const startedAt = new Date()
    const minutes: Array<Record<string, unknown>> = []
    const endAt = Date.now() + hold
    console.log(`\n[${startedAt.toISOString()}] step ${target} wallets for ${hold / 1000} s`)
    while (Date.now() < endAt) {
      minute = emptyWindow()
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, endAt - Date.now())))
      const p = percentiles(minute.latencies)
      const errors = errorCount(minute)
      const errorRate = minute.polls > 0 ? errors / minute.polls : 0
      const connected = [...latest.values()].reduce((a, s) => a + s.connected, 0)
      const breach = p.p95 > 2_000 || errorRate > 0.01
      consecutiveBreaches = breach ? consecutiveBreaches + 1 : 0
      const row = { at: new Date().toISOString(), polls: minute.polls, pollsPerSec: +(minute.polls / 60).toFixed(1), ...p, errors, errorRate: +errorRate.toFixed(4), errorKinds: minute.errors, reconnects: minute.reconnects, connected, received: minute.received, delivery: percentiles(minute.deliveryLatencies), breach }
      minutes.push(row)
      console.log(`  ${row.at}  ${row.pollsPerSec}/s  p50 ${p.p50.toFixed(0)}  p95 ${p.p95.toFixed(0)}  p99 ${p.p99.toFixed(0)} ms  errors ${errors} (${(errorRate * 100).toFixed(2)} %)  connected ${connected}  received ${minute.received}${breach ? '  << BREACH' : ''}`)
      if (Object.keys(minute.errors).length > 0) console.log(`    errors: ${JSON.stringify(minute.errors)}`)
      if (stopOnBreach && consecutiveBreaches >= 2) {
        console.log('  two breaching minutes in a row: stopping the ramp')
        stopped = true
        break
      }
    }
    const summary = {
      run, label, transport, interval, wallets: target, startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(),
      polls: step.polls, latency: percentiles(step.latencies), errors: errorCount(step), errorKinds: step.errors,
      reconnects: step.reconnects, received: step.received, delivery: percentiles(step.deliveryLatencies),
      stoppedOnBreach: stopped, minutes,
    }
    const file = join(resultsDir, `${run}-${label}-${target}-${startedAt.toISOString().replace(/[:.]/g, '')}.json`)
    writeFileSync(file, JSON.stringify(summary, null, 2))
    console.log(`  step summary: p50 ${summary.latency.p50.toFixed(0)} p95 ${summary.latency.p95.toFixed(0)} p99 ${summary.latency.p99.toFixed(0)} ms, ${summary.errors} errors of ${summary.polls} → ${file}`)
  }
  for (const child of children) child.send({ kind: 'stop' })
  setTimeout(() => process.exit(0), 2_000)
}

if (process.argv.includes('--worker')) await runWorker()
else await runMaster()
