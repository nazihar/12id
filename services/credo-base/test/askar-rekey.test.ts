/**
 * Askar store rekey against a real Postgres (TEST_DATABASE_URL's server; skipped when unreachable).
 */
import '@openwallet-foundation/askar-nodejs'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, describe, it } from 'node:test'

import { KdfMethod, Key, KeyAlgorithm, Store, StoreKeyMethod } from '@openwallet-foundation/askar-nodejs'
import pg from 'pg'

import { rekeyStore, storeUri } from '../src/askar-rekey.ts'

const server = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:spike-only@127.0.0.1:55432/postgres')
const conn = { host: `${server.hostname}:${server.port}`, user: decodeURIComponent(server.username), password: decodeURIComponent(server.password) }
const storeId = `rekey_test_${Date.now()}`
const uri = `${storeUri({ storeId, ...conn })}?admin_account=${encodeURIComponent(conn.user)}&admin_password=${encodeURIComponent(conn.password)}`
const keyMethod = () => new StoreKeyMethod(KdfMethod.Argon2IMod)
const newKey = () => randomBytes(32).toString('base64url')

async function reachable() {
  const client = new pg.Client({ connectionString: server.toString(), connectionTimeoutMillis: 2_000 })
  try {
    await client.connect()
    await client.end()
    return true
  } catch {
    return false
  }
}

describe('askar store rekey (database)', async () => {
  const available = await reachable()
  after(async () => {
    if (available) await Store.remove(uri).catch(() => undefined)
  })

  it('re-encrypts every profile under the next key; the current key stops opening the store', async (t) => {
    if (!available) return t.skip('TEST_DATABASE_URL unreachable')
    const currentKey = newKey()
    const nextKey = newKey()
    const store = await Store.provision({ uri, recreate: true, keyMethod: keyMethod(), passKey: currentKey, profile: 'root' })
    await store.createProfile('tenant-a')
    const signing = Key.generate(KeyAlgorithm.Ed25519)
    for (const profile of ['root', 'tenant-a']) {
      const scoped = await store.session(profile).open()
      await scoped.insert({ category: 'record', name: `r-${profile}`, value: `value-${profile}` })
      await scoped.insertKey({ name: `k-${profile}`, key: signing })
      await scoped.close()
    }
    await store.close()

    assert.equal(await rekeyStore({ storeId, ...conn, currentKey, nextKey }, uri), 'rekeyed')

    const reopened = await Store.open({ uri, keyMethod: keyMethod(), passKey: nextKey })
    for (const profile of ['root', 'tenant-a']) {
      const session = await reopened.session(profile).open()
      const entry = await session.fetch({ category: 'record', name: `r-${profile}` })
      assert.equal(String(entry?.value), `value-${profile}`)
      const key = await session.fetchKey({ name: `k-${profile}` })
      assert.deepEqual(key?.key.publicBytes, signing.publicBytes)
      await session.close()
    }
    await reopened.close()

    // A re-run with the same pair is recognised, not an error.
    assert.equal(await rekeyStore({ storeId, ...conn, currentKey, nextKey }, uri), 'already-rotated')
  })

  it('refuses when neither key opens the store, and when the keys are equal', async (t) => {
    if (!available) return t.skip('TEST_DATABASE_URL unreachable')
    await assert.rejects(rekeyStore({ storeId, ...conn, currentKey: newKey(), nextKey: newKey() }, uri), /opens with neither/)
    const same = newKey()
    await assert.rejects(rekeyStore({ storeId, ...conn, currentKey: same, nextKey: same }, uri), /equals the current/)
  })
})
