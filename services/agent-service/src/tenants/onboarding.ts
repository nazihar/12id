/**
 * Tenant onboarding (A3): Credo tenant → did:indy key in the tenant wallet → endorsed, role-less
 * NYM on the ledger. Schemas and cred defs follow in the catalogue (A4).
 *
 * A state machine persisted in `tenants`; `onboardTenant` resumes from the stored status, so a
 * crash at any step is recovered by calling it again (8-phase-2-findings T2):
 *
 *   pending      → create the DID (Credo saves the DID record here, before the NYM exists)
 *   did_created  → bind tenant→nym at the endorser, get the NYM request signed
 *   nym_endorsed → submit, unless GET_NYM shows it was already written
 *   nym_written  → GET_NYM confirmed: exists, role-less, expected verkey
 *   ready
 *
 * Two runs for one tenant must never overlap: each would create its own DID, the endorser binds
 * whichever arrives first, and the row can end up naming a DID that is never written (staging,
 * 2026-09-15: `POST /tenants` starts a run and platform-api calls `/onboard` right after). Calls
 * in this process join the run in flight, and every transition is a compare-and-set on the status
 * the run read, so a run that lost the row stops instead of overwriting it.
 */
import type { IndyVdrDidCreateOptions } from '@credo-ts/indy-vdr'
import { IndyVdrPoolService } from '@credo-ts/indy-vdr'
import { GetNymRequest } from '@hyperledger/indy-vdr-nodejs'
import { and, eq } from 'drizzle-orm'
import type { Logger as PinoLogger } from 'pino'

import type { RootAgent } from '../agent/root-agent.ts'
import type { Database } from '../db/client.ts'
import { type TenantStatus, tenants } from '../db/schema.ts'
import type { EndorserClient } from '../endorser/endorser-client.ts'
import { singleFlight } from './single-flight.ts'

export interface OnboardingDeps {
  agent: RootAgent
  db: Database
  endorser: EndorserClient
  endorserDid: string
  logger: PinoLogger
}

type TenantRow = typeof tenants.$inferSelect

interface NymOnLedger {
  verkey: string
  role: string | null
}

async function readNym(agent: RootAgent, namespace: string, nym: string): Promise<NymOnLedger | null> {
  const pool = agent.dependencyManager.resolve(IndyVdrPoolService).getPoolForNamespace(namespace)
  const response = await pool.submitRequest(new GetNymRequest({ dest: nym }))
  const data = (response.result as { data?: string | null }).data
  return data ? (JSON.parse(data) as NymOnLedger) : null
}

function namespaceOf(did: string): string {
  // did:indy:<namespace, possibly with one sub-namespace>:<nym>
  return did.split(':').slice(2, -1).join(':')
}

export async function createTenantRecord(deps: OnboardingDeps, label: string): Promise<string> {
  const record = await deps.agent.modules.tenants.createTenant({ config: { label } })
  await deps.db.insert(tenants).values({ id: record.id, label, status: 'pending' })
  deps.logger.info({ tenantId: record.id, label }, 'tenant created')
  return record.id
}

export class OnboardingConflictError extends Error {
  public constructor(tenantId: string, expected: TenantStatus) {
    super(`tenant ${tenantId} left status ${expected} during onboarding; another run is progressing it`)
    this.name = 'OnboardingConflictError'
  }
}

const onboardingFlights = singleFlight<TenantRow>()

export function onboardTenant(deps: OnboardingDeps, tenantId: string): Promise<TenantRow> {
  return onboardingFlights(tenantId, () => runOnboarding(deps, tenantId))
}

