/**
 * biometric-service entry point. Private network, platform-api only. Requires the database to be
 * migrated (provision.ts).
 */
import { createBiometricService } from './biometric.ts'
import { loadConfig } from './config.ts'
import { KeyRing } from './crypto.ts'
import { createDatabase } from './db/client.ts'
import { buildBiometricApi } from './http/api.ts'
import { createLogger } from './logger.ts'
import { buildRegistry } from './providers/registry.ts'

const config = loadConfig()
const logger = createLogger({ name: 'biometric-service', level: config.LOG_LEVEL })
const { pool, db } = createDatabase(config.DATABASE_URL)
const providers = buildRegistry(config)
const service = createBiometricService({ db, keyRing: new KeyRing(config.BIOMETRIC_MASTER_KEY), providers, logger })

const api = buildBiometricApi({ logger, token: config.INTERNAL_TOKEN, service })
await api.listen({ host: config.HOST, port: config.PORT })

// Expire overdue checks and wipe their images. setTimeout chaining, so sweeps never overlap.
let sweep: NodeJS.Timeout | undefined
let sweeping: Promise<unknown> = Promise.resolve()
const schedule = () => {
  sweep = setTimeout(() => {
    sweeping = service.expireDue().catch((error: unknown) => logger.error({ err: error }, 'expiry sweep failed')).finally(schedule)
  }, config.EXPIRY_SWEEP_MS)
}
schedule()

let stopping: Promise<void> | undefined
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping ??= (async () => {
      logger.info({ signal }, 'biometric-service stopping')
      clearTimeout(sweep)
      await api.close().catch((error: unknown) => logger.error({ err: error }, 'api close failed'))
      await sweeping
      await pool.end().catch(() => undefined)
      process.exit(0)
    })()
  })
}

logger.info({ listen: `${config.HOST}:${config.PORT}`, providers: [...providers.keys()] }, 'biometric-service ready')
