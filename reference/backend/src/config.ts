/**
 * Settings. Secrets come from the environment (.env); everything tied to the tenant's catalogue comes
 * from tenant.json. Pointing this backend at another tenant means replacing that file, the API key and
 * the webhook secret.
 */
import { readFileSync } from 'node:fs'

export interface Tenant {
  /** The credential definition to issue from (its id in the console's Catalogue). */
  credentialDefinitionId: string
  credential: {
    /** `expiresOn` is set this many days ahead. Every 12id credential carries an expiry date. */
    validDays: number
    /** One entry per schema attribute except `expiresOn`. `{name}` and `{memberId}` come from the user. */
    attributes: Record<string, string>
  }
  /** What the app may ask for, and the proof template that backs each. */
  actions: Record<string, { proofTemplateId: string }>
}

export interface Config {
  platformApiUrl: string
  platformApiKey: string
  webhookSecret: string
  accessCode: string
  port: number
  dataFile: string
  appDownloadUrl: string | null
  tenant: Tenant
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set (see env.example)`)
    return value
  }
  return {
    platformApiUrl: required('PLATFORM_API_URL').replace(/\/+$/, ''),
    platformApiKey: required('PLATFORM_API_KEY'),
    webhookSecret: required('WEBHOOK_SECRET'),
    accessCode: required('ACCESS_CODE'),
    port: Number(env.PORT ?? 3700),
    dataFile: env.DATA_FILE ?? './data/store.json',
    appDownloadUrl: env.APP_DOWNLOAD_URL || null,
    tenant: loadTenant(env.TENANT_FILE ?? './tenant.json'),
  }
}

export function loadTenant(file: string): Tenant {
  const tenant = JSON.parse(readFileSync(file, 'utf8')) as Tenant
  if (!tenant.credentialDefinitionId || !tenant.credential?.attributes || !tenant.actions) throw new Error(`${file}: credentialDefinitionId, credential.attributes and actions are required`)
  const ids = [tenant.credentialDefinitionId, ...Object.values(tenant.actions).map((action) => action.proofTemplateId)]
  if (ids.some((id) => !id || id.startsWith('REPLACE'))) throw new Error(`${file}: fill in the credential definition id and each action's proof template id`)
  if ('expiresOn' in tenant.credential.attributes) throw new Error(`${file}: leave expiresOn out; it is computed from credential.validDays`)
  return tenant
}
