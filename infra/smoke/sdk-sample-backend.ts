/**
 * Customer-backend stand-in for the 12id sample app (Phase 5 plan P), standalone. Serves
 * POST /sdk/wallet {installationId} → {walletToken} behind the smoke-issuer tunnel
 * (`ssh -R 3200:127.0.0.1:3201`), calling POST /v1/wallets with the installation id as
 * Idempotency-Key. Also collects signed webhooks on /webhook and prints them. Ctrl-C to stop.
 *
 * Env: PLATFORM_API, PLATFORM_API_KEY, WEBHOOK_URL (optional: registers it as the console over SSH,
 * which needs PLATFORM_TENANT_ID; review K1), RECEIVER_PORT.
 */
import { consoleClient, env, now, platformClient, startReceiver } from './platform-common.ts'

const api = platformClient(env('PLATFORM_API', 'https://api.12id.naziharitsolution.com'), env('PLATFORM_API_KEY'))
let secret = ''
const receiver = startReceiver(Number(env('RECEIVER_PORT', '3201')), { secret: () => secret, walletBackend: { api, wallets: new Map(), requests: { count: 0 } } })
await receiver.listening
if (process.env.WEBHOOK_URL) {
  const setup = consoleClient()
  const endpoint = await setup.must<{ secret?: string }>('PUT', '/v1/webhook', { url: process.env.WEBHOOK_URL })
  secret = endpoint.secret ?? (await setup.must<{ secret: string }>('POST', '/v1/webhook/rotate-secret')).secret
}
console.log(`[${now()}] sample backend listening on ${env('RECEIVER_PORT', '3201')} (POST /sdk/wallet, POST /webhook)`)
