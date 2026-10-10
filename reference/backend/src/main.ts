import { loadConfig } from './config.ts'
import { platformClient } from './platform.ts'
import { createApp } from './server.ts'
import { Store } from './store.ts'
import { fetchCatalogue, tenantProblems } from './tenant-check.ts'

let config
try {
  config = loadConfig()
} catch (error) {
  // A wrong setting should read as one line that says what to fix, not as a stack trace.
  console.error(`Cannot start: ${(error as Error).message}`)
  process.exit(1)
}
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)

// tenant.json against the organisation's real catalogue: a wrong id or attribute list is refused here,
// in words, instead of surfacing later as a card that never arrives. If the platform cannot be reached
// right now, the backend starts anyway.
try {
  const problems = tenantProblems(config.tenant, await fetchCatalogue(config.platformApiUrl, config.platformApiKey, config.tenant))
  if (problems.length > 0) {
    console.error(`Cannot start: tenant.json does not fit the organisation's catalogue:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
} catch (error) {
  log(`could not check tenant.json against the catalogue: ${(error as Error).message}`)
}

const app = createApp({ config, platform: platformClient(config.platformApiUrl, config.platformApiKey), store: new Store(config.dataFile), log })

app.listen(config.port, () => log(`listening on ${config.port}; platform ${config.platformApiUrl}`))
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.close(() => process.exit(0))
    app.closeIdleConnections()
  })
}
