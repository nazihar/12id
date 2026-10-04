import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadConfig } from '../src/config.ts'

const valid = {
  INDY_NAMESPACE: 'twelveid:staging',
  GENESIS_URL: 'https://genesis.12id.naziharitsolution.com/v1/pool_transactions_genesis',
  GENESIS_SHA256: '6ab9bc1a3ba5ff257454ca8500a41d45756cd02c3db6c280bde51c7b363a835a',
  ENDORSER_DID: 'did:indy:twelveid:staging:9WnSruRkr6b3V7XX9zPjka',
  ASKAR_STORE_ID: 'endorser',
  ASKAR_STORE_KEY: 'k'.repeat(43),
  POSTGRES_HOST: 'postgres:5432',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: 'secret',
  DATABASE_URL: 'postgresql://postgres:secret@postgres:5432/endorser_service',
  INTERNAL_TOKEN: 't'.repeat(40),
}

describe('loadConfig', () => {
  it('accepts the staging endorser and applies defaults', () => {
    const config = loadConfig(valid)
    assert.equal(config.PORT, 3420)
    assert.equal(config.HOST, '127.0.0.1')
  })

  it('rejects an endorser DID outside the namespace', () => {
    assert.throws(() => loadConfig({ ...valid, ENDORSER_DID: 'did:indy:von:9WnSruRkr6b3V7XX9zPjka' }), /not in INDY_NAMESPACE/)
  })

  it('takes the Askar pool size from the environment (review L9)', () => {
    assert.equal(loadConfig(valid).ASKAR_MAX_CONNECTIONS, undefined)
    assert.equal(loadConfig({ ...valid, ASKAR_MAX_CONNECTIONS: '20' }).ASKAR_MAX_CONNECTIONS, 20)
  })

  it('rejects a short internal token', () => {
    assert.throws(() => loadConfig({ ...valid, INTERNAL_TOKEN: 'short' }), /INTERNAL_TOKEN/)
  })
})
