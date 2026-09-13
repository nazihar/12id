import { CacheModule, InMemoryLruCache } from '@credo-ts/core'

/**
 * Cache for a multi-tenant root agent (8-phase-2-findings T1).
 *
 * - The default SingleContextStorageLruCache binds to the first agent context and fails the
 *   second tenant's ledger reads.
 * - InMemoryLruCache is shared by every tenant and ignores the context in its keys. That is
 *   safe only for public ledger data (DID documents, NYMs, schemas, cred defs).
 * - `useCachedStorageService` would also cache wallet records under keys without a tenant
 *   (connections by ourDid/theirDid), so it is pinned to false here and must stay false.
 */
export function multiTenantCacheModule(limit = 1000) {
  return new CacheModule({
    cache: new InMemoryLruCache({ limit }),
    useCachedStorageService: false,
  })
}
