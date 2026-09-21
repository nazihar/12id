/**
 * Test plumbing. Database tests use TEST_DATABASE_URL (default: the Phase 2 local Docker Postgres)
 * and are skipped when it is unreachable, like the other services.
 */
import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { ensureDatabase, runMigrations } from '@12id/credo-base/postgres-migrate.ts'
import { pino } from 'pino'

import { type BiometricService, createBiometricService } from '../src/biometric.ts'
import { KeyRing } from '../src/crypto.ts'
import { type Database, createDatabase } from '../src/db/client.ts'
import * as schema from '../src/db/schema.ts'
import { mockProvider } from '../src/providers/mock.ts'
import type { BiometricProvider } from '../src/providers/types.ts'

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:spike-only@127.0.0.1:55432/biometric_test'
export const MASTER_KEY = randomBytes(32).toString('base64')

export const silentLogger = pino({ level: 'silent' }, new Writable({ write: (_c, _e, cb) => cb() }))

/** Captures log lines, for redaction tests. */
export function capturingLogger() {
  const lines: string[] = []
  const logger = pino({ level: 'info' }, new Writable({ write: (chunk, _e, cb) => { lines.push(chunk.toString()); cb() } }))
  return { logger, lines }
}

/** A JPEG-looking reference image (magic bytes + noise). The mock provider never inspects it. */
export function fakeJpeg(size = 400): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size)])
}

let shared: ReturnType<typeof createDatabase> | null | undefined

export async function testDatabase(): Promise<Database | null> {
  if (shared === undefined) {
    try {
      await ensureDatabase(TEST_DATABASE_URL)
      await runMigrations(TEST_DATABASE_URL, fileURLToPath(new URL('../drizzle', import.meta.url)))
      shared = createDatabase(TEST_DATABASE_URL)
    } catch {
      shared = null
    }
  }
  if (!shared) return null
  for (const table of [schema.results, schema.sessions, schema.checks, schema.providerConfigs, schema.tenantKeys]) await shared.db.delete(table)
  return shared.db
}

export async function closeTestDatabase() {
  if (shared) await shared.pool.end()
  shared = undefined
}

export function testService(db: Database, providers: BiometricProvider[] = [mockProvider], logger = silentLogger): BiometricService {
  return createBiometricService({ db, keyRing: new KeyRing(MASTER_KEY), providers: new Map(providers.map((p) => [p.id, p])), logger })
}

/** A tenant with the mock provider configured and tested. */
export async function mockTenant(service: BiometricService, tenantId = 'tenant-a') {
  await service.putTenantProvider(tenantId, 'mock', {})
  await service.testTenantProvider(tenantId)
  return tenantId
}

export const defaultCheck = (tenantId: string, overrides: Partial<{ maxAttempts: number; ttlSeconds: number; minMatchScore: number; minLivenessScore: number }> = {}) => ({
  tenantId,
  purpose: 'issue' as const,
  referenceImage: fakeJpeg().toString('base64'),
  thresholds: { minLivenessScore: overrides.minLivenessScore ?? 90, minMatchScore: overrides.minMatchScore ?? 90 },
  maxAttempts: overrides.maxAttempts ?? 3,
  ttlSeconds: overrides.ttlSeconds ?? 1800,
})
