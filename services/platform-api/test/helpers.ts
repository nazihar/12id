/**
 * Test plumbing. Pure tests need nothing; database tests use TEST_DATABASE_URL (default: the
 * Phase 2 local Docker Postgres) and are skipped when it is unreachable.
 */
import { Writable } from 'node:stream'

import { pino } from 'pino'

import { type AgentClient, type AgentLedgerObject, type OutboxRow } from '../src/agent-client.ts'
import { type PlatformConfig } from '../src/config.ts'
import { type Database, createDatabase } from '../src/db/client.ts'
import { ensureDatabase, runMigrations } from '../src/db/migrate.ts'
import * as schema from '../src/db/schema.ts'

export const silentLogger = pino(
  { level: 'silent' },
  new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
)

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:spike-only@127.0.0.1:55432/platform_api_test'

let shared: { db: Database; pool: ReturnType<typeof createDatabase>['pool'] } | null | undefined

/** Migrated test database, or null when Postgres is not reachable. Tables are truncated per call. */
export async function testDatabase(): Promise<{ db: Database; close: () => Promise<void> } | null> {
  if (shared === undefined) {
    try {
      await ensureDatabase(TEST_DATABASE_URL)
      await runMigrations(TEST_DATABASE_URL)
      shared = createDatabase(TEST_DATABASE_URL)
    } catch {
      shared = null
    }
  }
  if (!shared) return null
  const tables = [schema.consoleAudit, schema.webhookDeliveries, schema.webhookEndpoints, schema.idempotencyKeys, schema.proofTemplates, schema.proofs, schema.credentials, schema.connections, schema.wallets, schema.apiKeys, schema.outboxCursor, schema.tenants]
  for (const table of tables) await shared.db.delete(table)
  const pool = shared.pool
  return { db: shared.db, close: async () => void pool }
}

export const testConfig: PlatformConfig = {
  LOG_LEVEL: 'silent',
  HOST: '127.0.0.1',
  PORT: 0,
  PUBLIC_URL: 'https://api.test',
  DATABASE_URL: TEST_DATABASE_URL,
  AGENT_API_URL: 'http://agent.test',
  AGENT_API_TOKEN: 'a'.repeat(40),
  MEDIATOR_ADMIN_URL: 'http://mediator.test',
  MEDIATOR_ADMIN_TOKEN: 'm'.repeat(40),
  MEDIATOR_DRIZZLE_URL: TEST_DATABASE_URL,
  MEDIATOR_WEBHOOK_SECRET: 'w'.repeat(40),
  PLATFORM_ADMIN_TOKEN: 'p'.repeat(40),
  CONSOLE_TOKEN: 'c'.repeat(40),
  INDY_NAMESPACE: 'twelveid:staging',
  GENESIS_URL: 'https://genesis.test/v1/pool_transactions_genesis',
  GENESIS_SHA256: '0'.repeat(64),
  GENESIS_SIGNATURE_URL: 'https://genesis.test/v1/pool_transactions_genesis.minisig',
  GENESIS_SIGNING_PUBLIC_KEY: 'RWQtest',
  VDR_PROXY_URL: 'https://vdr.test',
  OUTBOX_POLL_MS: 1000,
  OUTBOX_BATCH: 100,
  WEBHOOK_POLL_MS: 1000,
  WEBHOOK_TIMEOUT_MS: 1000,
  WEBHOOK_MAX_ATTEMPTS: 3,
  WAKE_DEBOUNCE_MS: 30_000,
  IDEMPOTENCY_TTL_MS: 60_000,
  DRAIN_DEADLINE_MS: 1000,
}

