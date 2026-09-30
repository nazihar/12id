/**
 * Ledger write probe for our own Indy network (Phase 9 W2; staging's von-network keeps
 * infra/scripts/ledger-write-probe.sh). Proves the pool reaches consensus, which reachability probes
 * cannot: in Phase 1 all four client ports answered while every write failed with "Pool timeout".
 *
 * The probe's DID is role-less (registered by bootstrap-endorser in trustee mode), so its key, the
 * only one online for this, can do nothing but write attributes about itself. Each run writes one
 * ATTRIB `{"12id-probe": <unix time>}` to its own DID and reads it back. Every run adds one permanent
 * transaction, so the timer runs it every 15 minutes, not on each scrape.
 *
 * Output: Prometheus textfile metrics in /metrics (node-exporter's textfile collector), the same
 * series the von-network probe writes, so the alerts carry over.
 */
import { createHash } from 'node:crypto'
import { chmodSync, renameSync, writeFileSync } from 'node:fs'

import { indyVdr } from './bindings.ts'

import { AttribRequest, GetAttribRequest, PoolCreate } from '@hyperledger/indy-vdr-nodejs'

import { env, signerFromSeed } from './indy-keys.ts'

void indyVdr
const OUT_DIR = process.env.OUT_DIR ?? '/metrics'
const READBACK_TIMEOUT_MS = Number(process.env.READBACK_TIMEOUT_S ?? '60') * 1000

async function fetchGenesis(): Promise<string> {
  const response = await fetch(env('GENESIS_URL'))
  if (!response.ok) throw new Error(`genesis fetch failed: ${response.status}`)
  const genesis = await response.text()
  const actual = createHash('sha256').update(genesis).digest('hex')
  if (actual !== env('GENESIS_SHA256')) throw new Error(`genesis sha256 mismatch: got ${actual}`)
  return genesis
}

function writeMetrics(success: boolean, seconds: number) {
  const body = [
    '# HELP ledger_write_probe_success 1 if a write reached consensus and was read back.',
    '# TYPE ledger_write_probe_success gauge',
    `ledger_write_probe_success ${success ? 1 : 0}`,
    '# HELP ledger_write_probe_duration_seconds Seconds from submitting the write to reading it back, or to giving up.',
    '# TYPE ledger_write_probe_duration_seconds gauge',
    `ledger_write_probe_duration_seconds ${seconds.toFixed(3)}`,
    '# HELP ledger_write_probe_last_run_timestamp_seconds Unix time of the last probe run.',
    '# TYPE ledger_write_probe_last_run_timestamp_seconds gauge',
    `ledger_write_probe_last_run_timestamp_seconds ${Math.floor(Date.now() / 1000)}`,
    '',
  ].join('\n')
  // Atomic: the collector only reads *.prom, so the temporary name is ignored.
  const tmp = `${OUT_DIR}/ledger_write_probe.prom.${process.pid}`
  writeFileSync(tmp, body)
  chmodSync(tmp, 0o644)
  renameSync(tmp, `${OUT_DIR}/ledger_write_probe.prom`)
}

const started = Date.now()
let success = false
let detail = ''
try {
  const probe = signerFromSeed(env('LEDGER_PROBE_SEED'))
  const pool = new PoolCreate({ parameters: { transactions: await fetchGenesis() } })
  const stamp = String(Math.floor(Date.now() / 1000))
  const raw = JSON.stringify({ '12id-probe': stamp })

  const write = new AttribRequest({ submitterDid: probe.nym, targetDid: probe.nym, raw })
  write.setSignature({ signature: probe.sign(Buffer.from(write.signatureInput, 'utf8')) })
  const written = (await pool.submitRequest(write)) as { op?: string; reason?: string }
  if (written.op !== 'REPLY') throw new Error(`write refused: ${written.op} ${written.reason ?? ''}`)

  // A REPLY already means consensus; reading it back through any node proves it is on the ledger.
  const deadline = Date.now() + READBACK_TIMEOUT_MS
  while (!success && Date.now() < deadline) {
    const read = await pool.submitRequest(new GetAttribRequest({ targetDid: probe.nym, raw: '12id-probe' }))
    const data = (read as { result?: { data?: string | null } }).result?.data
    success = typeof data === 'string' && JSON.parse(data)['12id-probe'] === stamp
    if (!success) await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  detail = success ? `${probe.nym} attribute ${stamp}` : 'written but not read back in time'
  pool.close()
} catch (error) {
  detail = error instanceof Error ? error.message : String(error)
}

const seconds = (Date.now() - started) / 1000
writeMetrics(success, seconds)
if (success) {
  console.log(`ledger write probe OK: ${detail} in ${seconds.toFixed(1)}s`)
} else {
  console.error(`ledger write probe FAILED after ${seconds.toFixed(1)}s: ${detail.slice(0, 200)}`)
}
process.exit(success ? 0 : 1)
