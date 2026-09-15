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
