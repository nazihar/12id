import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'

import { reencryptTwoFactorSecrets } from '../scripts/reencrypt-2fa'
import { authSecretConfig, authSecretOptions } from '../src/server/auth-secrets.server'
import { serverEnv } from '../src/server/env.server'

const v0 = 'a'.repeat(40)
const v1 = 'b'.repeat(40)
const v2 = 'c'.repeat(40)

/** Just enough of pg.Client for the script: one two_factor table in memory. */
function fakeClient(rows: Array<{ id: string; secret: string }>) {
  let staged = rows.map((r) => ({ ...r }))
  const client = {
    async query(sql: string, params?: string[]) {
      if (sql === 'begin') staged = rows.map((r) => ({ ...r }))
      else if (sql === 'commit') rows.splice(0, rows.length, ...staged)
      else if (sql.startsWith('select')) return { rows: staged.map((r) => ({ ...r })) }
      else if (sql.startsWith('update')) staged.find((r) => r.id === params![1])!.secret = params![0]
      return { rows: [] }
    },
  }
  return client as unknown as pg.ClientBase
}

describe('BETTER_AUTH_SECRET rotation (Phase 9 W4)', () => {
  it('version 0 is the single unversioned secret, as before', () => {
    expect(authSecretOptions({ BETTER_AUTH_SECRET: v0, BETTER_AUTH_SECRET_VERSION: 0 })).toEqual({ secret: v0 })
  })

  it('version 1 makes the new secret current and keeps the previous one as the legacy key', () => {
    expect(authSecretOptions({ BETTER_AUTH_SECRET: v1, BETTER_AUTH_SECRET_PREVIOUS: v0, BETTER_AUTH_SECRET_VERSION: 1 })).toEqual({
      secret: v0,
      secrets: [{ version: 1, value: v1 }],
    })
    expect(authSecretOptions({ BETTER_AUTH_SECRET: v2, BETTER_AUTH_SECRET_PREVIOUS: v1, BETTER_AUTH_SECRET_VERSION: 2 }).secrets).toEqual([
      { version: 2, value: v2 },
      { version: 1, value: v1 },
    ])
  })

  it('a TOTP secret survives two rotations, and the old key can go after each re-encryption', async () => {
    const totp = 'JBSWY3DPEHPK3PXP'
    const rows = [{ id: 'u1', secret: await symmetricEncrypt({ key: v0, data: totp }) }]

    // Rotation 1: v0 → v1. Before re-encryption the console still reads the bare-hex value.
    const r1 = { BETTER_AUTH_SECRET: v1, BETTER_AUTH_SECRET_PREVIOUS: v0, BETTER_AUTH_SECRET_VERSION: 1 }
    expect(await symmetricDecrypt({ key: authSecretConfig(r1), data: rows[0].secret })).toBe(totp)
    expect(await reencryptTwoFactorSecrets(fakeClient(rows), r1)).toEqual({ reencrypted: 1, alreadyCurrent: 0 })
    expect(rows[0].secret.startsWith('$ba$1$')).toBe(true)
    expect(await reencryptTwoFactorSecrets(fakeClient(rows), r1)).toEqual({ reencrypted: 0, alreadyCurrent: 1 })
    // v0 removed: the console runs on v1 alone.
    expect(await symmetricDecrypt({ key: authSecretConfig({ BETTER_AUTH_SECRET: v1, BETTER_AUTH_SECRET_VERSION: 1 }), data: rows[0].secret })).toBe(totp)

    // Rotation 2: v1 → v2.
    const r2 = { BETTER_AUTH_SECRET: v2, BETTER_AUTH_SECRET_PREVIOUS: v1, BETTER_AUTH_SECRET_VERSION: 2 }
    await reencryptTwoFactorSecrets(fakeClient(rows), r2)
    expect(rows[0].secret.startsWith('$ba$2$')).toBe(true)
    expect(await symmetricDecrypt({ key: authSecretConfig({ BETTER_AUTH_SECRET: v2, BETTER_AUTH_SECRET_VERSION: 2 }), data: rows[0].secret })).toBe(totp)
  })

  it('a row no configured key opens aborts the re-encryption and changes nothing', async () => {
    const rows = [
      { id: 'ok', secret: await symmetricEncrypt({ key: v0, data: 'A' }) },
      { id: 'stranger', secret: await symmetricEncrypt({ key: 'z'.repeat(40), data: 'B' }) },
    ]
    const before = rows.map((r) => r.secret)
    await expect(reencryptTwoFactorSecrets(fakeClient(rows), { BETTER_AUTH_SECRET: v1, BETTER_AUTH_SECRET_PREVIOUS: v0, BETTER_AUTH_SECRET_VERSION: 1 })).rejects.toThrow()
    expect(rows.map((r) => r.secret)).toEqual(before)
  })

  it('the environment refuses a previous secret without a version, or equal to the current one', () => {
    const base = { DATABASE_URL: 'postgresql://p:x@h:5432/console', BETTER_AUTH_URL: 'https://12id.example', PLATFORM_API_URL: 'http://platform-api:3500', CONSOLE_TOKEN: 't'.repeat(40), NODE_ENV: 'development' }
    expect(() => serverEnv({ ...base, BETTER_AUTH_SECRET: v1, BETTER_AUTH_SECRET_PREVIOUS: v0 })).toThrow(/BETTER_AUTH_SECRET_VERSION/)
    expect(() => serverEnv({ ...base, BETTER_AUTH_SECRET: v1, BETTER_AUTH_SECRET_PREVIOUS: v1, BETTER_AUTH_SECRET_VERSION: '1' })).toThrow(/equals BETTER_AUTH_SECRET/)
    expect(serverEnv({ ...base, BETTER_AUTH_SECRET: v1, BETTER_AUTH_SECRET_PREVIOUS: '', BETTER_AUTH_SECRET_VERSION: '1' }).BETTER_AUTH_SECRET_PREVIOUS).toBeUndefined()
  })
})
