import { loadConfig } from './config.ts'
import { platformClient } from './platform.ts'
import { createApp } from './server.ts'
import { Store } from './store.ts'

const config = loadConfig()
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)
const app = createApp({ config, platform: platformClient(config.platformApiUrl, config.platformApiKey), store: new Store(config.dataFile), log })

app.listen(config.port, () => log(`listening on ${config.port}; platform ${config.platformApiUrl}`))
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.close(() => process.exit(0))
    app.closeIdleConnections()
  })
}
