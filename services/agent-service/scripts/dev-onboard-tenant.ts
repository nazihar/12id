/**
 * LOCAL DEVELOPMENT: creates a tenant (or resumes one) and runs onboarding end to end against a
 * running endorser-service. Uses the normal agent-service configuration.
 *
 *   node scripts/dev-onboard-tenant.ts <label>            create and onboard
 *   node scripts/dev-onboard-tenant.ts --resume <tenantId> resume an interrupted onboarding
 */
import '@12id/credo-base/bindings.ts'

import { createServiceLogger } from '@12id/credo-base/logger.ts'

import { createRootAgent } from '../src/agent/root-agent.ts'
import { loadConfig } from '../src/config.ts'
import { createDatabase } from '../src/db/client.ts'
import { createEndorserClient } from '../src/endorser/endorser-client.ts'
import { createTenantRecord, onboardTenant } from '../src/tenants/onboarding.ts'

const [first, second] = process.argv.slice(2)
if (!first) throw new Error('usage: dev-onboard-tenant.ts <label> | --resume <tenantId>')

const config = loadConfig()
const logger = createServiceLogger({ name: 'dev-onboard', level: config.LOG_LEVEL })
const { pool, db } = createDatabase(config.DATABASE_URL)
const agent = await createRootAgent(config, logger)

let exitCode = 0
try {
  await agent.initialize()
  const deps = {
    agent,
    db,
    endorser: createEndorserClient({ baseUrl: config.ENDORSER_SERVICE_URL, token: config.ENDORSER_SERVICE_TOKEN }),
    endorserDid: config.ENDORSER_DID,
    logger,
  }
  const tenantId = first === '--resume' ? (second ?? '') : await createTenantRecord(deps, first)
  const started = Date.now()
  const row = await onboardTenant(deps, tenantId)
  console.log(JSON.stringify({ tenantId: row.id, status: row.status, did: row.did, ms: Date.now() - started }, null, 2))
} catch (error) {
  logger.error({ err: error }, 'dev onboarding failed')
  exitCode = 1
} finally {
  await agent.shutdown().catch(() => undefined)
  await pool.end().catch(() => undefined)
}
process.exit(exitCode)
