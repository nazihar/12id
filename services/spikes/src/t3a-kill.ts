/**
 * Spike T3a (7-phase-2.md): hard-kill the tenant issuer mid-exchange and restart it.
 * Runs on Windows or Linux (SIGKILL is a hard terminate on both).
 *
 * Scenario:
 *   1. issuer (child process, Postgres store) offers a credential; the holder has NOT accepted yet;
 *   2. SIGKILL the issuer;
 *   3. holder accepts: its request-credential goes to a dead endpoint;
 *   4. restart the issuer on the same store: does it open, and where is the exchange stuck?
 *   5. recovery A: holder accepts the same offer again;
 *      recovery B: issuer re-offers on the same connection.
 *
 * Env: T3_STATE_FILE, MEDIATOR_INVITATION_FILE, POSTGRES_HOST (+ tunnel on first run).
 */
import './bindings.ts'

import { DidCommCredentialState } from '@credo-ts/didcomm'

import { createHolderAgent, type HolderAgent, withTimeout } from './common.ts'
import { STORE_ERROR, control, startIssuer } from './t3-harness.ts'

type Records = { credentials: Array<{ id: string; threadId: string; state: string }>; connections: Array<{ state: string }> }

function waitForHolderState(holder: HolderAgent, state: DidCommCredentialState, exclude: Set<string>, timeoutMs: number) {
  return withTimeout(
    new Promise<string>((resolve) => {
      holder.events.observable<any>('DidCommCredentialStateChanged').subscribe((event) => {
        const record = event.payload.credentialExchangeRecord
        if (record.state === state && !exclude.has(record.id)) resolve(record.id)
      })
    }),
    timeoutMs,
    `holder credential ${state}`
  )
}

const report: Record<string, unknown> = {}
let holder: HolderAgent | undefined
let issuer = startIssuer('issuer#1')
let passed = false

try {
  await issuer.waitFor(/^READY/, 300_000)

  holder = await createHolderAgent('t3a-holder', { autoAccept: false })
  const { oobId, url } = await control<{ oobId: string; url: string }>('POST', '/invitation')
  const received = await holder.modules.didcomm.oob.receiveInvitationFromUrl(url, { label: 't3a-holder' })
  if (!received.connectionRecord) throw new Error('holder created no connection')
  await holder.modules.didcomm.connections.returnWhenIsConnected(received.connectionRecord.id, { timeoutMs: 90_000 })
  console.log('connected')

  // 1. offer, holder does not accept yet
  const offerReceived = waitForHolderState(holder, DidCommCredentialState.OfferReceived, new Set(), 120_000)
  const offer1 = await control<{ credentialExchangeId: string; threadId: string }>('POST', '/offer', { oobId })
  const holderRecord1 = await offerReceived
  console.log(`offer 1 received by holder (thread ${offer1.threadId})`)

  // 2. hard kill
  issuer.child.kill('SIGKILL')
  report.killExitCode = await issuer.exited
  console.log(`issuer SIGKILLed (exit ${report.killExitCode})`)

  // 3. holder accepts while the issuer is dead
  try {
    await holder.modules.didcomm.credentials.acceptOffer({ credentialExchangeRecordId: holderRecord1 })
    report.acceptWhileDown = 'resolved without error'
  } catch (error) {
    report.acceptWhileDown = `threw: ${(error as Error).message.split('\n')[0]}`
  }
  report.holderStateAfterFailedAccept = (await holder.modules.didcomm.credentials.getById(holderRecord1)).state
  console.log('accept while issuer down:', report.acceptWhileDown, '| holder state:', report.holderStateAfterFailedAccept)

  // 4. restart on the same store
  issuer = startIssuer('issuer#2')
  await issuer.waitFor(/^READY/, 300_000)
  const afterRestart = await control<Records>('GET', '/records')
  report.issuerAfterRestart = afterRestart
  console.log('issuer records after restart:', JSON.stringify(afterRestart))

  // 5A. holder accepts the same offer again
  try {
    await holder.modules.didcomm.credentials.acceptOffer({ credentialExchangeRecordId: holderRecord1 })
    report.recoveryA = 'accept again: resolved'
  } catch (error) {
    report.recoveryA = `accept again: threw: ${(error as Error).message.split('\n')[0]}`
  }
  console.log('recovery A:', report.recoveryA)
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const afterA = await control<Records>('GET', '/records')
  report.issuerAfterRecoveryA = afterA.credentials.find((c) => c.id === offer1.credentialExchangeId)?.state

  // 5B. issuer re-offers on the same connection, holder accepts, must reach done.
  // The holder has auto-accept OFF, so it stops at credential-received until it accepts the
  // credential (which sends the ack). The first T3a run waited for `done` without this step.
  const offer2Received = waitForHolderState(holder, DidCommCredentialState.OfferReceived, new Set([holderRecord1]), 120_000)
  const offer2 = await control<{ credentialExchangeId: string }>('POST', '/offer', { oobId })
  const holderRecord2 = await offer2Received
  const credentialReceived = waitForHolderState(holder, DidCommCredentialState.CredentialReceived, new Set([holderRecord1]), 120_000)
  await holder.modules.didcomm.credentials.acceptOffer({ credentialExchangeRecordId: holderRecord2 })
  await credentialReceived
  report.recoveryBCredentialReceived = true
  const done = waitForHolderState(holder, DidCommCredentialState.Done, new Set([holderRecord1]), 120_000)
  await holder.modules.didcomm.credentials.acceptCredential({ credentialExchangeRecordId: holderRecord2 })
  await done
  const afterB = await control<Records>('GET', '/records')
  report.recoveryB = afterB.credentials.find((c) => c.id === offer2.credentialExchangeId)?.state
  report.issuerFinal = afterB
  console.log('recovery B (re-offer): issuer state', report.recoveryB)

  report.storeErrors = [...issuer.output].filter((line) => STORE_ERROR.test(line))
  // The state file is reused across runs, so the tenant accumulates connections; check the
  // one this run used (the offer went out on it) rather than a total count.
  const connectionUsed = afterRestart.connections.every((c) => c.state === 'completed') && afterRestart.connections.length >= 1
  passed =
    connectionUsed &&
    (report.storeErrors as string[]).length === 0 &&
    report.recoveryBCredentialReceived === true &&
    (report.recoveryB === 'done' || report.recoveryB === 'credential-issued')
} catch (error) {
  console.error('T3a FAILED:', error)
} finally {
  console.log('\nT3a report:', JSON.stringify(report, null, 2))
  issuer.child.kill('SIGKILL')
  await holder?.shutdown().catch(() => undefined)
}

console.log(`\n=== T3a ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
