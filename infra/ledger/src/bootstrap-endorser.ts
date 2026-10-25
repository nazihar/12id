/**
 * Creates, or verifies, the platform's Endorser DID (Phase 1 W3; trustee-signed since Phase 9 W2).
 *
 * - The Ed25519 key is generated inside an Askar store backed by Postgres and never leaves it.
 * - Who writes the NYM with role ENDORSER (ENDORSER_REGISTRAR):
 *     trustee       (production, our own network) a trustee signs it here. The operator pipes the
 *                   trustee seed on stdin, decrypted from offline custody (runbooks/ledger-ceremony.md);
 *                   it lives in this process's memory only and is never stored or printed.
 *     von-register  (staging) von-network's unauthenticated /register, reached on its Docker network.
 * - Trustee mode also registers the write probe's DID (LEDGER_PROBE_SEED, role-less NYM) when set, so
 *   the probe can prove consensus without any privileged key online (src/write-probe.ts).
 * - Re-runnable: if the store already holds an endorser DID for this namespace, it is checked
 *   against the ledger instead of creating a second one. With several (after a rotation), ENDORSER_DID
 *   says which one.
 * - Rotation (Phase 9 W4, runbooks/key-rotation.md):
 *     --rotate        creates a new endorser DID and key in the same store, even though one exists, and
 *                     registers it with role ENDORSER. Then set ENDORSER_DID to it and redeploy the
 *                     agent stack (agent-service and endorser-service). Tenants are unaffected: their
 *                     DIDs are role-less authors that any endorser can endorse.
 *     --demote <did>  a trustee removes the ENDORSER role from a retired endorser DID (trustee mode only;
 *                     on staging, von-network's public Trustee1 seed, review L16). Its past
 *                     endorsements stay valid; it can no longer endorse.
 *
 * Prints public identifiers only.
 */
import 'reflect-metadata'

// Native bindings first - see src/bindings.ts for why the order is load-bearing.
import { askar, indyVdr } from './bindings.ts'

import { createHash } from 'node:crypto'

import { AskarModule, AskarStoreDuplicateError } from '@credo-ts/askar'
import { Agent, DidsModule, LogLevel, TypedArrayEncoder } from '@credo-ts/core'
import { IndyVdrIndyDidResolver, IndyVdrModule, IndyVdrPoolService } from '@credo-ts/indy-vdr'
import { agentDependencies } from '@credo-ts/node'
import { CustomRequest, GetNymRequest, GetTransactionAuthorAgreementRequest, NymRequest } from '@hyperledger/indy-vdr-nodejs'

import { env, readSeedFromStdin, signerFromSeed, type IndySigner } from './indy-keys.ts'
import { PlainLogger } from './logger.ts'

// Ledger role codes as returned by GET_NYM.
const ENDORSER_ROLE = '101'
const TRUSTEE_ROLE = '0'

const rotate = process.argv.includes('--rotate')
const demoteIndex = process.argv.indexOf('--demote')
const demoteDid = demoteIndex >= 0 ? process.argv[demoteIndex + 1] : undefined
if (demoteIndex >= 0 && !demoteDid) throw new Error('--demote needs the retired endorser DID')
if (rotate && demoteDid) throw new Error('rotate first, switch ENDORSER_DID and redeploy, then demote the old DID')

const registrar = env('ENDORSER_REGISTRAR', 'trustee')
if (demoteDid && registrar !== 'trustee') throw new Error('--demote needs ENDORSER_REGISTRAR=trustee and a trustee seed on stdin')
if (registrar !== 'trustee' && registrar !== 'von-register') throw new Error(`unknown ENDORSER_REGISTRAR ${registrar}`)
// Read before anything else logs: the operator's pipe is waiting.
const trustee: IndySigner | null = registrar === 'trustee' ? signerFromSeed(await readSeedFromStdin()) : null

const namespace = env('INDY_NAMESPACE')
const alias = env('ENDORSER_ALIAS')
const storeId = env('ASKAR_STORE_ID')
const postgresUser = env('POSTGRES_USER', 'postgres')
const postgresPassword = env('POSTGRES_PASSWORD')

async function fetchGenesis(): Promise<string> {
  const response = await fetch(env('GENESIS_URL'))
  if (!response.ok) throw new Error(`genesis fetch failed: ${response.status}`)
  const genesis = await response.text()

  const expected = process.env.GENESIS_SHA256
  if (expected) {
    const actual = createHash('sha256').update(genesis).digest('hex')
    if (actual !== expected) throw new Error(`genesis sha256 mismatch: expected ${expected}, got ${actual}`)
  }
  return genesis
}

