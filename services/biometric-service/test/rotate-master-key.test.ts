import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, beforeEach, describe, it } from 'node:test'

import { createBiometricService } from '../src/biometric.ts'
import { KeyRing } from '../src/crypto.ts'
import type { Database } from '../src/db/client.ts'
import { tenantKeys } from '../src/db/schema.ts'
import { mockProvider } from '../src/providers/mock.ts'
import { rotateMasterKey } from '../src/rotate-master-key.ts'
import { closeTestDatabase, MASTER_KEY, mockTenant, silentLogger, testDatabase, testService } from './helpers.ts'

const serviceWith = (db: Database, masterKey: string) =>
  createBiometricService({ db, keyRing: new KeyRing(masterKey), providers: new Map([[mockProvider.id, mockProvider]]), logger: silentLogger })

describe('master key rotation (database)', async () => {
  let db: Database | null = null
  beforeEach(async () => {
    db = await testDatabase()
  })
  after(closeTestDatabase)

  const skip = () => {
    if (!db) {
      console.log('# skipped: TEST_DATABASE_URL unreachable')
      return true
    }
    return false
  }

  it('re-wraps every data key: stored configuration opens with the next key only', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    await mockTenant(service, 'tenant-a')
    await mockTenant(service, 'tenant-b')
    const nextKey = randomBytes(32).toString('base64')

    const report = await rotateMasterKey(db!, new KeyRing(MASTER_KEY), new KeyRing(nextKey))
    assert.deepEqual(report, { rewrapped: 2, alreadyRotated: 0 })

    // The provider configuration is encrypted with the (unchanged) data key: readable with the next key.
    const rotated = serviceWith(db!, nextKey)
    assert.equal((await rotated.testTenantProvider('tenant-a')).status, 'ok')
    assert.equal((await rotated.getTenantProvider('tenant-b')).provider?.id, 'mock')
    await assert.rejects(serviceWith(db!, MASTER_KEY).testTenantProvider('tenant-a'))
  })

  it('a re-run skips rows already rotated', async (t) => {
    if (skip()) return t.skip()
    await mockTenant(testService(db!), 'tenant-a')
    const nextKey = randomBytes(32).toString('base64')
    await rotateMasterKey(db!, new KeyRing(MASTER_KEY), new KeyRing(nextKey))
    assert.deepEqual(await rotateMasterKey(db!, new KeyRing(MASTER_KEY), new KeyRing(nextKey)), { rewrapped: 0, alreadyRotated: 1 })
  })

  it('a row neither key opens aborts the whole rotation and changes nothing', async (t) => {
    if (skip()) return t.skip()
    const service = testService(db!)
    await mockTenant(service, 'tenant-a')
    await mockTenant(service, 'tenant-b')
    // tenant-b's key wrapped by some other master key.
    const stranger = new KeyRing(randomBytes(32).toString('base64'))
    const { wrapped } = stranger.newWrappedDataKey('tenant-b')
    const { eq } = await import('drizzle-orm')
    await db!.update(tenantKeys).set({ wrappedKey: wrapped }).where(eq(tenantKeys.tenantId, 'tenant-b'))
    const before = await db!.select().from(tenantKeys)

    await assert.rejects(rotateMasterKey(db!, new KeyRing(MASTER_KEY), new KeyRing(randomBytes(32).toString('base64'))))
    const afterRows = await db!.select().from(tenantKeys)
    assert.deepEqual(afterRows.map((r) => r.wrappedKey.toString('hex')).sort(), before.map((r) => r.wrappedKey.toString('hex')).sort())
  })
})
