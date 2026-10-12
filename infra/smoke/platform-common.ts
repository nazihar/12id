/**
 * Shared plumbing for the Phase 3 smokes: a platform API client (API key), a console client for
 * the setup routes (review K1), a webhook receiver that verifies signatures, and the
 * catalogue/wallet setup both scenarios need.
 *
 * The receiver is reached from the VM through the same reverse tunnel Phase 2 used for the
 * smoke issuer: `ssh -R 3200:127.0.0.1:3201` puts this process behind
 * https://smoke-issuer.<domain>/, so the webhook URL is https://smoke-issuer.<domain>/webhook
 * and the Android app still fetches its issuer invitation from /phase0/invitation.
 */
import { spawn } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'

export const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`missing ${name}`)
  return value
}
export const now = () => new Date().toISOString()
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface PlatformClient {
  call<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: T }>
  must<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>
}

export function platformClient(baseUrl: string, bearer: string): PlatformClient {
  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const json = (await response.json().catch(() => ({}))) as T
    return { status: response.status, json }
  }
  return {
    call,
    async must<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
      const { status, json } = await call<T>(method, path, body, headers)
      if (status >= 400) throw new Error(`${method} ${path} -> ${status} ${JSON.stringify(json)}`)
      return json
    },
  }
}

/**
 * Setup routes are console only (review K1): catalogue publishing, proof templates, biometric
 * policies and the webhook endpoint. The smokes call them the way `biometric-setup.sh` does. They
 * run inside the platform container, where CONSOLE_TOKEN already lives (a secret file since Phase 9), reached over SSH, so the
 * token never leaves the VM. The request travels base64-encoded in an env var and the script on
 * stdin, so nothing needs shell quoting.
 *
 * `role` is the console role the call is made with (`owner` unless a check is about another role,
 * such as the read-only `auditor`).
 *
 * Env: PLATFORM_TENANT_ID (printed by platform-bootstrap.ts), VM_SSH (default
 * ubuntu@123.176.58.72), VM_SSH_KEY (default ~/.ssh/12id_staging_ed25519), PLATFORM_CONTAINER.
 */
