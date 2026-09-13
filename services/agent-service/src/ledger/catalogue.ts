/**
 * Schema and credential definition publishing (A4) through the author/endorser flow (T2).
 * State machine in `ledger_objects`; calling a publish function again resumes it:
 *
 *   pending              → build the author-signed request (cred def: Credo stores the private key
 *                          HERE, so the full action-state credential definition is persisted)
 *   awaiting_endorsement → endorser-service multi-signs
 *   endorsed             → submit; if the ledger already has the object (crash after submit),
 *                          treat it as published
 *   published            → both identifier forms stored; the unqualified one goes on the wire
 */
import { credentialDefinitionIds, schemaIds } from '@12id/credo-base/ids.ts'
import { and, eq } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { RootAgent } from '../agent/root-agent.ts'
import type { Database } from '../db/client.ts'
import { type LedgerObjectStatus, ledgerObjects, tenants } from '../db/schema.ts'
import type { EndorserClient } from '../endorser/endorser-client.ts'
import { type SchemaInput, schemaInput } from './schema-input.ts'

export interface CatalogueDeps {
  agent: RootAgent
  db: Database
  endorser: EndorserClient
  endorserDid: string
  logger: PinoLogger
}

type LedgerObjectRow = typeof ledgerObjects.$inferSelect

interface ActionState {
  state: string
  reason?: string
  schemaId?: string
  schemaRequest?: string
  credentialDefinitionId?: string
  credentialDefinitionRequest?: string
  credentialDefinition?: Record<string, unknown>
}

async function readyTenant(deps: CatalogueDeps, tenantId: string) {
  const [tenant] = await deps.db.select().from(tenants).where(eq(tenants.id, tenantId))
  if (!tenant) throw new Error(`unknown tenant ${tenantId}`)
  if (tenant.status !== 'ready' || !tenant.did) throw new Error(`tenant ${tenantId} is not onboarded (status ${tenant.status})`)
  return { ...tenant, did: tenant.did }
}

function stepper(deps: CatalogueDeps, rowId: string, log: PinoLogger) {
  const load = async () => {
    const [row] = await deps.db.select().from(ledgerObjects).where(eq(ledgerObjects.id, rowId))
    if (!row) throw new Error(`ledger object ${rowId} disappeared`)
    return row
  }
  const advance = async (status: LedgerObjectStatus, fields: Partial<LedgerObjectRow> = {}) => {
    await deps.db.update(ledgerObjects).set({ ...fields, status, lastError: null, updatedAt: new Date() }).where(eq(ledgerObjects.id, rowId))
    log.info({ status }, 'ledger object advanced')
  }
  const fail = async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    await deps.db.update(ledgerObjects).set({ lastError: message, updatedAt: new Date() }).where(eq(ledgerObjects.id, rowId))
  }
  return { load, advance, fail }
}

async function findOrCreateRow(deps: CatalogueDeps, values: typeof ledgerObjects.$inferInsert): Promise<LedgerObjectRow> {
  await deps.db.insert(ledgerObjects).values(values).onConflictDoNothing()
  const [row] = await deps.db
    .select()
    .from(ledgerObjects)
    .where(
      and(
        eq(ledgerObjects.tenantId, values.tenantId),
        eq(ledgerObjects.kind, values.kind),
        eq(ledgerObjects.name, values.name),
        eq(ledgerObjects.version, values.version),
        eq(ledgerObjects.tag, values.tag ?? '')
      )
    )
  if (!row) throw new Error('ledger object row was not stored')
  return row
}

export async function publishSchema(deps: CatalogueDeps, tenantId: string, input: SchemaInput): Promise<LedgerObjectRow> {
  const schema = schemaInput.parse(input)
  const tenant = await readyTenant(deps, tenantId)
  const row0 = await findOrCreateRow(deps, { tenantId, kind: 'schema', name: schema.name, version: schema.version, tag: '', attributes: schema.attributes })
  if (JSON.stringify(row0.attributes) !== JSON.stringify(schema.attributes)) {
    throw new Error(`schema ${schema.name} ${schema.version} already exists with different attributes; publish a new version`)
  }

  const log = deps.logger.child({ tenantId, flow: 'publish-schema', ledgerObjectId: row0.id, name: schema.name, version: schema.version })
  const steps = stepper(deps, row0.id, log)
  const anoncredsSchema = { issuerId: tenant.did, name: schema.name, version: schema.version, attrNames: schema.attributes }
  const withTenant = <T>(fn: (tenant: Parameters<Parameters<RootAgent['modules']['tenants']['withTenantAgent']>[1]>[0]) => Promise<T>) =>
    deps.agent.modules.tenants.withTenantAgent({ tenantId }, fn)

  let row = row0
  try {
    while (row.status !== 'published') {
      switch (row.status) {
        case 'pending': {
          const result = await withTenant((t) =>
            t.modules.anoncreds.registerSchema({ schema: anoncredsSchema, options: { endorserMode: 'external', endorserDid: deps.endorserDid } })
          )
          const state = result.schemaState as ActionState
          if (state.state !== 'action' || !state.schemaRequest || !state.schemaId) {
            throw new Error(`schema request was not produced: ${state.reason ?? state.state}`)
          }
          await steps.advance('awaiting_endorsement', { request: state.schemaRequest, qualifiedId: state.schemaId })
          break
        }
        case 'awaiting_endorsement': {
          if (!row.request) throw new Error('awaiting_endorsement without a request')
          const endorsed = await deps.endorser.endorse({ tenantId, kind: 'schema', request: row.request })
          await steps.advance('endorsed', { endorsedRequest: endorsed })
          break
        }
        case 'endorsed': {
          if (!row.endorsedRequest || !row.qualifiedId) throw new Error('endorsed without an endorsed request or id')
          const qualifiedId = row.qualifiedId
          const endorsedRequest = row.endorsedRequest
          // Submit first. Checking the ledger up front made Credo log a level-50 "Error retrieving
          // schema" on every normal publish; only a failed submit (e.g. a retry after a crash that
          // happened after submission) needs the check.
          const result = await withTenant((t) =>
            t.modules.anoncreds.registerSchema({ schema: anoncredsSchema, options: { endorserMode: 'external', endorsedTransaction: endorsedRequest } })
          )
          const state = result.schemaState as ActionState
          if (state.state !== 'finished') {
            const existing = await withTenant((t) => t.modules.anoncreds.getSchema(qualifiedId))
            if (!existing.schema) throw new Error(`schema submission failed: ${state.reason ?? state.state}`)
            log.info({ submitReason: state.reason }, 'schema submission failed but the schema is on the ledger; treating as published')
          }
          const ids = schemaIds(qualifiedId)
          await steps.advance('published', { unqualifiedId: ids.unqualified })
          break
        }
        default:
          throw new Error(`schema is ${row.status}; cannot publish`)
      }
      row = await steps.load()
    }
    return row
  } catch (error) {
    await steps.fail(error)
    log.error({ err: error, status: row.status }, 'schema publishing step failed')
    throw error
  }
}

