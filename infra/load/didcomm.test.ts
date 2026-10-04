/**
 * The load driver's envelopes must be the ones Credo (and so the mediator) reads and writes.
 *   node --test load/didcomm.test.ts
 */
import '../smoke/bindings.ts'
import 'reflect-metadata'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { AskarModule } from '@credo-ts/askar'
import { Agent, Kms, TypedArrayEncoder } from '@credo-ts/core'
import { DidCommEnvelopeService, DidCommModule } from '@credo-ts/didcomm'
import { agentDependencies } from '@credo-ts/node'
import { askar } from '@openwallet-foundation/askar-nodejs'

import { base58Decode, base58Encode, batchPickup, didKeyToVerkey, forwardFor, generateKeyPair, keyPairFromSecret, pack, unpack } from './didcomm.ts'

test('base58 round-trips, including leading zero bytes', () => {
  for (const bytes of [new Uint8Array([0, 0, 1, 2, 255]), randomBytes(32), new Uint8Array([])]) {
    assert.deepEqual(base58Decode(base58Encode(bytes)), new Uint8Array(bytes))
  }
  assert.equal(base58Encode(new Uint8Array([0, 0, 0x28, 0x7f, 0xb4, 0xcd])), '11233QC4')
})

test('did:key Ed25519 → verkey', () => {
  const key = generateKeyPair()
  const multicodec = new Uint8Array([0xed, 0x01, ...base58Decode(key.verkey)])
  assert.equal(didKeyToVerkey(`did:key:z${base58Encode(multicodec)}`), key.verkey)
  assert.equal(didKeyToVerkey(key.verkey), key.verkey)
})

test('authcrypt and anoncrypt round-trip', () => {
  const alice = generateKeyPair()
  const bob = generateKeyPair()
  const message = batchPickup(10)
  const auth = unpack(pack(message, [bob.verkey], alice), keyPairFromSecret(bob.secret))
  assert.deepEqual(auth.message, message)
  assert.equal(auth.senderVerkey, alice.verkey)
  const anon = unpack(pack(message, [bob.verkey]), bob)
  assert.deepEqual(anon.message, message)
  assert.equal(anon.senderVerkey, undefined)
  assert.throws(() => unpack(pack(message, [bob.verkey]), alice), /not addressed/)
})

test('a forward wraps the anoncrypted ping for the routing key', () => {
  const recipient = generateKeyPair()
  const mediator = generateKeyPair()
  const forward = unpack(forwardFor(recipient.verkey, [mediator.verkey], 'msg-1'), mediator).message
  assert.equal(forward['@type'], 'https://didcomm.org/routing/1.0/forward')
  assert.equal(forward.to, recipient.verkey)
  const ping = unpack(forward.msg as never, recipient).message
  assert.equal(ping['@id'], 'msg-1')
})

test('Credo unpacks our authcrypt, and we unpack Credo’s', async () => {
  const agent = new Agent({
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({ askar, store: { id: `didcomm-test-${Date.now()}`, key: randomBytes(32).toString('base64url'), database: { type: 'sqlite', config: { inMemory: true } } } }),
      didcomm: new DidCommModule({ endpoints: [], transports: { outbound: [], inbound: [] } }),
    },
  })
  await agent.initialize()
  try {
    const kms = agent.dependencyManager.resolve(Kms.KeyManagementApi)
    // Credo finds a recipient key without a DID record by its legacy key id, so import one under it.
    const credoPair = generateKeyPair()
    const credoKey = Kms.PublicJwk.fromPublicKey({ kty: 'OKP', crv: 'Ed25519', publicKey: base58Decode(credoPair.verkey) })
    const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
    await kms.importKey({ privateJwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(credoPair.ed.publicBytes), d: b64u(credoPair.ed.secretBytes), kid: credoKey.legacyKeyId } })
    credoKey.keyId = credoKey.legacyKeyId
    const credoVerkey = credoPair.verkey
    const ours = generateKeyPair()
    // The v1 encrypt/decrypt methods are private in Credo's types; they are the exact code the mediator runs.
    const envelopes = agent.dependencyManager.resolve(DidCommEnvelopeService) as unknown as {
      decryptDidcommV1Message(context: unknown, jwe: unknown): Promise<{ plaintextMessage: unknown; senderKey?: { publicKey: unknown } }>
      encryptDidcommV1Message(context: unknown, message: object, recipients: unknown[], sender?: unknown): Promise<import('./didcomm.ts').Jwe>
    }

    // Ours → Credo (the mediator's direction of reading).
    const decrypted = await envelopes.decryptDidcommV1Message(agent.context, pack(batchPickup(10), [credoVerkey], ours) as never)
    assert.equal((decrypted.plaintextMessage as { batch_size: number }).batch_size, 10)
    assert.equal(TypedArrayEncoder.toBase58((decrypted.senderKey?.publicKey as { publicKey: Uint8Array }).publicKey), ours.verkey)

    // Credo → ours (the mediator's replies).
    const oursAsJwk = Kms.PublicJwk.fromPublicKey({ kty: 'OKP', crv: 'Ed25519', publicKey: base58Decode(ours.verkey) })
    const encrypted = await envelopes.encryptDidcommV1Message(agent.context, { '@type': 'https://didcomm.org/messagepickup/1.0/batch', '@id': 'x' }, [oursAsJwk as never], credoKey as never)
    const reply = unpack(encrypted, ours)
    assert.equal(reply.message['@id'], 'x')
    assert.equal(reply.senderVerkey, credoVerkey)
  } finally {
    await agent.shutdown()
  }
})
