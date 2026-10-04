/**
 * Askar store key rotation (Phase 9 W4, infra/runbooks/key-rotation.md). Re-encrypts a Postgres-backed
 * Askar store's profile keys under a new store key: one `rekey` for the whole store, so the agent's
 * root store covers every tenant profile in it (ProfilePerWallet, T1).
 *
 * Run as a one-shot with the store's owner stopped (a running agent keeps using its cached key):
 *   infra/scripts/rotate-askar-key.sh agent|endorser|mediator
 * which pipes the next key on stdin to `node credo-base/src/askar-rekey.ts` in a container that has the
 * store's usual configuration: ASKAR_STORE_ID, ASKAR_STORE_KEY(_FILE), POSTGRES_HOST (host:port),
 * POSTGRES_USER, POSTGRES_PASSWORD(_FILE). Key derivation is Askar's default, argon2i "mod", which is
 * what Credo (agent, endorser) and the mediator's config default to.
 *
 * Re-running after a completed rotation is safe: a store the current key no longer opens but the next
 * key does is reported as already rotated.
 */
import { askar, KdfMethod, Store, StoreKeyMethod } from '@openwallet-foundation/askar-nodejs'

import { resolveFileEnv } from './file-env.ts'

export interface RekeyOptions {
  storeId: string
  host: string
  user: string
  password: string
  currentKey: string
  nextKey: string
}

export const storeUri = (o: Pick<RekeyOptions, 'storeId' | 'host' | 'user' | 'password'>) =>
  `postgres://${encodeURIComponent(o.user)}:${encodeURIComponent(o.password)}@${o.host}/${encodeURIComponent(o.storeId)}`

const keyMethod = () => new StoreKeyMethod(KdfMethod.Argon2IMod)

async function opens(uri: string, passKey: string): Promise<boolean> {
  try {
    const store = await Store.open({ uri, keyMethod: keyMethod(), passKey })
    await store.close()
    return true
  } catch {
    return false
  }
}

/** Rekeys the store and proves the result: the next key opens it, the current key no longer does. */
export async function rekeyStore(options: RekeyOptions, uri = storeUri(options)): Promise<'rekeyed' | 'already-rotated'> {
  if (options.nextKey === options.currentKey) throw new Error('the next store key equals the current one')
  let store: Store
  try {
    store = await Store.open({ uri, keyMethod: keyMethod(), passKey: options.currentKey })
  } catch (error) {
    if (await opens(uri, options.nextKey)) return 'already-rotated'
    throw new Error(`store '${options.storeId}' opens with neither the current nor the next key: ${(error as Error).message}`)
  }
  try {
    await store.rekey({ keyMethod: keyMethod(), passKey: options.nextKey })
  } finally {
    await store.close()
  }
  if (!(await opens(uri, options.nextKey))) throw new Error('after rekey the next key does not open the store')
  if (await opens(uri, options.currentKey)) throw new Error('after rekey the current key still opens the store')
  return 'rekeyed'
}

if (import.meta.main) {
  void askar // the native binding registers on import
  const env = resolveFileEnv(process.env)
  const need = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`missing ${name}`)
    return value
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const nextKey = Buffer.concat(chunks).toString('utf8').trim()
  if (nextKey.length < 32) {
    console.error('the next store key on stdin must be at least 32 characters (generate it)')
    process.exit(1)
  }
  const storeId = need('ASKAR_STORE_ID')
  try {
    const outcome = await rekeyStore({ storeId, host: need('POSTGRES_HOST'), user: need('POSTGRES_USER'), password: need('POSTGRES_PASSWORD'), currentKey: need('ASKAR_STORE_KEY'), nextKey })
    console.log(`askar store '${storeId}': ${outcome}`)
  } catch (error) {
    console.error(`askar store '${storeId}': rekey failed: ${(error as Error).message}`)
    process.exit(1)
  }
}