async function runOnboarding(deps: OnboardingDeps, tenantId: string): Promise<TenantRow> {
  const log = deps.logger.child({ tenantId, flow: 'onboarding' })

  const load = async () => {
    const [row] = await deps.db.select().from(tenants).where(eq(tenants.id, tenantId))
    if (!row) throw new Error(`tenant ${tenantId} has no onboarding row`)
    return row
  }
  const advance = async (from: TenantStatus, status: TenantStatus, fields: Partial<TenantRow> = {}) => {
    const updated = await deps.db
      .update(tenants)
      .set({ ...fields, status, lastError: null, updatedAt: new Date() })
      .where(and(eq(tenants.id, tenantId), eq(tenants.status, from)))
      .returning({ id: tenants.id })
    if (updated.length === 0) throw new OnboardingConflictError(tenantId, from)
    log.info({ status }, 'onboarding advanced')
  }

  let row = await load()
  try {
    while (row.status !== 'ready') {
      switch (row.status) {
        case 'pending': {
          const created = await deps.agent.modules.tenants.withTenantAgent({ tenantId }, (tenant) =>
            tenant.dids.create<IndyVdrDidCreateOptions>({
              method: 'indy',
              options: { endorserDid: deps.endorserDid, endorserMode: 'external' },
            })
          )
          const state = created.didState as { state: string; did?: string; nymRequest?: string; reason?: string }
          if (state.state !== 'action' || !state.did || !state.nymRequest) {
            throw new Error(`DID creation did not return an endorsement action: ${state.reason ?? state.state}`)
          }
          await advance('pending', 'did_created', { did: state.did, nym: state.did.split(':').pop() as string, nymRequest: state.nymRequest })
          break
        }

        case 'did_created': {
          if (!row.nym || !row.nymRequest) throw new Error('did_created without nym or nymRequest')
          await deps.endorser.bindTenant(tenantId, row.nym)
          const endorsed = await deps.endorser.endorse({ tenantId, kind: 'nym', request: row.nymRequest })
          await advance('did_created', 'nym_endorsed', { endorsedNymRequest: endorsed })
          break
        }

        case 'nym_endorsed': {
          if (!row.did || !row.nym || !row.endorsedNymRequest) throw new Error('nym_endorsed without did, nym or endorsed request')
          const already = await readNym(deps.agent, namespaceOf(row.did), row.nym)
          if (!already) {
            const endorsedNymRequest = row.endorsedNymRequest
            const did = row.did
            const submitted = await deps.agent.modules.tenants.withTenantAgent({ tenantId }, (tenant) =>
              tenant.dids.create<IndyVdrDidCreateOptions>({
                did,
                options: { endorserMode: 'external', endorsedTransaction: { nymRequest: endorsedNymRequest } },
              })
            )
            const state = submitted.didState as { state: string; reason?: string }
            if (state.state !== 'finished') throw new Error(`NYM submission failed: ${state.reason ?? state.state}`)
          } else {
            log.info({ nym: row.nym }, 'NYM already on the ledger; skipping submission')
          }
          await advance('nym_endorsed', 'nym_written')
          break
        }

        case 'nym_written': {
          if (!row.did || !row.nym || !row.nymRequest) throw new Error('nym_written without did, nym or request')
          const onLedger = await readNym(deps.agent, namespaceOf(row.did), row.nym)
          const expectedVerkey = (JSON.parse(row.nymRequest) as { operation?: { verkey?: string } }).operation?.verkey
          if (!onLedger) throw new Error(`NYM ${row.nym} not found on the ledger`)
          if (onLedger.role !== null && onLedger.role !== undefined) throw new Error(`tenant NYM has ledger role ${onLedger.role}`)
          if (expectedVerkey && onLedger.verkey !== expectedVerkey) throw new Error('ledger verkey does not match the tenant key')
          await advance('nym_written', 'ready')
          break
        }

        case 'failed':
          throw new Error('tenant onboarding is marked failed; operator action required')
      }
      row = await load()
    }
    return row
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Status stays where it was, so the next call resumes at the failed step.
    await deps.db.update(tenants).set({ lastError: message, updatedAt: new Date() }).where(eq(tenants.id, tenantId))
    log.error({ err: error, status: row.status }, 'onboarding step failed')
    throw error
  }
}
