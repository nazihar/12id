/**
 * The simulated wallets, one JSON line each, written by onboard.ts and read by poll.ts / inject.ts.
 * The keys are synthetic (a throwaway load-test tenant); the directory lives outside the repo
 * (LOAD_DIR, default E:/12id-load) and is deleted after the run.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LoadWallet {
  /** Sequence number within the run, also the idempotency key's suffix. */
  n: number
  walletId: string
  /** The mediator's endpoints as advertised (wss first). */
  mediatorEndpoints: string[]
  /** The mediator's key on this wallet's mediation connection (batch-pickup is authcrypted to it). */
  mediatorVerkey: string
  /** The holder's key on that connection: verkey + base58 secret. */
  holder: { verkey: string; secret: string }
  /** A recipient key registered in the mediator's keylist (what an issuer would address). */
  recipient: { verkey: string; secret: string }
  /** The mediator's routing keys for `recipient`, innermost first. */
  routingKeys: string[]
  createdAt: string
}

export const loadDir = () => process.env.LOAD_DIR ?? 'E:/12id-load'

/** One file per onboarding process (`part`), so parallel onboarders never share a file. */
export function walletsFile(run: string, part: string) {
  const dir = loadDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `wallets-${run}.${part}.jsonl`)
}

/** Every wallet of a run, ordered by `n`, de-duplicated (a resumed onboarding never repeats an `n`). */
export function readWallets(run: string, limit = Number.POSITIVE_INFINITY): LoadWallet[] {
  const dir = loadDir()
  if (!existsSync(dir)) return []
  const byN = new Map<number, LoadWallet>()
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`wallets-${run}.`) || !name.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const wallet = JSON.parse(line) as LoadWallet
      byN.set(wallet.n, wallet)
    }
  }
  return [...byN.values()].sort((a, b) => a.n - b.n).slice(0, limit)
}

export function appendWallet(file: string, wallet: LoadWallet) {
  appendFileSync(file, `${JSON.stringify(wallet)}\n`)
}

/** p50/p95/p99/max of a list of millisecond samples. */
export function percentiles(samples: number[]) {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] }
}

export const argValue = (name: string, fallback?: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : fallback
  if (value === undefined) throw new Error(`missing --${name}`)
  return value
}
