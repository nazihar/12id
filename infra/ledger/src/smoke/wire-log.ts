import type { Agent } from '@credo-ts/core'
import { DidCommEventTypes } from '@credo-ts/didcomm'

export interface WireEntry {
  agent: string
  direction: 'sent' | 'received'
  type: string
}

/**
 * Records the `@type` URI of every DIDComm message crossing the wire.
 *
 * A successful exchange does not by itself prove the v1 protocol was used, but the
 * message type URI does. Note the logged type is read before serialization, so the
 * `did:sov:...;spec/` rewrite applied at pack time is not visible here (Phase 0 finding);
 * the mediator's own logs show the on-the-wire form.
 */
export function recordWire(agent: Agent, label: string, log: WireEntry[]) {
  agent.events.observable<any>(DidCommEventTypes.DidCommMessageProcessed).subscribe((event) => {
    const message = event.payload.message
    const type = message?.['@type'] ?? message?.type
    if (type) log.push({ agent: label, direction: 'received', type })
    if (type && /problem-report/.test(type)) {
      console.log(`  !! ${label} received problem-report:`, JSON.stringify(message?.description ?? message, null, 2))
    }
  })
  agent.events.observable<any>(DidCommEventTypes.DidCommMessageSent).subscribe((event) => {
    const message = event.payload.message?.message
    const type = message?.['@type'] ?? message?.type
    if (type) log.push({ agent: label, direction: 'sent', type })
    if (type && /problem-report/.test(type)) {
      console.log(`  !! ${label} sent problem-report:`, JSON.stringify(message?.description ?? message, null, 2))
    }
  })
}

export function printWire(log: WireEntry[]) {
  console.log('\n=== DIDComm messages on the wire ===')
  for (const entry of log) {
    console.log(`  ${entry.agent.padEnd(7)} ${entry.direction.padEnd(8)} ${entry.type}`)
  }
  const v2 = log.filter((e) => /issue-credential.2|present-proof.2/.test(e.type) && !/1.0/.test(e.type))
  const v1 = log.filter((e) => /issue-credential\/1|present-proof\/1/.test(e.type))
  console.log(`\n  v1 protocol messages: ${v1.length}`)
  console.log(`  v2 protocol messages: ${v2.length}`)
}
