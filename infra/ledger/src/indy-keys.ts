/**
 * Ed25519 signing for ledger governance and the write probe (Phase 9 W2), from a 32-byte seed held in
 * memory only. Keeps trustee keys out of every wallet: the endorser's Askar store never sees them.
 *
 * Seeds are 64 hex characters, the format the genesis ceremony puts in custody (ceremony.py).
 */
import { createPrivateKey, createPublicKey, sign as ed25519Sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

export function base58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`)
  let out = ''
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out
    value /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    out = `1${out}`
  }
  return out
}

export interface IndySigner {
  /** Legacy Indy DID (the NYM): base58 of the first 16 bytes of the verkey. */
  nym: string
  /** Full base58 verkey. */
  verkey: string
  sign(data: Uint8Array): Uint8Array
}

export function signerFromSeed(seedHex: string): IndySigner {
  const trimmed = seedHex.trim()
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) throw new Error('a seed must be 64 hex characters (32 bytes)')
  const privateKey: KeyObject = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(trimmed, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  return {
    nym: base58(publicKey.subarray(0, 16)),
    verkey: base58(publicKey),
    sign: (data) => new Uint8Array(ed25519Sign(null, data, privateKey)),
  }
}

/** Reads the first line of stdin: how an operator hands a trustee seed to a one-off container. */
export async function readSeedFromStdin(): Promise<string> {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.includes('\n')) break
  }
  const seed = input.split('\n')[0].trim()
  if (!seed) throw new Error('no seed on stdin')
  return seed
}

/**
 * Environment lookup that also accepts NAME_FILE (a secret mounted under /run/secrets, Phase 9 M11);
 * an empty file counts as unset.
 */
export function env(name: string, fallback?: string): string {
  const file = process.env[`${name}_FILE`]
  const value = file ? readFileSync(file, 'utf8').replace(/\r?\n$/, '') : process.env[name]
  const result = value || fallback
  if (!result) throw new Error(`missing required environment variable ${name} (or ${name}_FILE)`)
  return result
}
