/**
 * W4 load test, cleanup step 1: revoke every wallet of a run through the public API (what a customer
 * backend does). Step 2 is cleanup.sql on the VM: it moves the revocation back past the 30-day grace,
 * so platform-api's hourly sweep (sweep.ts) removes the mediations through the mediator's
 * `DELETE /admin/connections/:id`, the same path a real revoked wallet takes.
 *
 *   PLATFORM_API_KEY=… node load/cleanup.ts --run r1 [--concurrency 20]
 */
import { env, platformClient } from '../smoke/platform-common.ts'
import { argValue, readWallets } from './wallets.ts'

const run = argValue('run')
const concurrency = Number(argValue('concurrency', '20'))
const api = platformClient(env('PLATFORM_API', 'https://api.12id.naziharitsolution.com'), env('PLATFORM_API_KEY'))
const queue = readWallets(run).filter((w) => !w.walletId.startsWith('local-'))
console.log(`run ${run}: revoking ${queue.length} wallets`)

const outcome: Record<string, number> = {}
async function worker() {
  for (let w = queue.shift(); w; w = queue.shift()) {
    let status = 0
    // The edge's per-IP limit (api_per_ip) answers 429 with Retry-After: 60; wait it out and retry.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      status = (await api.call('DELETE', `/v1/wallets/${w.walletId}`).catch(() => ({ status: 0 }))).status
      if (status !== 429) break
      await new Promise((resolve) => setTimeout(resolve, 61_000))
    }
    // 404: already revoked by an earlier run of this script.
    outcome[status] = (outcome[status] ?? 0) + 1
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
console.log(`done: ${JSON.stringify(outcome)} (200 revoked, 404 already revoked)`)