export function consoleClient(tenantId = env('PLATFORM_TENANT_ID'), role = 'owner'): PlatformClient {
  const target = env('VM_SSH', 'ubuntu@123.176.58.72')
  const key = env('VM_SSH_KEY', `${homedir()}/.ssh/12id_staging_ed25519`)
  const container = env('PLATFORM_CONTAINER', 'platform-platform-api-1')
  const script = `
const { method, path, body, tenant, role, extra } = JSON.parse(Buffer.from(process.env.REQ, 'base64').toString())
// Phase 9 M11: the token is a mounted secret file (CONSOLE_TOKEN_FILE), no longer an env value.
const token = process.env.CONSOLE_TOKEN_FILE ? (await import('node:fs')).readFileSync(process.env.CONSOLE_TOKEN_FILE, 'utf8').trim() : process.env.CONSOLE_TOKEN
const headers = { 'x-console-token': token, 'x-console-actor': 'smoke', 'x-console-role': role, 'x-console-tenant': tenant, ...extra }
if (body !== undefined) headers['content-type'] = 'application/json'
const res = await fetch('http://127.0.0.1:3500' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
const json = await res.json().catch(() => ({}))
process.stdout.write(JSON.stringify({ status: res.status, json }))
`
  async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const req = Buffer.from(JSON.stringify({ method, path, body, tenant: tenantId, role, extra })).toString('base64')
    const child = spawn('ssh', ['-i', key, '-o', 'BatchMode=yes', target, 'docker', 'exec', '-i', '-e', `REQ=${req}`, container, 'node', '--input-type=module', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.stdin.end(script)
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    if (code !== 0) throw new Error(`console call ${method} ${path} over ssh exited ${code}: ${stderr.trim()}`)
    return JSON.parse(stdout) as { status: number; json: T }
  }
  return {
    call,
    async must<T>(method: string, path: string, body?: unknown) {
      const { status, json } = await call<T>(method, path, body)
      if (status >= 400) throw new Error(`console ${method} ${path} -> ${status} ${JSON.stringify(json)}`)
      return json
    },
  }
}

export interface ReceivedEvent {
  receivedAt: string
  type: string
  signatureValid: boolean
  event: { id: string; type: string; createdAt: string; tenantId: string; data: Record<string, unknown> }
}

export interface ReceiverOptions {
  secret: () => string
  invitationUrl?: () => string | undefined
  /**
   * Customer-backend stand-in for the SDK sample (Phase 5): POST /sdk/wallet {installationId} answers
   * {walletToken}. Given the platform client (API key), it calls POST /v1/wallets with the installation
   * id as Idempotency-Key, so a retry rotates the token for the same wallet. Wallets created are recorded.
   */
  walletBackend?: { api: PlatformClient; wallets: Map<string, string>; requests: { count: number } }
}

/** One local HTTP server: POST /webhook collects signed events; GET /phase0/invitation serves the app once. */
export function startReceiver(port: number, options: ReceiverOptions) {
  const events: ReceivedEvent[] = []
  let invitationServed = false
  const server: Server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/sdk/wallet' && options.walletBackend) {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const { installationId } = JSON.parse(body) as { installationId: string }
        const { api, wallets, requests } = options.walletBackend!
        requests.count += 1
        api
          .call<{ id: string; walletToken: string }>('POST', '/v1/wallets', { externalId: `sdk-sample-${installationId}` }, { 'idempotency-key': installationId })
          .then(({ status, json }) => {
            if (status >= 400) throw new Error(`POST /v1/wallets -> ${status} ${JSON.stringify(json)}`)
            wallets.set(installationId, json.id)
            console.log(`  [${now()}] backend: wallet ${json.id.slice(0, 8)} token issued for installation ${installationId.slice(0, 8)}`)
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ walletToken: json.walletToken }))
          })
          .catch((error) => {
            console.log(`  [${now()}] backend: wallet creation failed: ${error}`)
            response.writeHead(502).end('wallet creation failed')
          })
      })
      return
    }
    if (request.method === 'POST' && request.url === '/webhook') {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        const header = String(request.headers['x-12id-signature'] ?? '')
        // Several v1 values during a secret rotation (review M9): any match is valid.
        const parts = header.split(',').map((p) => p.split('=') as [string, string])
        const t = parts.find(([key]) => key === 't')?.[1]
        const expected = createHmac('sha256', options.secret()).update(`${t}.${body}`).digest('hex')
        const signatureValid = parts.some(([key, value]) => key === 'v1' && typeof value === 'string' && value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected)))
        const event = JSON.parse(body) as ReceivedEvent['event']
        events.push({ receivedAt: now(), type: event.type, signatureValid, event })
        const summary = event.type === 'wallet.sync_requested' ? `wallet ${String(event.data.walletId).slice(0, 8)}` : `${String(event.data.id).slice(0, 8)} ${event.data.previousState ?? '·'} -> ${event.data.state}`
        console.log(`  [${now()}] webhook ${event.type} ${summary}${signatureValid ? '' : '  !! BAD SIGNATURE'}`)
        response.writeHead(200).end('ok')
      })
      return
    }
    if (request.method === 'GET' && request.url === '/phase0/invitation' && options.invitationUrl && !invitationServed) {
      const url = options.invitationUrl()
      if (url) {
        invitationServed = true
        console.log(`  [${now()}] app fetched the issuer invitation`)
        response.writeHead(200, { 'content-type': 'text/plain' }).end(url)
        return
      }
    }
    response.writeHead(404).end('no')
  })
  const listening = new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))

  async function waitFor(label: string, predicate: (e: ReceivedEvent) => boolean, timeoutMs: number): Promise<ReceivedEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = events.find(predicate)
      if (hit) return hit
      await sleep(500)
    }
    throw new Error(`timed out waiting for webhook: ${label}`)
  }

  return { events, listening, waitFor, close: () => server.close() }
}

export interface Catalogue {
  schemaId: string
  credentialDefinitionId: string
  credentialDefinitionLedgerId: string
}

/** Publishes a fresh schema version + cred def for this run (about 4 s on staging). Console only (K1). */
export async function publishCatalogue(api: PlatformClient, name: string): Promise<Catalogue> {
  const version = `1.${Math.floor(Date.now() / 1000) % 1_000_000}`
  const schema = await api.must<{ id: string; schemaId: string }>('POST', '/v1/schemas', { name, version, attributes: ['name', 'employeeNumber', 'department', 'expiresOn'] })
  console.log(`  [${now()}] schema ${schema.schemaId}`)
  const credDef = await api.must<{ id: string; credentialDefinitionId: string }>('POST', '/v1/credential-definitions', { schemaId: schema.id })
  console.log(`  [${now()}] cred def ${credDef.credentialDefinitionId}`)
  return { schemaId: schema.id, credentialDefinitionId: credDef.id, credentialDefinitionLedgerId: credDef.credentialDefinitionId }
}

/** The mandatory expiry date (YYYYMMDD, UTC) [days] from today. */
export const expiryDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '')

export const offerAttributes = (label: string) => ({
  name: `Ada Lovelace (${label})`,
  employeeNumber: '1815',
  department: 'Analytical Engines',
  expiresOn: expiryDate(30),
})
