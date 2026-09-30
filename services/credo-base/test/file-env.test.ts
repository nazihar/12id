import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { resolveFileEnv } from '../src/file-env.ts'

const dir = mkdtempSync(join(tmpdir(), 'file-env-'))
function secretFile(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('resolveFileEnv', () => {
  it('reads NAME_FILE into NAME and drops the trailing newline', () => {
    const env = resolveFileEnv({ TOKEN_FILE: secretFile('token', 'abc\n'), OTHER: 'x' })
    assert.equal(env.TOKEN, 'abc')
    assert.equal(env.TOKEN_FILE, undefined)
    assert.equal(env.OTHER, 'x')
  })

  it('keeps inner newlines and whitespace', () => {
    assert.equal(resolveFileEnv({ K_FILE: secretFile('multi', 'a\nb \n') }).K, 'a\nb ')
  })

  it('leaves NAME unset for an empty file (an optional secret)', () => {
    const env = resolveFileEnv({ SMTP_URL_FILE: secretFile('empty', '') })
    assert.equal('SMTP_URL' in env, false)
  })

  it('refuses NAME and NAME_FILE together', () => {
    assert.throws(() => resolveFileEnv({ TOKEN: 'a', TOKEN_FILE: secretFile('t2', 'b') }), /both TOKEN and TOKEN_FILE/)
  })

  it('names the variable when the file cannot be read', () => {
    assert.throws(() => resolveFileEnv({ TOKEN_FILE: join(dir, 'missing') }), /TOKEN_FILE: cannot read .*ENOENT/)
  })

  it('puts NAME_URL_PASSWORD into the URL, percent-encoded', () => {
    const env = resolveFileEnv({
      DATABASE_URL: 'postgresql://agent_service@agent-postgres:5432/agent_service',
      DATABASE_URL_PASSWORD_FILE: secretFile('pw', 'p@ss/w:rd\n'),
    })
    assert.equal(env.DATABASE_URL, 'postgresql://agent_service:p%40ss%2Fw%3Ard@agent-postgres:5432/agent_service')
    assert.equal(decodeURIComponent(new URL(env.DATABASE_URL!).password), 'p@ss/w:rd')
    assert.equal(env.DATABASE_URL_PASSWORD, undefined)
  })

  it('refuses a password for a URL that already has one', () => {
    assert.throws(
      () => resolveFileEnv({ DATABASE_URL: 'postgresql://u:x@h:5432/d', DATABASE_URL_PASSWORD: 'y' }),
      /already carries a password/
    )
  })

  it('refuses a password without its URL', () => {
    assert.throws(() => resolveFileEnv({ MEDIATOR_DRIZZLE_URL_PASSWORD: 'y' }), /MEDIATOR_DRIZZLE_URL is not/)
  })

  it('leaves an environment without file variables unchanged', () => {
    const env = { A: '1', DATABASE_URL: 'postgresql://u:p@h:5432/d' }
    assert.deepEqual(resolveFileEnv(env), env)
  })
})
