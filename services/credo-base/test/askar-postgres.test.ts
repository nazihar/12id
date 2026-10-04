import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { postgresStore } from '../src/askar-postgres.ts'

const base = { id: 'agent_root', key: 'k'.repeat(43), host: 'agent-postgres:5432', user: 'agent_service', password: 'secret' }
const database = (options: Parameters<typeof postgresStore>[0]) => postgresStore(options).database as unknown as { config: Record<string, unknown>; credentials: Record<string, string> }

describe('postgresStore', () => {
  it('leaves the pool size to Askar unless it is set (review L9)', () => {
    assert.deepEqual(database(base).config, { host: 'agent-postgres:5432', connectTimeout: 10 })
  })

  it('passes maxConnections through to Askar', () => {
    assert.equal(database({ ...base, maxConnections: 40 }).config.maxConnections, 40)
  })

  it('uses the service account for provisioning unless an admin account is given', () => {
    assert.equal(database(base).credentials.adminAccount, 'agent_service')
    assert.equal(database({ ...base, adminUser: 'postgres', adminPassword: 'p' }).credentials.adminAccount, 'postgres')
  })
})
