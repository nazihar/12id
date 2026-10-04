/**
 * BETTER_AUTH_SECRET rotation, step 2 (Phase 9 W4, infra/runbooks/key-rotation.md): re-encrypts every
 * stored TOTP secret under the current secret version, so the previous secret can be removed. The
 * console keeps running: Better Auth reads both forms while BETTER_AUTH_SECRET_PREVIOUS is set.
 * Backup codes are stored as plain JSON in this console (no `storeBackupCodes`), so they need nothing.
 *
 *   infra/scripts/deploy.sh console run --rm console-reencrypt
 *
 * Idempotent: rows already in the current version are skipped. All rows change in one transaction, and
 * each new value is decrypted again before commit.
 */
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import pg from 'pg'

import { authSecretConfig, type AuthSecretInput } from '../src/server/auth-secrets.server.ts'
import { resolveFileEnv } from '../src/server/file-env.server.ts'

export async function reencryptTwoFactorSecrets(client: pg.ClientBase, env: AuthSecretInput) {
  if (env.BETTER_AUTH_SECRET_VERSION === 0) throw new Error('BETTER_AUTH_SECRET_VERSION is 0: there is no versioned secret to move to')
  const key = authSecretConfig(env)
  const current = `$ba$${env.BETTER_AUTH_SECRET_VERSION}$`
  const report = { reencrypted: 0, alreadyCurrent: 0 }
  await client.query('begin')
  try {
    const { rows } = await client.query<{ id: string; secret: string }>('select id, secret from two_factor for update')
    for (const row of rows) {
      if (row.secret.startsWith(current)) {
        report.alreadyCurrent += 1
        continue
      }
      const plain = await symmetricDecrypt({ key, data: row.secret })
      const next = await symmetricEncrypt({ key, data: plain })
      if ((await symmetricDecrypt({ key, data: next })) !== plain) throw new Error(`re-encryption check failed for ${row.id}`)
      await client.query('update two_factor set secret = $1 where id = $2', [next, row.id])
      report.reencrypted += 1
    }
    await client.query('commit')
    return report
  } catch (error) {
    await client.query('rollback')
    throw error
  }
}

if (import.meta.main) {
  const env = resolveFileEnv(process.env)
  const version = Number(env.BETTER_AUTH_SECRET_VERSION ?? '0')
  if (!env.DATABASE_URL || !env.BETTER_AUTH_SECRET) throw new Error('DATABASE_URL and BETTER_AUTH_SECRET are required')
  const client = new pg.Client({ connectionString: env.DATABASE_URL })
  await client.connect()
  try {
    const report = await reencryptTwoFactorSecrets(client, {
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      BETTER_AUTH_SECRET_PREVIOUS: env.BETTER_AUTH_SECRET_PREVIOUS || undefined,
      BETTER_AUTH_SECRET_VERSION: version,
    })
    console.log(JSON.stringify({ ...report, version }))
  } catch (error) {
    console.error(`re-encryption failed, nothing changed: ${(error as Error).message}`)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}
