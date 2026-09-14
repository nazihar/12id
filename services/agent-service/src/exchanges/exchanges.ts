/**
 * Exchange commands (A5): invitations, v1 credential offers, v1 proof requests. All asynchronous;
 * each returns the Credo record id, and progress arrives through the outbox (A6).
 *
 * Every id that goes on the wire passes through the builders, which refuse qualified ids and
 * inject the expiry predicate.
 */
import { DidCommOutOfBandRepository } from '@credo-ts/didcomm'
import { and, eq } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { RootAgent } from '../agent/root-agent.ts'
import type { Database } from '../db/client.ts'
import { ledgerObjects, tenants } from '../db/schema.ts'
import { type PendingCorrelations, setCorrelationId } from '../events/correlation.ts'
import { type ProofGroupInput, buildOfferAttributes, buildProofRequest } from './builders.ts'

export interface ExchangeDeps {
  agent: RootAgent
  db: Database
  /** Public DIDComm endpoint; invitations are encoded into URLs on this domain. */
  didcommEndpoint: string
  logger: PinoLogger
  pendingCorrelations: PendingCorrelations
}

type TenantAgent = Parameters<Parameters<RootAgent['modules']['tenants']['withTenantAgent']>[1]>[0]

const withTenant = <T>(deps: ExchangeDeps, tenantId: string, fn: (tenant: TenantAgent) => Promise<T>) =>
  deps.agent.modules.tenants.withTenantAgent({ tenantId }, fn)

export class ExchangeError extends Error {
  public readonly status: number

  public constructor(status: number, message: string) {
    super(message)
    this.name = 'ExchangeError'
    this.status = status
  }
}

async function assertTenantReady(deps: ExchangeDeps, tenantId: string) {
  const [tenant] = await deps.db.select({ status: tenants.status, label: tenants.label }).from(tenants).where(eq(tenants.id, tenantId))
  if (!tenant) throw new ExchangeError(404, `unknown tenant ${tenantId}`)
  if (tenant.status !== 'ready') throw new ExchangeError(409, `tenant ${tenantId} is not onboarded (status ${tenant.status})`)
  return tenant
}

export async function createInvitation(
  deps: ExchangeDeps,
  tenantId: string,
  options: { multiUse: boolean; correlationId?: string; alias?: string }
) {
  const tenant = await assertTenantReady(deps, tenantId)
  return withTenant(deps, tenantId, async (t) => {
    const record = await t.modules.didcomm.oob.createInvitation({
      label: tenant.label,
      alias: options.alias,
      multiUseInvitation: options.multiUse,
      autoAcceptConnection: true,
    })
    if (options.correlationId) {
      setCorrelationId(record, options.correlationId)
      // The OOB API has no update method; the repository does.
      await t.dependencyManager.resolve(DidCommOutOfBandRepository).update(t.context, record)
      // The connection created from this invitation inherits the id via the outbox listener.
      deps.pendingCorrelations.announce(tenantId, 'connection', record.id, options.correlationId)
    }
    return {
      outOfBandId: record.id,
      invitationUrl: record.outOfBandInvitation.toUrl({ domain: deps.didcommEndpoint }),
      multiUse: options.multiUse,
    }
  })
}

export async function listConnections(deps: ExchangeDeps, tenantId: string, outOfBandId?: string) {
  await assertTenantReady(deps, tenantId)
  return withTenant(deps, tenantId, async (t) => {
    const records = outOfBandId
      ? await t.modules.didcomm.connections.findAllByOutOfBandId(outOfBandId)
      : await t.modules.didcomm.connections.getAll()
    return records.map((c) => ({ id: c.id, state: c.state, theirLabel: c.theirLabel ?? null, outOfBandId: c.outOfBandId ?? null, createdAt: c.createdAt }))
  })
}

export async function getConnection(deps: ExchangeDeps, tenantId: string, id: string) {
  await assertTenantReady(deps, tenantId)
  return withTenant(deps, tenantId, async (t) => {
    const c = await t.modules.didcomm.connections.findById(id)
    if (!c) throw new ExchangeError(404, `connection ${id} not found`)
    return { id: c.id, state: c.state, theirLabel: c.theirLabel ?? null, outOfBandId: c.outOfBandId ?? null, createdAt: c.createdAt }
  })
}

