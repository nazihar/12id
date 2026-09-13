/**
 * Spike T2 (7-phase-2.md): author/endorser flow on Credo 0.7.0 against the staging ledger.
 *
 *   MEDIATOR_INVITATION_FILE is not needed here. Needs the SSH tunnel to /register
 *   (LEDGER_REGISTER_URL, default http://127.0.0.1:19000/register) for the throwaway
 *   endorser, and the local Postgres (127.0.0.1:55432).
 *
 * Also checks, for T1/T3: the tenant's DID and cred def survive closing and reopening the
 * Postgres-backed root store (ProfilePerWallet).
 */
import './bindings.ts'

import { randomBytes } from 'node:crypto'

import { AnonCredsCredentialDefinitionPrivateRepository } from '@credo-ts/anoncreds'

import { createEndorserAgent, createRootAgent, createSpikeEndorserDid, type RootAgent } from './common.ts'
import { checkEndorsementPolicy, onboardTenant } from './ledger.ts'

const runId = `p2t2${Date.now()}`
const storeId = `spike_${runId}`
const storeKey = randomBytes(32).toString('base64url')

let passed = false
const cleanup: Array<() => Promise<unknown>> = []

try {
  const endorser = await createEndorserAgent()
  cleanup.push(() => endorser.shutdown())
  const endorserIdentity = await createSpikeEndorserDid(endorser, `${runId}-endorser`)
  console.log('spike endorser DID:', endorserIdentity.did)

  let root: RootAgent = await createRootAgent({ storeId, storeKey, endpoint: 'http://127.0.0.1:3501', port: 3501 })
  const tenant = await onboardTenant(root, endorser, endorserIdentity.did, {
    label: `${runId}-tenant-a`,
    schemaName: `${runId}-badge`,
    attributes: ['name', 'employeeNumber', 'expiresAt'],
    log: true,
  })
  console.log('\nonboarded tenant:', JSON.stringify(tenant, null, 2))

  // Policy refusals the endorser-service must enforce; Credo itself would sign any of these.
  const endorserNym = endorserIdentity.nym
  const refusals = {
    nymWithRole: checkEndorsementPolicy({
      kind: 'nym',
      request: JSON.stringify({ identifier: endorserNym, operation: { type: '1', dest: tenant.nym, role: '101' } }),
      endorserNym,
      expectedDest: tenant.nym,
    }),
    nymForOtherDid: checkEndorsementPolicy({
      kind: 'nym',
      request: JSON.stringify({ identifier: endorserNym, operation: { type: '1', dest: 'SomeoneElse111111111111' } }),
      endorserNym,
      expectedDest: tenant.nym,
    }),
    schemaFromForeignAuthor: checkEndorsementPolicy({
      kind: 'schema',
      request: JSON.stringify({ identifier: 'Foreign1111111111111111', endorser: endorserNym, signature: 'x', operation: { type: '101' } }),
      endorserNym,
      expectedAuthor: tenant.nym,
    }),
    attribDisguisedAsSchema: checkEndorsementPolicy({
      kind: 'schema',
      request: JSON.stringify({ identifier: tenant.nym, endorser: endorserNym, signature: 'x', operation: { type: '100' } }),
      endorserNym,
      expectedAuthor: tenant.nym,
    }),
  }
  console.log('\npolicy refusals:', JSON.stringify(refusals, null, 2))
  const allRefused = Object.values(refusals).every((reason) => typeof reason === 'string')

  // Reopen the Postgres store: the tenant, its DID and its cred def private key must persist.
  await root.shutdown()
  console.log('\nroot store closed; reopening')
  root = await createRootAgent({ storeId, storeKey, endpoint: 'http://127.0.0.1:3501', port: 3501 })
  cleanup.push(() => root.shutdown())
  const tenants = await root.modules.tenants.getAllTenants()
  const persisted = await root.modules.tenants.withTenantAgent({ tenantId: tenant.tenantId }, async (tenantAgent) => {
    const t = tenantAgent as unknown as RootAgent
    const dids = await t.dids.getCreatedDids({ method: 'indy' })
    const privateRecords = await t.dependencyManager.resolve(AnonCredsCredentialDefinitionPrivateRepository).getAll(t.context)
    const credDef = await t.modules.anoncreds.getCredentialDefinition(tenant.credentialDefinitionId)
    return {
      dids: dids.map((r) => r.did),
      privateCredDefs: privateRecords.map((r) => r.credentialDefinitionId),
      credDefResolves: Boolean(credDef.credentialDefinition),
    }
  })
  console.log('after reopen:', JSON.stringify({ tenantCount: tenants.length, ...persisted }, null, 2))

  passed =
    allRefused &&
    tenants.length === 1 &&
    persisted.dids.includes(tenant.did) &&
    persisted.privateCredDefs.includes(tenant.credentialDefinitionId) &&
    persisted.credDefResolves
  console.log(`\nstore id (postgres database): ${storeId}`)
} catch (error) {
  console.error('T2 FAILED:', error)
} finally {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined)
}

console.log(`\n=== T2 ${passed ? 'PASSED' : 'FAILED'} ===`)
process.exit(passed ? 0 : 1)