const agent = new Agent({
  config: {
    // No `label`: in Credo 0.7 it is not an InitConfig option (it moved with DIDComm).
    logger: new PlainLogger(process.env.LOG_LEVEL === 'debug' ? LogLevel.Debug : LogLevel.Info, 'endorser'),
  },
  dependencies: agentDependencies,
  modules: {
    askar: new AskarModule({
      askar,
      store: {
        id: storeId,
        key: env('ASKAR_STORE_KEY'),
        database: {
          type: 'postgres',
          config: { host: env('POSTGRES_HOST'), connectTimeout: 10 },
          credentials: {
            account: postgresUser,
            password: postgresPassword,
            adminAccount: postgresUser,
            adminPassword: postgresPassword,
          },
        },
      },
    }),
    indyVdr: new IndyVdrModule({
      indyVdr,
      networks: [
        {
          isProduction: process.env.INDY_NETWORK_PRODUCTION === 'true',
          indyNamespace: namespace,
          genesisTransactions: await fetchGenesis(),
          connectOnStartup: true,
        },
      ],
    }),
    dids: new DidsModule({ resolvers: [new IndyVdrIndyDidResolver()] }),
  },
})

interface NymData {
  dest: string
  verkey: string
  role: string | null
}

async function readNym(nym: string): Promise<NymData | null> {
  const pool = agent.dependencyManager.resolve(IndyVdrPoolService).getPoolForNamespace(namespace)
  const response = await pool.submitRequest(new GetNymRequest({ dest: nym }))
  const data = (response.result as { data?: string | null }).data
  return data ? (JSON.parse(data) as NymData) : null
}

/** Writes a NYM signed by the trustee (our own network has no TAA, 18-phase-9 decisions). */
async function writeNymAsTrustee(options: { dest: string; verkey: string; alias: string; role?: 'ENDORSER' }) {
  if (!trustee) throw new Error('no trustee key')
  const pool = agent.dependencyManager.resolve(IndyVdrPoolService).getPoolForNamespace(namespace)
  const request = new NymRequest({ submitterDid: trustee.nym, ...options })
  request.setSignature({ signature: trustee.sign(Buffer.from(request.signatureInput, 'utf8')) })
  const response = await pool.submitRequest(request)
  if ((response as { op?: string }).op !== 'REPLY') {
    throw new Error(`NYM write refused: ${JSON.stringify(response).slice(0, 300)}`)
  }
}

/**
 * Our writes carry no transaction author agreement acceptance: our own network has none (18-phase-9
 * decisions), and an existing network that has one is not supported (implement/28). Say so before writing,
 * instead of a refused NYM later. An empty text means a retired agreement.
 */
async function refuseTaa() {
  const pool = agent.dependencyManager.resolve(IndyVdrPoolService).getPoolForNamespace(namespace)
  const response = await pool.submitRequest(new GetTransactionAuthorAgreementRequest({}))
  const taa = (response.result as { data?: { text?: string; version?: string } | null }).data
  if (taa?.text) {
    throw new Error(`this ledger has a transaction author agreement (version ${taa.version}); writing under one is not supported`)
  }
}

async function waitForNym(nym: string, timeoutMs = 60_000): Promise<NymData> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = await readNym(nym)
    if (data) return data
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`NYM ${nym} not visible on the ledger after ${timeoutMs / 1000}s`)
}

async function run() {
  try {
    await agent.modules.askar.provisionStore()
    console.log(`provisioned Askar store '${storeId}' on postgres`)
  } catch (error) {
    if (!(error instanceof AskarStoreDuplicateError)) throw error
    console.log(`Askar store '${storeId}' already exists`)
  }
  await agent.initialize()

  if (trustee) {
    const onLedger = await readNym(trustee.nym)
    if (onLedger?.role !== TRUSTEE_ROLE) {
      throw new Error(`the seed on stdin is not a trustee of this ledger (${trustee.nym}: role ${onLedger?.role ?? 'none'})`)
    }
    console.log(`signing as trustee ${trustee.nym}`)
    await refuseTaa()
  }

  const prefix = `did:indy:${namespace}:`
  const all = (await agent.dids.getCreatedDids({ method: 'indy' })).filter((record) => record.did.startsWith(prefix))

  if (demoteDid) {
    await demote(demoteDid, prefix)
    return
  }

  // Which existing DID this run is about: none when rotating, the configured one when there are several.
  const configured = process.env.ENDORSER_DID || undefined
  let existing = rotate ? [] : all
  if (!rotate && configured) {
    existing = all.filter((record) => record.did === configured)
    if (existing.length === 0 && all.length > 0) {
      throw new Error(`ENDORSER_DID ${configured} is not in the store, which holds ${all.map((r) => r.did).join(', ')}`)
    }
  }
  if (existing.length > 1) {
    throw new Error(`store holds ${existing.length} ${prefix} DIDs (a rotation); set ENDORSER_DID to the current one`)
  }

  let result: 'created' | 'existing' | 'rotated'
  let did: string
  let nym: string
  let verkey: string

  if (existing.length === 1) {
    result = 'existing'
    did = existing[0].did
    nym = did.slice(prefix.length)
    const onLedger = await readNym(nym)
    if (!onLedger) {
      // The ledger was reset while the store survived. Do not silently re-register:
      // the endorser identity changing is something an operator must decide.
      throw new Error(`${did} exists in the store but its NYM is missing from the ledger (ledger reset?)`)
    }
    verkey = onLedger.verkey
  } else {
    result = rotate && all.length > 0 ? 'rotated' : 'created'
    const { keyId, publicJwk } = await agent.kms.createKey({ type: { kty: 'OKP', crv: 'Ed25519' } })
    const publicKeyBytes = TypedArrayEncoder.fromBase64Url((publicJwk as { x: string }).x)
    verkey = TypedArrayEncoder.toBase58(publicKeyBytes)
    nym = TypedArrayEncoder.toBase58(publicKeyBytes.slice(0, 16))
    did = `${prefix}${nym}`

    if (trustee) {
      await writeNymAsTrustee({ dest: nym, verkey, alias, role: 'ENDORSER' })
    } else {
      const response = await fetch(env('LEDGER_REGISTER_URL'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ did: nym, verkey, alias, role: 'ENDORSER' }),
      })
      if (!response.ok) {
        throw new Error(`NYM registration failed: ${response.status} ${await response.text()}`)
      }
    }
    await waitForNym(nym)

    // Import after the NYM exists: importing a did:indy DID resolves it from the ledger.
    await agent.dids.import({
      did,
      keys: [{ kmsKeyId: keyId, didDocumentRelativeKeyId: '#verkey' }],
      overwrite: false,
    })
  }

  const nymData = await waitForNym(nym)
  if (nymData.role !== ENDORSER_ROLE) {
    throw new Error(`${did} has ledger role ${nymData.role}, expected ${ENDORSER_ROLE} (ENDORSER)`)
  }
  if (nymData.verkey !== verkey) {
    throw new Error(`${did} ledger verkey ${nymData.verkey} does not match the stored key ${verkey}`)
  }

  const resolved = await agent.dids.resolve(did)
  if (!resolved.didDocument) {
    throw new Error(`${did} does not resolve: ${JSON.stringify(resolved.didResolutionMetadata)}`)
  }

  const probe = await registerProbe()

  console.log(
    JSON.stringify(
      {
        result, did, nym, verkey, role: 'ENDORSER', indyNamespace: namespace, askarStoreId: storeId, probe,
        ...(result === 'rotated' ? { previous: all.map((r) => r.did), next: 'set ENDORSER_DID to did, redeploy the agent stack, then --demote the previous one' } : {}),
      },
      null,
      2
    )
  )
}