export async function offerCredential(
  deps: ExchangeDeps,
  tenantId: string,
  input: { connectionId: string; credentialDefinitionObjectId: string; values: Record<string, string>; correlationId?: string }
) {
  await assertTenantReady(deps, tenantId)
  const [credDef] = await deps.db
    .select()
    .from(ledgerObjects)
    .where(and(eq(ledgerObjects.id, input.credentialDefinitionObjectId), eq(ledgerObjects.tenantId, tenantId), eq(ledgerObjects.kind, 'credential_definition')))
  if (!credDef) throw new ExchangeError(404, `credential definition ${input.credentialDefinitionObjectId} not found for tenant`)
  if (credDef.status !== 'published' || !credDef.unqualifiedId || !credDef.schemaObjectId) {
    throw new ExchangeError(409, `credential definition is ${credDef.status}, not published`)
  }
  const [schema] = await deps.db.select({ attributes: ledgerObjects.attributes, status: ledgerObjects.status }).from(ledgerObjects).where(eq(ledgerObjects.id, credDef.schemaObjectId))
  if (!schema?.attributes) throw new ExchangeError(500, 'published credential definition has no schema attributes')
  if (schema.status === 'deprecated' || credDef.status !== 'published') throw new ExchangeError(409, 'schema version is deprecated for new offers')

  const attributes = buildOfferAttributes(schema.attributes, input.values, Math.floor(Date.now() / 1000))
  const credentialDefinitionId = credDef.unqualifiedId

  return withTenant(deps, tenantId, async (t) => {
    // Announce before the call: Credo emits `offer-sent` inside it, before we can stamp the record.
    if (input.correlationId) deps.pendingCorrelations.announce(tenantId, 'credential', input.connectionId, input.correlationId)
    let record
    try {
      record = await t.modules.didcomm.credentials.offerCredential({
        connectionId: input.connectionId,
        protocolVersion: 'v1' as never,
        credentialFormats: { indy: { credentialDefinitionId, attributes } },
      })
    } catch (error) {
      if (input.correlationId) deps.pendingCorrelations.cancel(tenantId, 'credential', input.connectionId, input.correlationId)
      throw error
    }
    deps.logger.info({ tenantId, credentialExchangeId: record.id, threadId: record.threadId, correlationId: input.correlationId }, 'credential offered')
    return { credentialExchangeId: record.id, threadId: record.threadId, state: record.state }
  })
}

export async function requestProof(
  deps: ExchangeDeps,
  tenantId: string,
  input: { connectionId: string; name: string; groups: ProofGroupInput[]; correlationId?: string }
) {
  await assertTenantReady(deps, tenantId)
  const proofRequest = buildProofRequest(input.name, input.groups, Math.floor(Date.now() / 1000))
  return withTenant(deps, tenantId, async (t) => {
    if (input.correlationId) deps.pendingCorrelations.announce(tenantId, 'proof', input.connectionId, input.correlationId)
    let record
    try {
      record = await t.modules.didcomm.proofs.requestProof({
        connectionId: input.connectionId,
        protocolVersion: 'v1' as never,
        proofFormats: { indy: proofRequest },
      })
    } catch (error) {
      if (input.correlationId) deps.pendingCorrelations.cancel(tenantId, 'proof', input.connectionId, input.correlationId)
      throw error
    }
    deps.logger.info({ tenantId, proofExchangeId: record.id, threadId: record.threadId, correlationId: input.correlationId }, 'proof requested')
    return { proofExchangeId: record.id, threadId: record.threadId, state: record.state }
  })
}

export async function getCredentialExchange(deps: ExchangeDeps, tenantId: string, id: string) {
  return withTenant(deps, tenantId, async (t) => {
    const record = await t.modules.didcomm.credentials.findById(id)
    if (!record) throw new ExchangeError(404, `credential exchange ${id} not found`)
    // The offered cred def id (unqualified, as sent) lives in the offer format data, not on the record.
    const data = await t.modules.didcomm.credentials.getFormatData(id).catch(() => null)
    const offer = data?.offer?.indy as { cred_def_id?: string } | undefined
    const attributes = Object.fromEntries((record.credentialAttributes ?? []).map((a) => [a.name, a.value]))
    return {
      id: record.id,
      state: record.state,
      threadId: record.threadId,
      connectionId: record.connectionId ?? null,
      errorMessage: record.errorMessage ?? null,
      credentialDefinitionId: offer?.cred_def_id ?? null,
      attributes,
    }
  })
}

export async function getProofExchange(deps: ExchangeDeps, tenantId: string, id: string) {
  return withTenant(deps, tenantId, async (t) => {
    const record = await t.modules.didcomm.proofs.findById(id)
    if (!record) throw new ExchangeError(404, `proof exchange ${id} not found`)
    const data = record.state === 'done' ? await t.modules.didcomm.proofs.getFormatData(id).catch(() => null) : null
    const revealed = (data?.presentation?.indy as { requested_proof?: { revealed_attr_groups?: Record<string, { values: Record<string, { raw: string }> }> } } | undefined)
      ?.requested_proof?.revealed_attr_groups
    const disclosed: Record<string, Record<string, string>> = {}
    for (const [group, entry] of Object.entries(revealed ?? {})) {
      disclosed[group] = Object.fromEntries(Object.entries(entry.values).map(([name, v]) => [name, v.raw]))
    }
    return {
      id: record.id,
      state: record.state,
      threadId: record.threadId,
      connectionId: record.connectionId ?? null,
      isVerified: record.isVerified ?? null,
      errorMessage: record.errorMessage ?? null,
      disclosed,
    }
  })
}
