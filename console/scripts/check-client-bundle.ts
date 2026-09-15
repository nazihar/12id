/**
 * Fails when the client build contains server-only code. Run after `vite build`.
 *
 * It looks for server code, not for variable names: Better Auth's isomorphic env helper legitimately
 * names BETTER_AUTH_SECRET in the browser bundle as a getter that reads nothing there.
 *
 *   node scripts/check-client-bundle.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKERS = [
  'internalAdapter', // Better Auth server internals
  'createAuthEndpoint',
  'drizzleAdapter',
  'symmetricEncrypt',
  'drizzle-orm/node-postgres', // database
  'pg-pool',
  'nodemailer', // mail
  'appendFileSync', // mail outbox (development)
  'x-console-token', // platform-api console scope
]

const clientDir = fileURLToPath(new URL('../dist/client', import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.js') ? [path] : []
  })
}

const findings = files(clientDir).flatMap((file) => {
  const text = readFileSync(file, 'utf8')
  return MARKERS.filter((marker) => text.includes(marker)).map((marker) => `${file.slice(clientDir.length + 1)}: ${marker}`)
})

if (findings.length > 0) {
  console.error(`server-only code in the client bundle:\n  ${findings.join('\n  ')}`)
  process.exit(1)
}
console.log(`client bundle clean (${MARKERS.length} markers checked)`)
