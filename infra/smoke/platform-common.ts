/**
 * Shared plumbing for the Phase 3 smokes: a platform API client (API key), a webhook receiver
 * that verifies signatures, and the catalogue/wallet setup both scenarios need.
 *
 * The receiver is reached from the VM through the same reverse tunnel Phase 2 used for the
 * smoke issuer: `ssh -R 3200:127.0.0.1:3201` puts this process behind
 * https://smoke-issuer.<domain>/, so the webhook URL is https://smoke-issuer.<domain>/webhook
 * and the Android app still fetches its issuer invitation from /phase0/invitation.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'

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
        const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]))
        const expected = createHmac('sha256', options.secret()).update(`${parts.t}.${body}`).digest('hex')
        const signatureValid = typeof parts.v1 === 'string' && parts.v1.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected))
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

/** Publishes a fresh schema version + cred def for this run (about 4 s on staging). */
export async function publishCatalogue(api: PlatformClient, name: string): Promise<Catalogue> {
  const version = `1.${Math.floor(Date.now() / 1000) % 1_000_000}`
  const schema = await api.must<{ id: string; schemaId: string }>('POST', '/v1/schemas', { name, version, attributes: ['name', 'employeeNumber', 'department', 'expiresAt'] })
  console.log(`  [${now()}] schema ${schema.schemaId}`)
  const credDef = await api.must<{ id: string; credentialDefinitionId: string }>('POST', '/v1/credential-definitions', { schemaId: schema.id })
  console.log(`  [${now()}] cred def ${credDef.credentialDefinitionId}`)
  return { schemaId: schema.id, credentialDefinitionId: credDef.id, credentialDefinitionLedgerId: credDef.credentialDefinitionId }
}

export const offerAttributes = (label: string) => ({
  name: `Ada Lovelace (${label})`,
  employeeNumber: '1815',
  department: 'Analytical Engines',
  expiresAt: String(Math.floor(Date.now() / 1000) + 30 * 86_400),
})
