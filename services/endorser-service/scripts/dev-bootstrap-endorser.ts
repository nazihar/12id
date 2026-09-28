/**
 * LOCAL DEVELOPMENT ONLY. Creates a throwaway endorser DID in a Postgres Askar store so the
 * endorser-service can run on a workstation against the staging ledger.
 *
 * Staging and production use infra/ledger bootstrap-endorser; never point this at their stores.
 *
 *   LEDGER_REGISTER_URL=http://127.0.0.1:19000/register (SSH forward to von-network /register)
 *   plus the endorser-service Askar/Postgres/ledger variables.
 *
 * Prints the DID to use as ENDORSER_DID. Re-running on the same store reuses the existing DID.
 */
import '@12id/credo-base/bindings.ts'

import { provisionStoreIfMissing } from '@12id/credo-base/askar-postgres.ts'
import { createServiceLogger } from '@12id/credo-base/logger.ts'
import { TypedArrayEncoder } from '@credo-ts/core'

import { createEndorserAgent } from '../src/agent/endorser-agent.ts'

const namespace = process.env.INDY_NAMESPACE ?? ''
const registerUrl = process.env.LEDGER_REGISTER_URL
if (!registerUrl) throw new Error('LEDGER_REGISTER_URL is required')
if (/12id\.naziharitsolution\.com/.test(process.env.POSTGRES_HOST ?? '')) throw new Error('refusing to run against a staging database')

// The agent factory validates nothing about ENDORSER_DID, so a placeholder satisfies its config type.
const config = {
  LOG_LEVEL: 'info' as const,
  INDY_NAMESPACE: namespace,
  GENESIS_URL: process.env.GENESIS_URL ?? '',
  GENESIS_SHA256: process.env.GENESIS_SHA256 ?? '',
  INDY_NETWORK_PRODUCTION: false,
  ENDORSER_DID: '',
  ASKAR_STORE_ID: process.env.ASKAR_STORE_ID ?? '',
  ASKAR_STORE_KEY: process.env.ASKAR_STORE_KEY ?? '',
  POSTGRES_HOST: process.env.POSTGRES_HOST ?? '',
  POSTGRES_USER: process.env.POSTGRES_USER ?? '',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? '',
  DATABASE_URL: '',
  ENDORSER_DAILY_CEILING: 0,
  INTERNAL_TOKEN: '',
  HOST: '127.0.0.1',
  PORT: 0,
}

const logger = createServiceLogger({ name: 'dev-bootstrap-endorser', level: 'info' })
const agent = await createEndorserAgent(config, logger)
let exitCode = 0
try {
  const store = await provisionStoreIfMissing(agent)
  await agent.initialize()

  const prefix = `did:indy:${namespace}:`
  const [existing] = (await agent.dids.getCreatedDids({ method: 'indy' })).filter((record) => record.did.startsWith(prefix))
  if (existing) {
    logger.info({ store, did: existing.did }, 'reusing existing dev endorser')
    console.log(`ENDORSER_DID=${existing.did}`)
  } else {
    const { keyId, publicJwk } = await agent.kms.createKey({ type: { kty: 'OKP', crv: 'Ed25519' } })
    const publicKeyBytes = TypedArrayEncoder.fromBase64Url((publicJwk as { x: string }).x)
    const verkey = TypedArrayEncoder.toBase58(publicKeyBytes)
    const nym = TypedArrayEncoder.toBase58(publicKeyBytes.slice(0, 16))
    const did = `${prefix}${nym}`

    const response = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: nym, verkey, alias: `dev-endorser-${Date.now()}`, role: 'ENDORSER' }),
    })
    if (!response.ok) throw new Error(`NYM registration failed: ${response.status} ${await response.text()}`)

    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        await agent.dids.import({ did, keys: [{ kmsKeyId: keyId, didDocumentRelativeKeyId: '#verkey' }], overwrite: false })
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    }
    logger.info({ store, did }, 'created dev endorser')
    console.log(`ENDORSER_DID=${did}`)
  }
} catch (error) {
  logger.error({ err: error }, 'dev endorser bootstrap failed')
  exitCode = 1
} finally {
  await agent.shutdown().catch(() => undefined)
}
process.exit(exitCode)
