import '../src/bindings.ts'

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  WireIdentifierError,
  assertWireCredentialDefinitionId,
  assertWireSchemaId,
  credentialDefinitionIds,
  schemaIds,
} from '../src/ids.ts'

// Real identifiers from the T2 run against the staging ledger (implement/8-phase-2-findings.md).
const QUALIFIED_SCHEMA = 'did:indy:twelveid:staging:EAHqZgP3xBtmKuCMe57eWu/anoncreds/v0/SCHEMA/p2t21789293028224-badge/1.0'
const UNQUALIFIED_SCHEMA = 'EAHqZgP3xBtmKuCMe57eWu:2:p2t21789293028224-badge:1.0'
const QUALIFIED_CRED_DEF = 'did:indy:twelveid:staging:EAHqZgP3xBtmKuCMe57eWu/anoncreds/v0/CLAIM_DEF/35/default'
const UNQUALIFIED_CRED_DEF = 'EAHqZgP3xBtmKuCMe57eWu:3:CL:35:default'

describe('identifier derivation', () => {
  it('derives the unqualified schema id from the registry form', () => {
    assert.deepEqual(schemaIds(QUALIFIED_SCHEMA), { qualified: QUALIFIED_SCHEMA, unqualified: UNQUALIFIED_SCHEMA })
  })

  it('derives the unqualified cred def id from the registry form', () => {
    assert.deepEqual(credentialDefinitionIds(QUALIFIED_CRED_DEF), {
      qualified: QUALIFIED_CRED_DEF,
      unqualified: UNQUALIFIED_CRED_DEF,
    })
  })

  it('refuses to derive from an id that is already unqualified', () => {
    assert.throws(() => schemaIds(UNQUALIFIED_SCHEMA), WireIdentifierError)
    assert.throws(() => credentialDefinitionIds(UNQUALIFIED_CRED_DEF), WireIdentifierError)
  })
})

describe('wire guards', () => {
  it('accepts unqualified ids unchanged', () => {
    assert.equal(assertWireCredentialDefinitionId(UNQUALIFIED_CRED_DEF), UNQUALIFIED_CRED_DEF)
    assert.equal(assertWireSchemaId(UNQUALIFIED_SCHEMA), UNQUALIFIED_SCHEMA)
  })

  it('rejects qualified ids with a hint', () => {
    assert.throws(() => assertWireCredentialDefinitionId(QUALIFIED_CRED_DEF), /qualified did:indy form is rejected/)
    assert.throws(() => assertWireSchemaId(QUALIFIED_SCHEMA), /qualified did:indy form is rejected/)
  })

  it('rejects malformed ids', () => {
    for (const bad of ['', 'default', 'EAHqZgP3xBtmKuCMe57eWu:3:CL:0:default', 'short:3:CL:35:default']) {
      assert.throws(() => assertWireCredentialDefinitionId(bad), WireIdentifierError, bad)
    }
  })
})
