/**
 * Master key rotation (Phase 9 W4, infra/runbooks/key-rotation.md): re-wraps every tenant's data key
 * from the current master key to the next one, in one transaction. The data keys themselves, and so
 * every stored vendor configuration and reference image, are unchanged.
 *
 * Run with biometric-service stopped (a check created mid-rotation would wrap with the old key):
 *   infra/scripts/rotate-biometric-key.sh
 * which pipes the next key (BIOMETRIC_MASTER_KEY_NEXT, base64) on stdin to
 *   node biometric-service/src/rotate-master-key.ts
 * The current key and the database come from the usual configuration (BIOMETRIC_MASTER_KEY_FILE,
 * DATABASE_URL). Re-running after a completed rotation is safe: rows the next key already opens are
 * skipped, and a row that neither key opens aborts everything.
 */
import { eq } from 'drizzle-orm'

import { KeyRing } from './crypto.ts'
import type { Database } from './db/client.ts'
import { tenantKeys } from './db/schema.ts'

export interface RotationReport {
  rewrapped: number
  alreadyRotated: number
}

export async function rotateMasterKey(db: Database, current: KeyRing, next: KeyRing): Promise<RotationReport> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(tenantKeys).for('update')
    const report: RotationReport = { rewrapped: 0, alreadyRotated: 0 }
    for (const row of rows) {
      let dataKey: Buffer
      try {
        dataKey = current.unwrap(row.tenantId, row.wrappedKey)
      } catch {
        // Not the current key: either already rotated (a re-run) or a key we do not hold.
        next.unwrap(row.tenantId, row.wrappedKey)
        report.alreadyRotated += 1
        continue
      }
      const wrapped = next.wrap(row.tenantId, dataKey)
      if (!next.unwrap(row.tenantId, wrapped).equals(dataKey)) throw new Error(`re-wrap check failed for tenant ${row.tenantId}`)
      await tx.update(tenantKeys).set({ wrappedKey: wrapped }).where(eq(tenantKeys.tenantId, row.tenantId))
      report.rewrapped += 1
    }
    return report
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

if (import.meta.main) {
  const { loadConfig } = await import('./config.ts')
  const { createDatabase } = await import('./db/client.ts')
  const { createLogger } = await import('./logger.ts')
  const config = loadConfig()
  const logger = createLogger({ name: 'biometric-rotate-master-key', level: config.LOG_LEVEL })
  const nextKey = await readStdin()
  if (Buffer.from(nextKey, 'base64').length !== 32) {
    logger.error('the next master key on stdin must be 32 bytes, base64')
    process.exit(1)
  }
  if (nextKey === config.BIOMETRIC_MASTER_KEY) {
    logger.error('the next master key equals the current one')
    process.exit(1)
  }
  const { pool, db } = createDatabase(config.DATABASE_URL)
  try {
    const report = await rotateMasterKey(db, new KeyRing(config.BIOMETRIC_MASTER_KEY), new KeyRing(nextKey))
    logger.info(report, 'tenant data keys re-wrapped with the next master key')
    process.exitCode = 0
  } catch (error) {
    logger.error({ err: error }, 'rotation failed, nothing changed')
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
