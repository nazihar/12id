/**
 * A local Credo mediator for developing the load tools without staging: HTTP inbound on PORT
 * (default 3999), auto-accepted mediation, pickup v1, the in-memory queue. Prints a multi-use
 * invitation URL for `onboard.ts --invitation-url`. Credo 0.7, so close to (not the same as) the
 * staging mediator's Credo 0.6; staging is still the test that counts.
 *
 *   node load/local-mediator.ts
 */
import '../smoke/bindings.ts'
import 'reflect-metadata'

import { randomBytes } from 'node:crypto'

import { AskarModule } from '@credo-ts/askar'
import { Agent, LogLevel } from '@credo-ts/core'
import { DidCommHttpOutboundTransport, DidCommModule } from '@credo-ts/didcomm'
import { agentDependencies, DidCommHttpInboundTransport } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'

import { PlainLogger } from '../smoke/logger.ts'

const port = Number(process.env.PORT ?? 3999)
const agent = new Agent({
  config: { logger: new PlainLogger(process.env.LOG_LEVEL === 'debug' ? LogLevel.Debug : LogLevel.Warn, 'mediator') },
  dependencies: agentDependencies,
  modules: {
    askar: new AskarModule({ askar, store: { id: `local-mediator-${Date.now()}`, key: randomBytes(32).toString('base64url'), database: { type: 'sqlite', config: { inMemory: true } } } }),
    didcomm: new DidCommModule({
      endpoints: [`http://127.0.0.1:${port}`],
      transports: { outbound: [new DidCommHttpOutboundTransport()], inbound: [new DidCommHttpInboundTransport({ port })] },
      connections: { autoAcceptConnections: true },
      mediator: { autoAcceptMediationRequests: true },
    }),
  },
})
await agent.initialize()
const { outOfBandInvitation } = await agent.modules.didcomm.oob.createInvitation({ multiUseInvitation: true })
console.log(`local mediator on :${port}`)
console.log(`MEDIATOR_INVITATION_URL=${outOfBandInvitation.toUrl({ domain: `http://127.0.0.1:${port}` })}`)
