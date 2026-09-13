/**
 * Spike T3 child process: a tenant issuer on a persistent Postgres store, driven by the T3
 * orchestrators over a local control API. Not a DIDComm client of its own.
 *
 * Env:
 *   T3_STATE_FILE      JSON with store id/key and the onboarded tenant (created on first start)
 *   T3_PORT            DIDComm inbound port (default 3600), advertised as http://127.0.0.1:<port>
 *   T3_CONTROL_PORT    control API port (default 3601)
 *   SHUTDOWN_MODE      naive | drain  (SIGTERM behaviour; only meaningful on Linux)
 *   POSTGRES_HOST      as for the other spikes
 *
 * Prints `READY` when initialised and `MARKER inbound` on the first inbound envelope after
 * POST /arm, so an orchestrator can signal while a message is being processed.
 */
import './bindings.ts'

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { DidCommEventTypes, DidCommModuleConfig } from '@credo-ts/didcomm'

import { createEndorserAgent, createRootAgent, createSpikeEndorserDid, env, type RootAgent } from './common.ts'
import { type OnboardedTenant, onboardTenant } from './ledger.ts'

interface T3State {
  storeId: string
  storeKey: string
  tenant: OnboardedTenant
}

const stateFile = env('T3_STATE_FILE')
const port = Number(env('T3_PORT', '3600'))
const controlPort = Number(env('T3_CONTROL_PORT', '3601'))
const endpoint = `http://127.0.0.1:${port}`
const shutdownMode = env('SHUTDOWN_MODE', 'naive')

let state: T3State
let root: RootAgent

if (existsSync(stateFile)) {
  state = JSON.parse(readFileSync(stateFile, 'utf8')) as T3State
  root = await createRootAgent({ storeId: state.storeId, storeKey: state.storeKey, endpoint, port })
  console.log(`reopened store ${state.storeId}, tenant ${state.tenant.tenantId}`)
} else {
  const storeId = `spike_p2t3${Date.now()}`
  const storeKey = randomBytes(32).toString('base64url')
  root = await createRootAgent({ storeId, storeKey, endpoint, port })
  const endorser = await createEndorserAgent()
  const endorserIdentity = await createSpikeEndorserDid(endorser, `${storeId}-endorser`)
  const tenant = await onboardTenant(root, endorser, endorserIdentity.did, {
    label: `${storeId}-tenant`,
    schemaName: `${storeId}-badge`,
    attributes: ['name', 'employeeNumber', 'expiresAt'],
  })
  await endorser.shutdown()
  state = { storeId, storeKey, tenant }
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  console.log(`created store ${storeId}, tenant ${tenant.tenantId}`)
}

// --- in-flight tracking --------------------------------------------------------------
// DidCommMessageReceived fires when an envelope enters the receive pipeline; Processed when
// it has been handled. A message that throws never gets Processed, so the drain has a deadline.
let inFlight = 0
let armed = false
root.events.observable<any>(DidCommEventTypes.DidCommMessageReceived).subscribe(() => {
  inFlight++
  if (armed) {
    armed = false
    console.log(`MARKER inbound inFlight=${inFlight}`)
  }
})
root.events.observable<any>(DidCommEventTypes.DidCommMessageProcessed).subscribe(() => {
  inFlight = Math.max(0, inFlight - 1)
})

const withTenant = <T>(fn: (tenant: RootAgent) => Promise<T>) =>
  root.modules.tenants.withTenantAgent({ tenantId: state.tenant.tenantId }, (t) => fn(t as unknown as RootAgent))

// --- control API -----------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const body = await new Promise<string>((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
  const input = body ? (JSON.parse(body) as Record<string, string>) : {}
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  try {
    if (req.method === 'POST' && req.url === '/invitation') {
      const invitation = await withTenant(async (t) => {
        const oob = await t.modules.didcomm.oob.createInvitation({ label: state.tenant.label })
        return { oobId: oob.id, url: oob.outOfBandInvitation.toUrl({ domain: endpoint }) }
      })
      return reply(200, invitation)
    }
    if (req.method === 'POST' && req.url === '/offer') {
      const result = await withTenant(async (t) => {
        const [connection] = await t.modules.didcomm.connections.findAllByOutOfBandId(input.oobId)
        if (!connection) throw new Error(`no connection for oob ${input.oobId}`)
        await t.modules.didcomm.connections.returnWhenIsConnected(connection.id, { timeoutMs: 60_000 })
        const record = await t.modules.didcomm.credentials.offerCredential({
          connectionId: connection.id,
          protocolVersion: 'v1' as never,
          credentialFormats: {
            indy: {
              credentialDefinitionId: state.tenant.unqualifiedCredentialDefinitionId,
              attributes: [
                { name: 'name', value: 'T3 holder' },
                { name: 'employeeNumber', value: String(Date.now()) },
                { name: 'expiresAt', value: String(Math.floor(Date.now() / 1000) + 86_400) },
              ],
            },
          },
        })
        return { credentialExchangeId: record.id, threadId: record.threadId, connectionId: connection.id }
      })
      return reply(200, result)
    }
    if (req.method === 'POST' && req.url === '/arm') {
      armed = true
      return reply(200, { armed: true })
    }
    if (req.method === 'GET' && req.url === '/records') {
      const records = await withTenant(async (t) => ({
        credentials: (await t.modules.didcomm.credentials.getAll()).map((r) => ({ id: r.id, threadId: r.threadId, state: r.state })),
        connections: (await t.modules.didcomm.connections.getAll()).map((c) => ({ id: c.id, state: c.state })),
      }))
      return reply(200, records)
    }
    reply(404, { error: 'not found' })
  } catch (error) {
    reply(500, { error: error instanceof Error ? error.message : String(error) })
  }
})
server.listen(controlPort, '127.0.0.1')

// --- SIGTERM ---------------------------------------------------------------------------
let stopping = false
process.on('SIGTERM', async () => {
  if (stopping) return
  stopping = true
  const started = Date.now()
  console.log(`SIGTERM mode=${shutdownMode} inFlight=${inFlight}`)
  server.close()

  if (shutdownMode === 'drain') {
    // Do NOT stop the inbound transports here. Credo's DidCommHttpInboundTransport.stop() is
    // not idempotent: agent.shutdown() calls it again, server.close() fails with
    // ERR_SERVER_NOT_RUNNING, and shutdownModules throws BEFORE the store is closed (T3b run 1).
    // In the service the edge stops routing first (readiness goes 503); here nothing new arrives.
    //
    // 1. wait for in-flight processing, with a deadline;
    const transports = root.dependencyManager.resolve(DidCommModuleConfig).inboundTransports.length
    const deadline = Date.now() + 15_000
    while (inFlight > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    console.log(`drained inFlight=${inFlight} after ${Date.now() - started}ms (inbound transports left running: ${transports})`)
  }

  // 2. then close the agent once: it stops the transports and closes the store.
  try {
    await root.shutdown()
    console.log(`SHUTDOWN_DONE after ${Date.now() - started}ms`)
  } catch (error) {
    console.log('SHUTDOWN_ERROR', error)
  }
  // Give any stray promise that still touches the closed store a moment to surface its error.
  setTimeout(() => process.exit(0), 2_000)
})

process.on('unhandledRejection', (error) => console.log('UNHANDLED_REJECTION', error))

console.log(`READY endpoint=${endpoint} control=${controlPort} mode=${shutdownMode}`)
