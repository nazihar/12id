/**
 * Envelope encryption (16-phase-6-biometric.md B1). The master key (SOPS) wraps one random data
 * key per tenant; data keys encrypt vendor configuration and reference images. AES-256-GCM
 * everywhere, with associated data that binds each ciphertext to its tenant and row, so a
 * ciphertext copied to another row or tenant fails to decrypt.
 *
 * Format: version (1 byte) | iv (12) | tag (16) | ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 1

export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])
}

export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes')
  if (sealed.length < 29 || sealed[0] !== VERSION) throw new Error('unsupported ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 13))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(sealed.subarray(13, 29))
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()])
}

export const aad = {
  dataKey: (tenantId: string) => `biometric:data-key:${tenantId}`,
  providerConfig: (tenantId: string) => `biometric:provider-config:${tenantId}`,
  referenceImage: (tenantId: string, checkId: string) => `biometric:reference:${tenantId}:${checkId}`,
}

/** Holds the master key and unwraps tenant data keys on demand. */
export class KeyRing {
  readonly #master: Buffer

  constructor(masterKeyBase64: string) {
    const master = Buffer.from(masterKeyBase64, 'base64')
    if (master.length !== 32) throw new Error('master key must be 32 bytes')
    this.#master = master
  }

  newWrappedDataKey(tenantId: string): { dataKey: Buffer; wrapped: Buffer } {
    const dataKey = randomBytes(32)
    return { dataKey, wrapped: seal(this.#master, dataKey, aad.dataKey(tenantId)) }
  }

  unwrap(tenantId: string, wrapped: Buffer): Buffer {
    return open(this.#master, wrapped, aad.dataKey(tenantId))
  }
}
