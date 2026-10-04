import { type AskarModuleConfigStoreOptions, AskarMultiWalletDatabaseScheme, AskarStoreDuplicateError } from '@credo-ts/askar'

export interface PostgresStoreOptions {
  /** Store id; Askar also uses it as the Postgres database name. */
  id: string
  /** Store key from the secrets file, never an environment default. */
  key: string
  /** `host:port`. Unlike the mediator's pickup-queue host, Askar accepts a port here. */
  host: string
  user: string
  password: string
  /** Account allowed to CREATE DATABASE during provisioning; defaults to `user`. */
  adminUser?: string
  adminPassword?: string
  connectTimeoutSeconds?: number
  /**
   * Size of Askar's Postgres pool (review L9). Unset = Askar's own default. Every tenant session and
   * every concurrently processed message holds a connection, so with PROCESS_MESSAGES_CONCURRENTLY the
   * pool, not Credo, decides how many messages run at once (sized by the Phase 9 W4 load test).
   */
  maxConnections?: number
}

export function postgresStore(options: PostgresStoreOptions): AskarModuleConfigStoreOptions {
  return {
    id: options.id,
    key: options.key,
    database: {
      type: 'postgres',
      config: {
        host: options.host,
        connectTimeout: options.connectTimeoutSeconds ?? 10,
        ...(options.maxConnections !== undefined ? { maxConnections: options.maxConnections } : {}),
      },
      credentials: {
        account: options.user,
        password: options.password,
        adminAccount: options.adminUser ?? options.user,
        adminPassword: options.adminPassword ?? options.password,
      },
    },
  }
}

/**
 * One Askar profile per tenant inside the root store (T1: one database, `tenant-<id>` profiles).
 * Must be set explicitly: Credo's default is DatabasePerWallet "for backwards compatibility".
 */
export const TENANT_STORAGE_SCHEME = AskarMultiWalletDatabaseScheme.ProfilePerWallet

/**
 * Provisions the store if it does not exist. Run from ONE process only (the provision job):
 * concurrent provisioning races on CREATE SCHEMA (6-phase-1-findings W4).
 *
 * On an existing store Askar logs `[error] Error occurred during transaction, rollback
 * {"error":{"code":3}}` before the duplicate error is caught. That line is expected here.
 */
export async function provisionStoreIfMissing(agent: { modules: { askar: { provisionStore(): Promise<unknown> } } }) {
  try {
    await agent.modules.askar.provisionStore()
    return 'provisioned' as const
  } catch (error) {
    if (error instanceof AskarStoreDuplicateError) return 'existing' as const
    throw error
  }
}
