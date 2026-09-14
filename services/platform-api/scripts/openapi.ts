/**
 * Writes openapi.json (the customer artefact, P8) from the route schemas. Builds the app with
 * inert dependencies: nothing is called, only the schema is read.
 *
 *   node scripts/openapi.ts [out=openapi.json]
 */
import { writeFileSync } from 'node:fs'

import { pino } from 'pino'

import type { PlatformConfig } from '../src/config.ts'
import { buildApp } from '../src/http/app.ts'

const config = {
  PUBLIC_URL: 'https://api.12id.naziharitsolution.com',
  PLATFORM_ADMIN_TOKEN: 'x'.repeat(40),
  MEDIATOR_WEBHOOK_SECRET: 'x'.repeat(40),
  INDY_NAMESPACE: 'twelveid:staging',
  GENESIS_URL: 'https://genesis.example/v1/pool_transactions_genesis',
  GENESIS_SHA256: '0'.repeat(64),
  GENESIS_SIGNATURE_URL: 'https://genesis.example/v1/pool_transactions_genesis.minisig',
  GENESIS_SIGNING_PUBLIC_KEY: 'RWQ…',
} as PlatformConfig

const inert = new Proxy({}, { get: () => () => Promise.reject(new Error('inert')) })
const app = buildApp({
  config,
  db: inert as never,
  agent: inert as never,
  mediator: inert as never,
  logger: pino({ level: 'silent' }),
  readiness: async () => ({ ready: true, draining: false, checks: {} }),
  wake: async () => 'unknown_connection',
})
await app.ready()
const spec = app.swagger()
const out = process.argv[2] ?? new URL('../openapi.json', import.meta.url)
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`)
console.log(`wrote ${out} (${Object.keys((spec as { paths: object }).paths).length} paths)`)
await app.close()
