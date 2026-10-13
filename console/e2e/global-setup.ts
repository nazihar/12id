/**
 * A fresh operator per run (2FA state is persistent, so reusing one account would break the next run).
 * Created the supported way, through the Better Auth CLI, against the migrated local database.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { MAIL_OUTBOX_FILE, OPERATOR_FILE, TOTP_SECRET_FILE, consoleEnv } from './env'
import { strongPassword } from './passwords'

export default async function globalSetup() {
  const stamp = Date.now()
  const operator = { email: `operator+${stamp}@12id.test`, password: strongPassword() }
  execFileSync(
    'npx',
    ['auth', 'create-admin', '--config', 'src/server/auth.server.ts', '--email', operator.email, '--password', operator.password, '--name', 'E2E-Operator', '--role', 'operator', '--force', '--yes'],
    { env: { ...process.env, ...consoleEnv }, stdio: 'inherit', shell: true }
  )
  mkdirSync('test-results', { recursive: true })
  rmSync(MAIL_OUTBOX_FILE, { force: true })
  rmSync(TOTP_SECRET_FILE, { force: true })
  writeFileSync(OPERATOR_FILE, JSON.stringify(operator))
}
