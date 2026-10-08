import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadConfig } from '../src/config.ts'

const valid = {
  INDY_NAMESPACE: 'twelveid:staging',
  GENESIS_URL: 'https://genesis.12id.naziharitsolution.com/v1/pool_transactions_genesis',
  GENESIS_SHA256: '6ab9bc1a3ba5ff257454ca8500a41d45756cd02c3db6c280bde51c7b363a835a',
  DIDCOMM_ENDPOINT: 'https://agent.12id.naziharitsolution.com',
  DIDCOMM_PORT: '3400',
  ASKAR_STORE_ID: 'agent_root',
  ASKAR_STORE_KEY: 'k'.repeat(43),
  POSTGRES_HOST: 'agent-postgres:5432',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: 'secret',
  DATABASE_URL: 'postgresql://postgres:secret@agent-postgres:5432/agent_service',
  ENDORSER_DID: 'did:indy:twelveid:staging:9WnSruRkr6b3V7XX9zPjka',
  ENDORSER_SERVICE_URL: 'http://endorser-service:3420',
  ENDORSER_SERVICE_TOKEN: 't'.repeat(40),
}

describe('loadConfig', () => {
  it('accepts a complete staging environment and applies defaults', () => {
    const config = loadConfig(valid)
    assert.equal(config.DIDCOMM_PORT, 3400)
    assert.deepEqual(config.AGENT_ROLES, ['issuer', 'verifier'])
    assert.equal(config.PROCESS_MESSAGES_CONCURRENTLY, false)
    assert.equal(config.DRAIN_DEADLINE_MS, 15_000)
    assert.equal(config.INDY_NETWORK_PRODUCTION, false)
  })

  it('takes isProduction for the Indy network from the environment (review I1)', () => {
    assert.equal(loadConfig({ ...valid, INDY_NETWORK_PRODUCTION: 'true' }).INDY_NETWORK_PRODUCTION, true)
    assert.throws(() => loadConfig({ ...valid, INDY_NETWORK_PRODUCTION: 'maybe' }), /INDY_NETWORK_PRODUCTION/)
  })

  it('rejects namespaces Credo cannot parse', () => {
    for (const namespace of ['12id', 'TwelveId', 'a:b:c']) {
      assert.throws(() => loadConfig({ ...valid, INDY_NAMESPACE: namespace }), /INDY_NAMESPACE/, namespace)
    }
  })

  it('reports every problem at once', () => {
    const { ASKAR_STORE_KEY: _key, GENESIS_SHA256: _sha, ...missing } = valid
    assert.throws(() => loadConfig({ ...missing, POSTGRES_HOST: 'agent-postgres' }), (error: Error) => {
      assert.match(error.message, /ASKAR_STORE_KEY/)
      assert.match(error.message, /GENESIS_SHA256/)
      assert.match(error.message, /POSTGRES_HOST must be host:port/)
      return true
    })
  })

  it('takes the Askar pool size from the environment, or leaves Askar its default (review L9)', () => {
    assert.equal(loadConfig(valid).ASKAR_MAX_CONNECTIONS, undefined)
    // Compose passes an unset setting as an empty string.
    assert.equal(loadConfig({ ...valid, ASKAR_MAX_CONNECTIONS: '' }).ASKAR_MAX_CONNECTIONS, undefined)
    assert.equal(loadConfig({ ...valid, ASKAR_MAX_CONNECTIONS: '40' }).ASKAR_MAX_CONNECTIONS, 40)
    assert.throws(() => loadConfig({ ...valid, ASKAR_MAX_CONNECTIONS: '0' }), /ASKAR_MAX_CONNECTIONS/)
  })

  it('runs the message purge every minute unless told otherwise; 0 turns it off', () => {
    assert.equal(loadConfig(valid).MESSAGE_PURGE_INTERVAL_MS, 60_000)
    assert.equal(loadConfig({ ...valid, MESSAGE_PURGE_INTERVAL_MS: '0' }).MESSAGE_PURGE_INTERVAL_MS, 0)
    assert.throws(() => loadConfig({ ...valid, MESSAGE_PURGE_INTERVAL_MS: '-1' }), /MESSAGE_PURGE_INTERVAL_MS/)
  })

  it('parses roles and the concurrency flag', () => {
    const config = loadConfig({ ...valid, AGENT_ROLES: 'verifier', PROCESS_MESSAGES_CONCURRENTLY: 'true' })
    assert.deepEqual(config.AGENT_ROLES, ['verifier'])
    assert.equal(config.PROCESS_MESSAGES_CONCURRENTLY, true)
    assert.throws(() => loadConfig({ ...valid, AGENT_ROLES: 'endorser' }), /AGENT_ROLES/)
  })
})
