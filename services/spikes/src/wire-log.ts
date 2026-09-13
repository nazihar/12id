import type { Agent } from '@credo-ts/core'
import { DidCommEventTypes } from '@credo-ts/didcomm'

export interface WireEntry {
  agent: string
  /** metadata.contextCorrelationId of the event: `default` for the root, `tenant-<id>` for tenants. */
  context: string
  direction: 'sent' | 'received'
  type: string
}

/**
 * Adapted from infra/ledger/src/smoke/wire-log.ts, adding the event's contextCorrelationId so
 * T1 can show which tenant each message belongs to. The type is read before serialization, so
 * the did:sov rewrite applied at pack time is not visible here.
 */
export function recordWire(agent: Pick<Agent, 'events'>, label: string, log: WireEntry[]) {
  agent.events.observable<any>(DidCommEventTypes.DidCommMessageProcessed).subscribe((event: any) => {
    const message = event.payload.message
    const type = message?.['@type'] ?? message?.type
    if (type) log.push({ agent: label, context: event.metadata?.contextCorrelationId, direction: 'received', type })
    if (type && /problem-report/.test(type)) {
      console.log(`  !! ${label} received problem-report:`, JSON.stringify(message?.description ?? message, null, 2))
    }
  })
  agent.events.observable<any>(DidCommEventTypes.DidCommMessageSent).subscribe((event: any) => {
    const message = event.payload.message?.message
    const type = message?.['@type'] ?? message?.type
    if (type) log.push({ agent: label, context: event.metadata?.contextCorrelationId, direction: 'sent', type })
    if (type && /problem-report/.test(type)) {
      console.log(`  !! ${label} sent problem-report:`, JSON.stringify(message?.description ?? message, null, 2))
    }
  })
}

export function printWire(log: WireEntry[]) {
  console.log('\n=== DIDComm messages on the wire ===')
  for (const entry of log) {
    console.log(`  ${entry.agent.padEnd(9)} ${String(entry.context).padEnd(44)} ${entry.direction.padEnd(8)} ${entry.type}`)
  }
  const v1 = log.filter((e) => /issue-credential\/1|present-proof\/1/.test(e.type)).length
  const v2 = log.filter((e) => /issue-credential\/2|present-proof\/2/.test(e.type)).length
  console.log(`\n  v1 protocol messages: ${v1}`)
  console.log(`  v2 protocol messages: ${v2}`)
  return { v1, v2 }
}