export async function publishCredentialDefinition(
  deps: CatalogueDeps,
  tenantId: string,
  schemaObjectId: string,
  tag = 'default'
): Promise<LedgerObjectRow> {
  const tenant = await readyTenant(deps, tenantId)
  const [schemaRow] = await deps.db.select().from(ledgerObjects).where(and(eq(ledgerObjects.id, schemaObjectId), eq(ledgerObjects.tenantId, tenantId)))
  if (!schemaRow || schemaRow.kind !== 'schema') throw new Error(`schema ${schemaObjectId} not found for tenant ${tenantId}`)
  if (schemaRow.status !== 'published' || !schemaRow.qualifiedId) throw new Error(`schema ${schemaObjectId} is not published`)
  const schemaId = schemaRow.qualifiedId

  const row0 = await findOrCreateRow(deps, {
    tenantId,
    kind: 'credential_definition',
    name: schemaRow.name,
    version: schemaRow.version,
    tag,
    schemaObjectId,
  })
  const log = deps.logger.child({ tenantId, flow: 'publish-cred-def', ledgerObjectId: row0.id, schemaId, tag })
  const steps = stepper(deps, row0.id, log)
  const withTenant = <T>(fn: (tenant: Parameters<Parameters<RootAgent['modules']['tenants']['withTenantAgent']>[1]>[0]) => Promise<T>) =>
    deps.agent.modules.tenants.withTenantAgent({ tenantId }, fn)

  let row = row0
  try {
    while (row.status !== 'published') {
      switch (row.status) {
        case 'pending': {
          // Credo stores the cred def private key during this call. The full credential definition
          // it returns is persisted so the submit step never regenerates keys (T2 trap 1-2).
          const result = await withTenant((t) =>
            t.modules.anoncreds.registerCredentialDefinition({
              credentialDefinition: { issuerId: tenant.did, schemaId, tag },
              options: { supportRevocation: false, endorserMode: 'external', endorserDid: deps.endorserDid },
            })
          )
          const state = result.credentialDefinitionState as ActionState
          if (state.state !== 'action' || !state.credentialDefinitionRequest || !state.credentialDefinition || !state.credentialDefinitionId) {
            throw new Error(`cred def request was not produced: ${state.reason ?? state.state}`)
          }
          await steps.advance('awaiting_endorsement', {
            request: state.credentialDefinitionRequest,
            actionState: state.credentialDefinition,
            qualifiedId: state.credentialDefinitionId,
          })
          break
        }
        case 'awaiting_endorsement': {
          if (!row.request) throw new Error('awaiting_endorsement without a request')
          const endorsed = await deps.endorser.endorse({ tenantId, kind: 'credentialDefinition', request: row.request })
          await steps.advance('endorsed', { endorsedRequest: endorsed })
          break
        }
        case 'endorsed': {
          if (!row.endorsedRequest || !row.qualifiedId || !row.actionState) throw new Error('endorsed without request, id or action state')
          const qualifiedId = row.qualifiedId
          const endorsedRequest = row.endorsedRequest
          const fullDefinition = row.actionState
          // Submit first; check the ledger only when submission fails (see publishSchema).
          const result = await withTenant((t) =>
            t.modules.anoncreds.registerCredentialDefinition({
              credentialDefinition: fullDefinition as never,
              options: { supportRevocation: false, endorserMode: 'external', endorsedTransaction: endorsedRequest } as never,
            })
          )
          const state = result.credentialDefinitionState as ActionState
          if (state.state !== 'finished') {
            const existing = await withTenant((t) => t.modules.anoncreds.getCredentialDefinition(qualifiedId))
            if (!existing.credentialDefinition) throw new Error(`cred def submission failed: ${state.reason ?? state.state}`)
            log.info({ submitReason: state.reason }, 'cred def submission failed but it is on the ledger; treating as published')
          }
          const ids = credentialDefinitionIds(qualifiedId)
          await steps.advance('published', { unqualifiedId: ids.unqualified })
          break
        }
        default:
          throw new Error(`cred def is ${row.status}; cannot publish`)
      }
      row = await steps.load()
    }
    return row
  } catch (error) {
    await steps.fail(error)
    log.error({ err: error, status: row.status }, 'cred def publishing step failed')
    throw error
  }
}