export const sampleCatalogue: AgentLedgerObject[] = [
  { id: 'schema-1', kind: 'schema', name: 'employee-badge', version: '1.0', tag: '', status: 'deprecated', qualifiedId: 'did:indy:x/anoncreds/v0/SCHEMA/employee-badge/1.0', unqualifiedId: 'ABC:2:employee-badge:1.0', lastError: null, attributes: ['name', 'department', 'employeeNumber', 'expiresAt'] },
  { id: 'cd-1', kind: 'credential_definition', name: 'employee-badge', version: '1.0', tag: 'default', status: 'deprecated', qualifiedId: 'q1', unqualifiedId: 'ABC:3:CL:10:default', lastError: null, schemaObjectId: 'schema-1' },
  { id: 'schema-2', kind: 'schema', name: 'employee-badge', version: '1.1', tag: '', status: 'published', qualifiedId: 'q2s', unqualifiedId: 'ABC:2:employee-badge:1.1', lastError: null, attributes: ['name', 'department', 'employeeNumber', 'title', 'expiresAt'] },
  { id: 'cd-2', kind: 'credential_definition', name: 'employee-badge', version: '1.1', tag: 'default', status: 'published', qualifiedId: 'q2', unqualifiedId: 'ABC:3:CL:12:default', lastError: null, schemaObjectId: 'schema-2' },
  { id: 'cd-3', kind: 'credential_definition', name: 'visitor-pass', version: '1.0', tag: 'default', status: 'published', qualifiedId: 'q3', unqualifiedId: 'ABC:3:CL:14:default', lastError: null, schemaObjectId: 'schema-3' },
]

/** In-memory agent-service double: records calls, serves the sample catalogue and an outbox feed. */
export function fakeAgent(overrides: Partial<AgentClient> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const outbox: OutboxRow[] = []
  const record = <T>(method: string, value: T) => (...args: unknown[]) => {
    calls.push({ method, args })
    return Promise.resolve(value)
  }
  const client: AgentClient = {
    createTenant: record('createTenant', { tenantId: 'agent-tenant-1', status: 'pending' }),
    onboardTenant: record('onboardTenant', { tenantId: 'agent-tenant-1', status: 'ready', did: 'did:indy:twelveid:staging:Abc' }),
    getTenant: record('getTenant', { tenantId: 'agent-tenant-1', status: 'ready', did: 'did:indy:twelveid:staging:Abc' }),
    publishSchema: record('publishSchema', sampleCatalogue[2]),
    publishCredentialDefinition: record('publishCredentialDefinition', sampleCatalogue[3]),
    listCatalogue: record('listCatalogue', sampleCatalogue),
    setSchemaDeprecated: record('setSchemaDeprecated', { status: 'deprecated' }),
    createInvitation: record('createInvitation', { outOfBandId: 'oob-1', invitationUrl: 'https://agent.test?oob=abc', multiUse: false }),
    listConnections: record('listConnections', []),
    getConnection: record('getConnection', { id: 'conn-1', state: 'completed', theirLabel: 'phone', outOfBandId: 'oob-1', createdAt: new Date().toISOString() }),
    offerCredential: record('offerCredential', { credentialExchangeId: 'cred-1', threadId: 'thread-c1', state: 'offer-sent' }),
    getCredential: record('getCredential', { id: 'cred-1', state: 'offer-sent', threadId: 'thread-c1', connectionId: 'conn-1', errorMessage: null, credentialDefinitionId: 'ABC:3:CL:12:default', attributes: { name: 'Ada' } }),
    requestProof: record('requestProof', { proofExchangeId: 'proof-1', threadId: 'thread-p1', state: 'request-sent' }),
    getProof: record('getProof', { id: 'proof-1', state: 'done', threadId: 'thread-p1', connectionId: 'conn-1', isVerified: true, errorMessage: null, disclosed: { employee: { name: 'Ada' } } }),
    readOutbox: async (afterId, limit) => {
      calls.push({ method: 'readOutbox', args: [afterId, limit] })
      return { rows: outbox.filter((r) => r.id > afterId).slice(0, limit) }
    },
    ackOutbox: record('ackOutbox', { acknowledged: 0 }),
    healthy: async () => true,
    ...overrides,
  }
  return { client, calls, outbox }
}
