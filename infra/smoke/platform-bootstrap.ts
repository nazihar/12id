/**
 * Operator step for the Phase 3 smokes: create a tenant and an API key through the platform's
 * admin routes (SSH tunnel `-L 13500:127.0.0.1:3500`). Prints the API key once.
 *
 *   PLATFORM_ADMIN_TOKEN=… node smoke/platform-bootstrap.ts <tenant name>
 * Env: ADMIN_API (default http://127.0.0.1:13500), PLATFORM_ADMIN_TOKEN.
 */
import { env } from './platform-common.ts'

const adminApi = env('ADMIN_API', 'http://127.0.0.1:13500')
const headers = { 'x-admin-token': env('PLATFORM_ADMIN_TOKEN'), 'content-type': 'application/json' }
const name = process.argv[2] ?? `smoke-${Date.now()}`

const tenant = await fetch(`${adminApi}/admin/tenants`, { method: 'POST', headers, body: JSON.stringify({ name }) })
const tenantJson = (await tenant.json()) as { id: string; status: string; did: string | null; lastError: string | null }
if (!tenant.ok) throw new Error(`POST /admin/tenants -> ${tenant.status} ${JSON.stringify(tenantJson)}`)
console.log('tenant', tenantJson)
if (tenantJson.status !== 'ready') throw new Error(`tenant not ready: ${tenantJson.lastError}`)

const key = await fetch(`${adminApi}/admin/tenants/${tenantJson.id}/api-keys`, { method: 'POST', headers, body: JSON.stringify({ label: 'smoke' }) })
const keyJson = (await key.json()) as { apiKey: string }
if (!key.ok) throw new Error(`api key -> ${key.status} ${JSON.stringify(keyJson)}`)
console.log(`PLATFORM_API_KEY=${keyJson.apiKey}`)
