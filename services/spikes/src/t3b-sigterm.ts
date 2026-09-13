/**
 * Spike T3b (7-phase-2.md): SIGTERM the tenant issuer while it is processing the holder's
 * request-credential, once with a naive shutdown and once with a drain. LINUX ONLY: on Windows
 * a parent cannot deliver a catchable SIGTERM to a Node child.
 *
 *   SHUTDOWN_MODE=naive | drain node src/t3b-sigterm.ts
 *
 * Needs an existing T3_STATE_FILE (run T3a first), MEDIATOR_INVITATION_FILE, POSTGRES_HOST.
 */
import './bindings.ts'

import { DidCommCredentialState } from '@credo-ts/didcomm'

import { createHolderAgent, env, type HolderAgent, withTimeout } from './common.ts'
import { STORE_ERROR, control, startIssuer } from './t3-harness.ts'

if (process.platform === 'win32') {
  console.error('T3b must run on Linux: Windows cannot deliver a catchable SIGTERM to a child process')
  process.exit(2)
}

const mode = env('SHUTDOWN_MODE', 'naive')
type Records = { credentials: Array<{ id: string; state: string }> }

const report: Record<string, unknown> = { mode }
let holder: HolderAgent | undefined
let issuer = startIssuer(`issuer-${mode}`, { SHUTDOWN_MODE: mode })
let passed = false

try {
  await issuer.waitFor(/^READY/, 300_000)
  holder = await createHolderAgent(`t3b-holder-${mode}`, { autoAccept: false })
  const { oobId, url } = await control<{ oobId: string; url: string }>('POST', '/invitation')
  const received = await holder.modules.didcomm.oob.receiveInvitationFromUrl(url, { label: `t3b-holder-${mode}` })
  if (!received.connectionRecord) throw new Error('holder created no connection')
  await holder.modules.didcomm.connections.returnWhenIsConnected(received.connectionRecord.id, { timeoutMs: 90_000 })

  const offerReceived = withTimeout(
    new Promise<string>((resolve) => {
      holder!.events.observable<any>('DidCommCredentialStateChanged').subscribe((event) => {
        if (event.payload.credentialExchangeRecord.state === DidCommCredentialState.OfferReceived) resolve(event.payload.credentialExchangeRecord.id)
      })
    }),
    120_000,
    'offer received'
  )
  const offer = await control<{ credentialExchangeId: string }>('POST', '/offer', { oobId })
  const holderRecordId = await offerReceived

  // Auto-accept is off on the holder, so a delivered credential stops at credential-received
  // (no ack is sent, and the issuer is shutting down anyway). Delivery is what this checks.
  const holderDone = withTimeout(
    new Promise<void>((resolve) => {
      holder!.events.observable<any>('DidCommCredentialStateChanged').subscribe((event) => {
        if (event.payload.credentialExchangeRecord.state === DidCommCredentialState.CredentialReceived) resolve()
      })
    }),
    60_000,
    'holder credential received'
  ).then(
    () => 'credential-received',
    () => 'not received within 60s'
  )

  // Arm, accept, and SIGTERM the moment the issuer sees the inbound envelope.
  await control('POST', '/arm')
  const marker = issuer.waitFor(/^MARKER inbound/, 60_000)
  const accept = holder.modules.didcomm.credentials
    .acceptOffer({ credentialExchangeRecordId: holderRecordId })
    .then(() => 'resolved', (error: Error) => `threw: ${error.message.split('\n')[0]}`)
  report.marker = await marker
  issuer.child.kill('SIGTERM')
  report.signalledAt = new Date().toISOString()

  report.exitCode = await issuer.exited
  report.holderAccept = await accept
  report.holderCredential = await holderDone
  report.shutdownLines = issuer.output.filter((line) => /^(SIGTERM|drained|SHUTDOWN_DONE)/.test(line))
  report.storeErrors = issuer.output.filter((line) => STORE_ERROR.test(line))

  // Restart to read the issuer's persisted state for this exchange.
  issuer = startIssuer(`issuer-${mode}-reopen`, { SHUTDOWN_MODE: mode })
  await issuer.waitFor(/^READY/, 300_000)
  const records = await control<Records>('GET', '/records')
  report.issuerStateAfterRestart = records.credentials.find((c) => c.id === offer.credentialExchangeId)?.state

  const storeErrors = report.storeErrors as string[]
  passed =
    mode === 'drain'
      ? storeErrors.length === 0 &&
        report.holderCredential === 'credential-received' &&
        report.issuerStateAfterRestart === 'credential-issued'
      : true // naive mode is the control: its outcome is recorded, not asserted
} catch (error) {
  console.error('T3b FAILED:', error)
} finally {
  console.log('\nT3b report:', JSON.stringify(report, null, 2))
  issuer.child.kill('SIGKILL')
  await holder?.shutdown().catch(() => undefined)
}

console.log(`\n=== T3b (${mode}) ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
