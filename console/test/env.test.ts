import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { serverEnv } from '../src/server/env.server'

const base = {
  DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:5432/console',
  BETTER_AUTH_URL: 'https://12id.example',
  BETTER_AUTH_SECRET: 's'.repeat(40),
  PLATFORM_API_URL: 'http://platform-api:3500',
  CONSOLE_TOKEN: 'c'.repeat(40),
}

describe('serverEnv', () => {
  it('treats a blank SMTP_URL as unset (compose passes empty strings for missing secrets)', () => {
    expect(serverEnv({ ...base, NODE_ENV: 'development', SMTP_URL: '' }).SMTP_URL).toBeUndefined()
  })

  it('requires SMTP_URL in production and refuses the mail outbox file there', () => {
    expect(() => serverEnv({ ...base, NODE_ENV: 'production', SMTP_URL: '' })).toThrow(/SMTP_URL: required in production/)
    expect(() => serverEnv({ ...base, NODE_ENV: 'production', SMTP_URL: 'smtps://u:p@mail.example:465', MAIL_OUTBOX_FILE: 'x' })).toThrow(/MAIL_OUTBOX_FILE/)
    expect(serverEnv({ ...base, NODE_ENV: 'production', SMTP_URL: 'smtps://u:p@mail.example:465' }).SMTP_URL).toBe('smtps://u:p@mail.example:465')
  })
})

describe('serverEnv with file secrets (Phase 9 M11)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'console-env-'))
  const file = (name: string, content: string) => {
    const path = join(dir, name)
    writeFileSync(path, content)
    return path
  }

  it('reads NAME_FILE secrets and the database password', () => {
    const env = serverEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://console@agent-postgres:5432/console',
      DATABASE_URL_PASSWORD_FILE: file('db', 'pw\n'),
      BETTER_AUTH_URL: base.BETTER_AUTH_URL,
      BETTER_AUTH_SECRET_FILE: file('auth', `${'s'.repeat(40)}\n`),
      PLATFORM_API_URL: base.PLATFORM_API_URL,
      CONSOLE_TOKEN_FILE: file('console', 'c'.repeat(40)),
      SMTP_URL_FILE: file('smtp', ''),
    })
    expect(env.DATABASE_URL).toBe('postgresql://console:pw@agent-postgres:5432/console')
    expect(env.BETTER_AUTH_SECRET).toBe('s'.repeat(40))
    expect(env.CONSOLE_TOKEN).toBe('c'.repeat(40))
    expect(env.SMTP_URL).toBeUndefined()
  })

  it('refuses a secret given both ways', () => {
    expect(() => serverEnv({ ...base, NODE_ENV: 'development', CONSOLE_TOKEN_FILE: file('c2', 'x') })).toThrow(/both CONSOLE_TOKEN and CONSOLE_TOKEN_FILE/)
  })
})
