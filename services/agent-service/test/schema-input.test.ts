import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { schemaInput } from '../src/ledger/schema-input.ts'

describe('schemaInput', () => {
  it('accepts a schema with expiresOn', () => {
    const parsed = schemaInput.parse({ name: 'employee-badge', version: '1.0', attributes: ['name', 'employeeNumber', 'expiresOn'] })
    assert.equal(parsed.attributes.length, 3)
  })

  it('refuses a schema without expiresOn, explaining that it cannot be added later', () => {
    const result = schemaInput.safeParse({ name: 'badge', version: '1.0', attributes: ['name', 'employeeNumber'] })
    assert.equal(result.success, false)
    assert.match(JSON.stringify(result.error?.issues), /cannot be added later/)
  })

  it('refuses names that would break unqualified ids', () => {
    for (const name of ['badge:v1', '', '-badge', 'a'.repeat(101)]) {
      assert.equal(schemaInput.safeParse({ name, version: '1.0', attributes: ['a', 'expiresOn'] }).success, false, name)
    }
  })

  it('refuses non-numeric versions and duplicate or invalid attributes', () => {
    assert.equal(schemaInput.safeParse({ name: 'b', version: 'v1', attributes: ['a', 'expiresOn'] }).success, false)
    assert.equal(schemaInput.safeParse({ name: 'b', version: '1.0.0.1', attributes: ['a', 'expiresOn'] }).success, false)
    assert.equal(schemaInput.safeParse({ name: 'b', version: '1.0', attributes: ['a', 'a', 'expiresOn'] }).success, false)
    assert.equal(schemaInput.safeParse({ name: 'b', version: '1.0', attributes: ['first name', 'expiresOn'] }).success, false)
  })
})