/** Retires an endorser DID: the trustee resets its role. Refuses the DID still configured as current. */
async function demote(did: string, prefix: string) {
  if (!did.startsWith(prefix)) throw new Error(`${did} is not a ${prefix} DID`)
  if (did === process.env.ENDORSER_DID) throw new Error(`${did} is still ENDORSER_DID; switch to the new endorser first`)
  const nym = did.slice(prefix.length)
  const onLedger = await readNym(nym)
  if (!onLedger) throw new Error(`${did} has no NYM on this ledger`)
  if (onLedger.role !== ENDORSER_ROLE) {
    console.log(JSON.stringify({ result: 'already-demoted', did, role: onLedger.role }, null, 2))
    return
  }
  // A NYM whose role is explicitly null resets the role (Indy's convention; omitting it changes nothing).
  // Built by hand: the typed NymRequest has no way to say "null".
  const pool = agent.dependencyManager.resolve(IndyVdrPoolService).getPoolForNamespace(namespace)
  const request = new CustomRequest({
    customRequest: { reqId: Date.now() * 1000 + Math.floor(Math.random() * 1000), identifier: trustee!.nym, protocolVersion: 2, operation: { type: '1', dest: nym, role: null } },
  })
  request.setSignature({ signature: trustee!.sign(Buffer.from(request.signatureInput, 'utf8')) })
  const response = await pool.submitRequest(request)
  if ((response as { op?: string }).op !== 'REPLY') throw new Error(`NYM role reset refused: ${JSON.stringify(response).slice(0, 300)}`)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const now = await readNym(nym)
    if (now && now.role !== ENDORSER_ROLE) {
      console.log(JSON.stringify({ result: 'demoted', did, role: now.role }, null, 2))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`${did} still has role ENDORSER after 60 s`)
}

/** The write probe's own DID: role-less, so its key can only write attributes about itself. */
async function registerProbe(): Promise<{ nym: string; result: 'created' | 'existing' } | undefined> {
  if (!trustee) return undefined
  // Unset, or an empty secret file (deploy.sh mounts one for a key the sops file lacks, as on staging):
  // there is no probe DID to register. Found by the W4 endorser rotation on staging.
  let seed: string
  try {
    seed = env('LEDGER_PROBE_SEED')
  } catch {
    return undefined
  }
  const probe = signerFromSeed(seed)
  const existing = await readNym(probe.nym)
  if (existing) {
    if (existing.verkey !== probe.verkey) throw new Error(`probe NYM ${probe.nym} exists with another verkey`)
    return { nym: probe.nym, result: 'existing' }
  }
  await writeNymAsTrustee({ dest: probe.nym, verkey: probe.verkey, alias: '12id-write-probe' })
  await waitForNym(probe.nym)
  return { nym: probe.nym, result: 'created' }
}

let exitCode = 0
try {
  await run()
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await agent.shutdown().catch(() => undefined)
}
process.exit(exitCode)
