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
  /**
   * True when the organisation uses face checks: the backend then needs a photo of each user and sends
   * it with every offer and proof request as the reference image. 12id uses it only where the
   * organisation's policy (console, Biometrics) requires a check, and ignores it elsewhere.
   */
  photoOnFile?: boolean
  /**
   * What the app may ask for, and the proof template that backs each.
   *
   * `faceCheckParams`: when the template's face check is conditional (console, Proof templates:
   * "Require a face check when…", e.g. amount ≥ 5000), the names of the action's details that its rule
   * is decided from. They are sent as numbers with every request; 12id holds the rule and decides.
   */
  actions: Record<string, { proofTemplateId: string; faceCheckParams?: string[] }>
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
  let tenant: Tenant
  try {
    tenant = JSON.parse(readFileSync(file, 'utf8')) as Tenant
  } catch (error) {
    // The usual cause is a comma left after the last entry of a list.
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  if (!tenant.credentialDefinitionId || !tenant.credential?.attributes || !tenant.actions) throw new Error(`${file}: credentialDefinitionId, credential.attributes and actions are required`)
  const ids = [tenant.credentialDefinitionId, ...Object.values(tenant.actions).map((action) => action.proofTemplateId)]
  if (ids.some((id) => !id || id.startsWith('REPLACE'))) throw new Error(`${file}: fill in the credential definition id and each action's proof template id`)
  const unknown = Object.values(tenant.credential.attributes).flatMap((value) => value.match(/\{[^}]*\}/g) ?? []).filter((p) => p !== '{name}' && p !== '{memberId}')
  if (unknown.length > 0) throw new Error(`${file}: unknown placeholder ${unknown.join(', ')}; the user supplies {name} and {memberId}, anything else is issued as written`)
  for (const [name, action] of Object.entries(tenant.actions)) {
    const params = action.faceCheckParams
    if (params !== undefined && !(Array.isArray(params) && params.every((p) => typeof p === 'string' && p !== ''))) throw new Error(`${file}: actions.${name}.faceCheckParams is a list of detail names, e.g. ["amount"]`)
  }
  if ('expiresOn' in tenant.credential.attributes) throw new Error(`${file}: leave expiresOn out; it is computed from credential.validDays`)
  return tenant
}
