/**
 * DIDComm v1 envelopes (Aries RFC 0019) packed with Askar primitives only: no Credo agent, so one
 * process can drive thousands of simulated wallets. The format matches Credo's
 * `DidCommEnvelopeService` (`@credo-ts/didcomm`), which the mediator unpacks:
 *   - a random ChaCha20-Poly1305 (IETF, 12-byte nonce) content key encrypts the message, with the
 *     protected header as AAD. The header still says `xchacha20poly1305_ietf`: that is what Credo, ACA-Py
 *     and the Kotlin framework all write and read;
 *   - Authcrypt: per recipient, the content key in a crypto_box from sender to recipient (X25519 of the
 *     Ed25519 keys) and the sender's base58 verkey in a sealed box;
 *   - Anoncrypt: the content key in a sealed box, no sender.
 */
import { randomUUID } from 'node:crypto'

import { CryptoBox, Key, KeyAlgorithm } from '@openwallet-foundation/askar-nodejs'

export interface Jwe {
  protected: string
  iv: string
  ciphertext: string
  tag: string
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, i]))

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let out = ''
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out
    value /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    out = `1${out}`
  }
  return out
}

export function base58Decode(text: string): Uint8Array {
  let value = 0n
  for (const char of text) {
    const digit = ALPHABET_MAP.get(char)
    if (digit === undefined) throw new Error(`invalid base58 character '${char}'`)
    value = value * 58n + BigInt(digit)
  }
  const bytes: number[] = []
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn))
    value >>= 8n
  }
  for (const char of text) {
    if (char !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

/** `did:key:z6Mk…` (Ed25519, multicodec 0xed01) → base58 verkey. A bare verkey passes through. */
export function didKeyToVerkey(value: string): string {
  if (!value.startsWith('did:key:')) return value
  const multibase = value.slice('did:key:'.length).split('#')[0]
  if (!multibase.startsWith('z')) throw new Error(`unsupported multibase in ${value}`)
  const bytes = base58Decode(multibase.slice(1))
  if (bytes[0] !== 0xed || bytes[1] !== 0x01 || bytes.length !== 34) throw new Error(`not an Ed25519 did:key: ${value}`)
  return base58Encode(bytes.slice(2))
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const fromB64u = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'))
const utf8 = (text: string) => new TextEncoder().encode(text)

/** An Ed25519 key pair, its X25519 conversion cached (every pack and unpack needs it). */
export interface KeyPair {
  verkey: string
  ed: Key
  x: Key
}

export function keyPairFromSecret(secretBase58: string): KeyPair {
  const ed = Key.fromSecretBytes({ algorithm: KeyAlgorithm.Ed25519, secretKey: base58Decode(secretBase58) })
  return { verkey: base58Encode(ed.publicBytes), ed, x: ed.convertkey({ algorithm: KeyAlgorithm.X25519 }) }
}

export function generateKeyPair(): KeyPair & { secret: string } {
  const ed = Key.generate(KeyAlgorithm.Ed25519)
  return { verkey: base58Encode(ed.publicBytes), secret: base58Encode(ed.secretBytes), ed, x: ed.convertkey({ algorithm: KeyAlgorithm.X25519 }) }
}

const publicX25519Cache = new Map<string, Key>()
function publicX25519(verkey: string): Key {
  let key = publicX25519Cache.get(verkey)
  if (!key) {
    key = Key.fromPublicBytes({ algorithm: KeyAlgorithm.Ed25519, publicKey: base58Decode(verkey) }).convertkey({ algorithm: KeyAlgorithm.X25519 })
    publicX25519Cache.set(verkey, key)
  }
  return key
}

/** Packs `message` for `recipientVerkeys`; authcrypt when `sender` is given, anoncrypt otherwise. */
export function pack(message: object, recipientVerkeys: string[], sender?: KeyPair): Jwe {
  const cek = Key.generate(KeyAlgorithm.Chacha20C20P)
  const cekBytes = cek.secretBytes
  const recipients = recipientVerkeys.map((verkey) => {
    const recipientX = publicX25519(verkey)
    if (!sender) {
      return { encrypted_key: b64u(CryptoBox.seal({ recipientKey: recipientX, message: cekBytes })), header: { kid: verkey } }
    }
    const nonce = CryptoBox.randomNonce()
    const encryptedKey = CryptoBox.cryptoBox({ recipientKey: recipientX, senderKey: sender.x, message: cekBytes, nonce })
    const encryptedSender = CryptoBox.seal({ recipientKey: recipientX, message: utf8(sender.verkey) })
    return { encrypted_key: b64u(encryptedKey), header: { kid: verkey, iv: b64u(nonce), sender: b64u(encryptedSender) } }
  })
  const protectedString = b64u(utf8(JSON.stringify({ enc: 'xchacha20poly1305_ietf', typ: 'JWM/1.0', alg: sender ? 'Authcrypt' : 'Anoncrypt', recipients })))
  const encrypted = cek.aeadEncrypt({ message: utf8(JSON.stringify(message)), aad: utf8(protectedString) })
  return { protected: protectedString, iv: b64u(encrypted.nonce), ciphertext: b64u(encrypted.ciphertext), tag: b64u(encrypted.tag) }
}

/** Unpacks a JWE addressed to `recipient`. Returns the plaintext message and the sender's verkey (authcrypt). */
export function unpack(jwe: Jwe, recipient: KeyPair): { message: Record<string, unknown>; senderVerkey?: string } {
  const header = JSON.parse(Buffer.from(jwe.protected, 'base64url').toString('utf8')) as {
    alg: string
    recipients: Array<{ encrypted_key: string; header: { kid: string; iv?: string; sender?: string } }>
  }
  const entry = header.recipients.find((r) => r.header.kid === recipient.verkey)
  if (!entry) throw new Error('message is not addressed to this key')
  let cekBytes: Uint8Array
  let senderVerkey: string | undefined
  if (header.alg === 'Authcrypt') {
    if (!entry.header.sender || !entry.header.iv) throw new Error('authcrypt recipient without sender or iv')
    senderVerkey = new TextDecoder().decode(CryptoBox.sealOpen({ recipientKey: recipient.x, ciphertext: fromB64u(entry.header.sender) }))
    cekBytes = CryptoBox.open({ recipientKey: recipient.x, senderKey: publicX25519(senderVerkey), message: fromB64u(entry.encrypted_key), nonce: fromB64u(entry.header.iv) })
  } else if (header.alg === 'Anoncrypt') {
    cekBytes = CryptoBox.sealOpen({ recipientKey: recipient.x, ciphertext: fromB64u(entry.encrypted_key) })
  } else throw new Error(`unsupported alg ${header.alg}`)
  const cek = Key.fromSecretBytes({ algorithm: KeyAlgorithm.Chacha20C20P, secretKey: cekBytes })
  const plaintext = cek.aeadDecrypt({ ciphertext: fromB64u(jwe.ciphertext), nonce: fromB64u(jwe.iv), tag: fromB64u(jwe.tag), aad: utf8(jwe.protected) })
  return { message: JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>, senderVerkey }
}

/** RFC 0212 batch pickup with a return route: the reply comes back on the same socket or HTTP response. */
export const batchPickup = (batchSize: number) => ({
  '@type': 'https://didcomm.org/messagepickup/1.0/batch-pickup',
  '@id': randomUUID(),
  batch_size: batchSize,
  '~transport': { return_route: 'all' },
})

/**
 * A forward (RFC 0094) to the mediator for `recipientVerkey`, carrying an opaque message anoncrypted to it.
 * The inner message is a trust ping whose `@id` the poll driver matches to measure delivery.
 */
export function forwardFor(recipientVerkey: string, mediatorRoutingVerkeys: string[], id: string): Jwe {
  const inner = pack({ '@type': 'https://didcomm.org/trust_ping/1.0/ping', '@id': id, response_requested: false, '~timing': { out_time: new Date().toISOString() } }, [recipientVerkey])
  let message: Jwe = inner
  let to = recipientVerkey
  // Innermost routing key first, as Credo's packMessage does.
  for (const routingKey of mediatorRoutingVerkeys) {
    message = pack({ '@type': 'https://didcomm.org/routing/1.0/forward', '@id': randomUUID(), to, msg: message }, [routingKey])
    to = routingKey
  }
  return message
}
