/**
 * LOCAL DEVELOPMENT: publishes a schema and a non-revocable cred def for an onboarded tenant
 * through the running endorser-service, then prints the stored ids.
 *
 *   node scripts/dev-publish-catalogue.ts <tenantId> [schemaName] [version]
 */
import '@12id/credo-base/bindings.ts'

import { createServiceLogger } from '@12id/credo-base/logger.ts'

import { createRootAgent } from '../src/agent/root-agent.ts'
import { loadConfig } from '../src/config.ts'
import { createDatabase } from '../src/db/client.ts'
import { createEndorserClient } from '../src/endorser/endorser-client.ts'
import { publishCredentialDefinition, publishSchema } from '../src/ledger/catalogue.ts'

const [tenantId, schemaName = 'employee-badge', version = '1.0'] = process.argv.slice(2)
if (!tenantId) throw new Error('usage: dev-publish-catalogue.ts <tenantId> [schemaName] [version]')

const config = loadConfig()
const logger = createServiceLogger({ name: 'dev-catalogue', level: config.LOG_LEVEL })
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
  const started = Date.now()
  const schema = await publishSchema(deps, tenantId, { name: schemaName, version, attributes: ['name', 'employeeNumber', 'department', 'expiresAt'] })
  const credDef = await publishCredentialDefinition(deps, tenantId, schema.id)
  console.log(
    JSON.stringify(
      {
        schema: { status: schema.status, qualifiedId: schema.qualifiedId, unqualifiedId: schema.unqualifiedId },
        credentialDefinition: { status: credDef.status, qualifiedId: credDef.qualifiedId, unqualifiedId: credDef.unqualifiedId },
        ms: Date.now() - started,
      },
      null,
      2
    )
  )
} catch (error) {
  logger.error({ err: error }, 'dev catalogue publishing failed')
  exitCode = 1
} finally {
  await agent.shutdown().catch(() => undefined)
  await pool.end().catch(() => undefined)
}
process.exit(exitCode)
